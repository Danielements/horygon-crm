#!/usr/bin/env node
'use strict';

// Diagnostica prodotti RTWS.
// Prova il Login su ogni nome-prodotto documentato + su quelli configurati nel .env,
// e per ciascuno che autentica chiama GetScore per mostrare prodotto, crediti e scadenza.
// NON consuma crediti di ricerca: usa solo Login + GetScore (metadati contratto).
//
// Uso (sul server dove vive il .env con le credenziali RTWS):
//   node scripts/rtws-products-check.js

require('../src/config/load-env');

const https = require('https');

// I 7 nomi-prodotto elencati nella documentazione RTWebServices v2.1.2 (pag. 11).
const CANONICAL_PRODUCTS = [
  'RTWS_BDRT',
  'RTWS_LISTINI',
  'RTWS_IDENTIFICAZIONE',
  'RTWS_TARGATELAIO',
  'RTWS_EQUIVALENTI',
  'RTWS_DATI-TECNICI',
  'RTWS_TEMPI-MECH',
];

// Nomi-prodotto attualmente referenziati dal codice tramite variabili d'ambiente.
const ENV_PRODUCT_VARS = [
  'RTWS_PRODUCT_BDRT',
  'RTWS_PRODUCT_LISTINI',
  'RTWS_PRODUCT_IDENTIFICATION',
  'RTWS_PRODUCT_TARGATELAIO',
  'RTWS_PRODUCT_EQUIVALENTI',
];

// Mappa: quale funzionalità del CRM dipende da quale prodotto RTWS.
const FEATURE_MAP = {
  RTWS_BDRT: 'Ricambi da OE (GetRicambiByOE) e da veicolo+dizionario (GetRicambiDBRT)',
  RTWS_LISTINI: 'Cristalli da targa (CheckEurocodeDaTargaOE2) e listini/equivalenti da OE',
  RTWS_IDENTIFICAZIONE: 'Identificazione veicolo da targa (GetRTDaTarga/GetRTEstesoDaTarga)',
  RTWS_TARGATELAIO: 'Identificazione veicolo da targa via fornitori terzi (GetRTDaTargaMin)',
  RTWS_EQUIVALENTI: 'Equivalenti aftermarket e KType (GetPartNumberSostituenti, GetKType)',
  'RTWS_DATI-TECNICI': 'Dati tecnici veicolo',
  'RTWS_TEMPI-MECH': 'Tempi di manodopera',
};

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlDecode(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function getXmlTagValue(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? xmlDecode(match[1]).trim() : '';
}

function getRtwsServiceUrl() {
  const base = String(process.env.RTWS_WSDL_URL || process.env.RTWS_SERVICE_URL || '').trim();
  return base.replace(/\?wsdl$/i, '').replace(/\?WSDL$/i, '');
}

function buildSoap12Envelope(methodName, innerXml) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <${methodName} xmlns="http://tempuri.org/">
      ${innerXml}
    </${methodName}>
  </soap:Body>
</soap:Envelope>`;
}

function callRtwsSoap(methodName, innerXml) {
  return new Promise((resolve) => {
    const serviceUrl = getRtwsServiceUrl();
    if (!serviceUrl) return resolve({ ok: false, error: 'RTWS_WSDL_URL non configurato' });
    let endpoint;
    try {
      endpoint = new URL(serviceUrl);
    } catch {
      return resolve({ ok: false, error: `RTWS_WSDL_URL non valido: ${serviceUrl}` });
    }
    const xml = buildSoap12Envelope(methodName, innerXml);
    const req = https.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || 443,
        path: endpoint.pathname,
        method: 'POST',
        timeout: Number(process.env.RTWS_TIMEOUT_MS || 12000),
        headers: {
          'Content-Type': `application/soap+xml; charset=utf-8; action="http://tempuri.org/${methodName}"`,
          'Content-Length': Buffer.byteLength(xml),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          const code = res.statusCode || 0;
          if (code >= 200 && code < 300) {
            resolve({ ok: true, rawXml: raw, statusCode: code });
          } else {
            resolve({
              ok: false,
              rawXml: raw,
              statusCode: code,
              error: getXmlTagValue(raw, 'faultstring') || `RTWS HTTP ${code}`,
            });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ ok: false, error: error.message }));
    req.write(xml);
    req.end();
  });
}

async function loginProduct(productName) {
  const loginXml = `
    <aziendaName>${xmlEscape(process.env.RTWS_AZIENDA_NAME || '')}</aziendaName>
    <clientName>${xmlEscape(process.env.RTWS_CLIENT_NAME || '')}</clientName>
    <password>${xmlEscape(process.env.RTWS_PASSWORD || '')}</password>
    <productName>${xmlEscape(productName)}</productName>
  `;
  const result = await callRtwsSoap('Login', loginXml);
  if (!result.ok) return { ok: false, error: result.error, rawXml: result.rawXml };
  const loginState = getXmlTagValue(result.rawXml, 'LoginState');
  const sessionId = getXmlTagValue(result.rawXml, 'SessionId');
  const errorMsg = getXmlTagValue(result.rawXml, 'ErrorMsg');
  if (loginState !== 'SUCCESS' || !sessionId) {
    return { ok: false, error: errorMsg || `LoginState=${loginState || 'UNKNOWN'}`, rawXml: result.rawXml };
  }
  return { ok: true, sessionId };
}

async function getScore(sessionId) {
  const result = await callRtwsSoap('GetScore', `<sessionId>${xmlEscape(sessionId)}</sessionId>`);
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    product: getXmlTagValue(result.rawXml, 'Product'),
    company: getXmlTagValue(result.rawXml, 'Company'),
    client: getXmlTagValue(result.rawXml, 'Client'),
    activation: getXmlTagValue(result.rawXml, 'ActivationDate'),
    expiration: getXmlTagValue(result.rawXml, 'ExpirationDate'),
    credits: getXmlTagValue(result.rawXml, 'Credits'),
  };
}

function creditsLabel(credits) {
  if (credits === '-1') return 'illimitati';
  if (credits === '' || credits === null || credits === undefined) return 'n/d';
  return credits;
}

async function probeProduct(productName) {
  const login = await loginProduct(productName);
  if (!login.ok) {
    return { productName, active: false, error: login.error };
  }
  const score = await getScore(login.sessionId);
  return {
    productName,
    active: true,
    contractProduct: score.ok ? score.product : '',
    company: score.ok ? score.company : '',
    activation: score.ok ? score.activation : '',
    expiration: score.ok ? score.expiration : '',
    credits: score.ok ? score.credits : '',
    scoreError: score.ok ? '' : score.error,
  };
}

async function main() {
  console.log('=== Diagnostica prodotti RTWS ===\n');

  const serviceUrl = getRtwsServiceUrl();
  if (!serviceUrl) {
    console.error('RTWS_WSDL_URL non configurato. Impossibile procedere.');
    process.exit(1);
  }
  console.log(`Endpoint : ${serviceUrl}`);
  console.log(`Azienda  : ${process.env.RTWS_AZIENDA_NAME || '(vuoto)'}`);
  console.log(`Cliente  : ${process.env.RTWS_CLIENT_NAME || '(vuoto)'}`);
  console.log(`Password : ${process.env.RTWS_PASSWORD ? '(impostata)' : '(VUOTA!)'}`);
  console.log('');

  // Raccoglie i valori attualmente configurati nell'ambiente.
  console.log('--- Valori RTWS_PRODUCT_* attualmente nel .env ---');
  const envValues = new Map(); // valore -> [nomi variabili]
  for (const varName of ENV_PRODUCT_VARS) {
    const value = String(process.env[varName] || '').trim();
    console.log(`  ${varName.padEnd(28)} = ${value || '(vuoto)'}`);
    if (value) {
      if (!envValues.has(value)) envValues.set(value, []);
      envValues.get(value).push(varName);
    }
  }
  console.log('');

  // Costruisce l'elenco unico di nomi-prodotto da testare: canonici + quelli nel .env.
  const toTest = new Map(); // productName -> origine
  for (const p of CANONICAL_PRODUCTS) toTest.set(p, 'documentato');
  for (const value of envValues.keys()) {
    if (toTest.has(value)) continue;
    toTest.set(value, `.env (${envValues.get(value).join(', ')})`);
  }

  console.log('--- Test Login + GetScore su ogni nome-prodotto ---\n');
  const results = [];
  for (const [productName, origin] of toTest) {
    process.stdout.write(`Provo "${productName}" [${origin}] ... `);
    const r = await probeProduct(productName);
    r.origin = origin;
    results.push(r);
    if (r.active) {
      const exp = r.expiration ? `scad. ${r.expiration}` : 'scad. n/d';
      console.log(`ATTIVO  (crediti: ${creditsLabel(r.credits)}, ${exp})`);
    } else {
      console.log(`NON attivo  (${r.error})`);
    }
  }

  console.log('\n=== RIEPILOGO ===\n');
  const active = results.filter((r) => r.active);
  const inactive = results.filter((r) => !r.active);

  console.log(`Prodotti ATTIVI (${active.length}):`);
  for (const r of active) {
    const feature = FEATURE_MAP[r.productName] || FEATURE_MAP[r.contractProduct] || '';
    console.log(`  ✓ ${r.productName}`);
    if (r.contractProduct && r.contractProduct !== r.productName) {
      console.log(`      contratto riporta: ${r.contractProduct}`);
    }
    console.log(`      crediti: ${creditsLabel(r.credits)}   attivazione: ${r.activation || 'n/d'}   scadenza: ${r.expiration || 'n/d'}`);
    if (feature) console.log(`      abilita: ${feature}`);
  }

  if (inactive.length) {
    console.log(`\nProdotti NON attivi (${inactive.length}):`);
    for (const r of inactive) {
      console.log(`  ✗ ${r.productName} [${r.origin}]  →  ${r.error}`);
    }
  }

  // Verifica coerenza tra .env e prodotti realmente attivi.
  console.log('\n=== VERIFICA CONFIGURAZIONE .env ===\n');
  const activeNames = new Set(active.map((r) => r.productName));
  let warnings = 0;
  for (const varName of ENV_PRODUCT_VARS) {
    const value = String(process.env[varName] || '').trim();
    if (!value) continue;
    if (activeNames.has(value)) {
      console.log(`  ✓ ${varName} = "${value}"  → prodotto attivo`);
    } else {
      warnings++;
      const canonicalHint = CANONICAL_PRODUCTS.filter((p) => activeNames.has(p)).join(', ');
      console.log(`  ✗ ${varName} = "${value}"  → NON autentica.`);
      if (canonicalHint) console.log(`      Nomi-prodotto attivi disponibili: ${canonicalHint}`);
    }
  }
  if (!warnings) console.log('  Nessun problema rilevato nelle variabili RTWS_PRODUCT_* valorizzate.');

  console.log('\nFine diagnostica.');
}

main().catch((error) => {
  console.error('Errore inatteso:', error.message);
  process.exit(1);
});
