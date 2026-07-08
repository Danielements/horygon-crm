#!/usr/bin/env node
'use strict';

// Diagnostica prodotti RTWS.
// Prova il Login su ogni nome-prodotto documentato + su quelli configurati nel .env,
// e per ciascuno che autentica chiama GetScore per mostrare prodotto, crediti e scadenza.
// NON consuma crediti di ricerca: usa solo Login + GetScore (metadati contratto).
//
// Autosufficiente: nessuna dipendenza esterna, compatibile con Node.js 12+.
// Legge direttamente il file .env del progetto.
//
// Uso (sul server dove vive il .env con le credenziali RTWS):
//   node scripts/rtws-products-check.js

const https = require('https');
const fs = require('fs');
const path = require('path');

// --- Caricamento .env senza dipendenze (le var reali di process.env hanno priorita') ---
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  content.split(/\r?\n/).forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === '#') return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    const first = val.charAt(0);
    const last = val.charAt(val.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  });
}

(function loadProjectEnv() {
  const projectRoot = path.resolve(__dirname, '..');
  loadEnvFile(path.join(projectRoot, '.env'));
  const nodeEnv = process.env.NODE_ENV || 'production';
  loadEnvFile(path.join(projectRoot, '.env.' + nodeEnv));
  if (nodeEnv !== 'production') loadEnvFile(path.join(projectRoot, '.env.local'));
})();

// I 7 nomi-prodotto elencati nella documentazione RTWebServices v2.1.2 (pag. 11)
// piu' le grafie usate nella "Guida Integrazione" (Rev. 2.0), che scrive
// RTWS_TARGA_TELAIO con underscore. Testiamo tutte le varianti plausibili:
// il server accetta solo il nome esatto previsto dal contratto.
const CANONICAL_PRODUCTS = [
  'RTWS_BDRT',
  'RTWS_LISTINI',
  'RTWS_IDENTIFICAZIONE',
  'RTWS_TARGATELAIO',
  'RTWS_TARGA_TELAIO',
  'RTWS_TARGA-TELAIO',
  'RTWS_TARGATELAIO_TELAIO',
  'RTWS_EQUIVALENTI',
  'RTWS_DATI-TECNICI',
  'RTWS_DATI_TECNICI',
  'RTWS_TEMPI-MECH',
  'RTWS_TEMPI_MECH',
];

// Nomi-prodotto attualmente referenziati dal codice tramite variabili d'ambiente.
const ENV_PRODUCT_VARS = [
  'RTWS_PRODUCT_BDRT',
  'RTWS_PRODUCT_LISTINI',
  'RTWS_PRODUCT_IDENTIFICATION',
  'RTWS_PRODUCT_TARGATELAIO',
  'RTWS_PRODUCT_EQUIVALENTI',
];

// Mappa: quale funzionalita' del CRM dipende da quale prodotto RTWS.
const FEATURE_MAP = {
  RTWS_BDRT: 'Ricambi da OE (GetRicambiByOE) e da veicolo+dizionario (GetRicambiDBRT)',
  RTWS_LISTINI: 'Cristalli da targa (CheckEurocodeDaTargaOE2) e listini/equivalenti da OE',
  RTWS_IDENTIFICAZIONE: 'Identificazione veicolo da targa (GetRTDaTarga/GetRTEstesoDaTarga)',
  RTWS_TARGATELAIO: 'Identificazione veicolo da targa via fornitori terzi (GetRTDaTargaMin)',
  RTWS_TARGA_TELAIO: 'Identificazione veicolo da targa (GetRTDaTarga) — grafia della Guida Rev. 2.0',
  RTWS_EQUIVALENTI: 'Equivalenti aftermarket e KType (GetPartNumberSostituenti, GetKType)',
  'RTWS_DATI-TECNICI': 'Dati tecnici veicolo',
  'RTWS_TEMPI-MECH': 'Tempi di manodopera',
};

function str(value) {
  return value === undefined || value === null ? '' : String(value);
}

function xmlEscape(value) {
  return str(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlDecode(value) {
  return str(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function getXmlTagValue(xml, tag) {
  const match = str(xml).match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return match ? xmlDecode(match[1]).trim() : '';
}

function getRtwsServiceUrl() {
  const base = str(process.env.RTWS_WSDL_URL || process.env.RTWS_SERVICE_URL || '').trim();
  return base.replace(/\?wsdl$/i, '').replace(/\?WSDL$/i, '');
}

function buildSoap12Envelope(methodName, innerXml) {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n' +
    '  xmlns:xsd="http://www.w3.org/2001/XMLSchema"\n' +
    '  xmlns:soap="http://www.w3.org/2003/05/soap-envelope">\n' +
    '  <soap:Body>\n' +
    '    <' + methodName + ' xmlns="http://tempuri.org/">\n' +
    '      ' + innerXml + '\n' +
    '    </' + methodName + '>\n' +
    '  </soap:Body>\n' +
    '</soap:Envelope>';
}

function callRtwsSoap(methodName, innerXml) {
  return new Promise(function (resolve) {
    const serviceUrl = getRtwsServiceUrl();
    if (!serviceUrl) return resolve({ ok: false, error: 'RTWS_WSDL_URL non configurato' });
    let endpoint;
    try {
      endpoint = new URL(serviceUrl);
    } catch (e) {
      return resolve({ ok: false, error: 'RTWS_WSDL_URL non valido: ' + serviceUrl });
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
          'Content-Type': 'application/soap+xml; charset=utf-8; action="http://tempuri.org/' + methodName + '"',
          'Content-Length': Buffer.byteLength(xml),
        },
      },
      function (res) {
        let raw = '';
        res.on('data', function (chunk) {
          raw += chunk;
        });
        res.on('end', function () {
          const code = res.statusCode || 0;
          if (code >= 200 && code < 300) {
            resolve({ ok: true, rawXml: raw, statusCode: code });
          } else {
            resolve({
              ok: false,
              rawXml: raw,
              statusCode: code,
              error: getXmlTagValue(raw, 'faultstring') || ('RTWS HTTP ' + code),
            });
          }
        });
      }
    );
    req.on('timeout', function () {
      req.destroy(new Error('timeout'));
    });
    req.on('error', function (error) {
      resolve({ ok: false, error: error.message });
    });
    req.write(xml);
    req.end();
  });
}

async function loginProduct(productName) {
  const loginXml =
    '<aziendaName>' + xmlEscape(process.env.RTWS_AZIENDA_NAME || '') + '</aziendaName>' +
    '<clientName>' + xmlEscape(process.env.RTWS_CLIENT_NAME || '') + '</clientName>' +
    '<password>' + xmlEscape(process.env.RTWS_PASSWORD || '') + '</password>' +
    '<productName>' + xmlEscape(productName) + '</productName>';
  const result = await callRtwsSoap('Login', loginXml);
  if (!result.ok) return { ok: false, error: result.error };
  const loginState = getXmlTagValue(result.rawXml, 'LoginState');
  const sessionId = getXmlTagValue(result.rawXml, 'SessionId');
  const errorMsg = getXmlTagValue(result.rawXml, 'ErrorMsg');
  if (loginState !== 'SUCCESS' || !sessionId) {
    return { ok: false, error: errorMsg || ('LoginState=' + (loginState || 'UNKNOWN')) };
  }
  return { ok: true, sessionId: sessionId };
}

async function getScore(sessionId) {
  const result = await callRtwsSoap('GetScore', '<sessionId>' + xmlEscape(sessionId) + '</sessionId>');
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
  if (!credits) return 'n/d';
  return credits;
}

async function probeProduct(productName) {
  const login = await loginProduct(productName);
  if (!login.ok) {
    return { productName: productName, active: false, error: login.error };
  }
  const score = await getScore(login.sessionId);
  return {
    productName: productName,
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
  console.log('Endpoint : ' + serviceUrl);
  console.log('Azienda  : ' + (process.env.RTWS_AZIENDA_NAME || '(vuoto)'));
  console.log('Cliente  : ' + (process.env.RTWS_CLIENT_NAME || '(vuoto)'));
  console.log('Password : ' + (process.env.RTWS_PASSWORD ? '(impostata)' : '(VUOTA!)'));
  console.log('');

  console.log('--- Valori RTWS_PRODUCT_* attualmente nel .env ---');
  const envValues = {}; // valore -> [nomi variabili]
  for (let i = 0; i < ENV_PRODUCT_VARS.length; i++) {
    const varName = ENV_PRODUCT_VARS[i];
    const value = str(process.env[varName] || '').trim();
    console.log('  ' + varName + ' = ' + (value || '(vuoto)'));
    if (value) {
      if (!envValues[value]) envValues[value] = [];
      envValues[value].push(varName);
    }
  }
  console.log('');

  // Elenco unico di nomi-prodotto da testare: canonici + quelli nel .env.
  const toTest = []; // { name, origin }
  const seen = {};
  for (let i = 0; i < CANONICAL_PRODUCTS.length; i++) {
    toTest.push({ name: CANONICAL_PRODUCTS[i], origin: 'documentato' });
    seen[CANONICAL_PRODUCTS[i]] = true;
  }
  Object.keys(envValues).forEach(function (value) {
    if (seen[value]) return;
    toTest.push({ name: value, origin: '.env (' + envValues[value].join(', ') + ')' });
    seen[value] = true;
  });

  console.log('--- Test Login + GetScore su ogni nome-prodotto ---\n');
  const results = [];
  for (let i = 0; i < toTest.length; i++) {
    const item = toTest[i];
    process.stdout.write('Provo "' + item.name + '" [' + item.origin + '] ... ');
    const r = await probeProduct(item.name);
    r.origin = item.origin;
    results.push(r);
    if (r.active) {
      const exp = r.expiration ? ('scad. ' + r.expiration) : 'scad. n/d';
      console.log('ATTIVO  (crediti: ' + creditsLabel(r.credits) + ', ' + exp + ')');
    } else {
      console.log('NON attivo  (' + r.error + ')');
    }
  }

  console.log('\n=== RIEPILOGO ===\n');
  const active = results.filter(function (r) { return r.active; });
  const inactive = results.filter(function (r) { return !r.active; });

  console.log('Prodotti ATTIVI (' + active.length + '):');
  active.forEach(function (r) {
    const feature = FEATURE_MAP[r.productName] || FEATURE_MAP[r.contractProduct] || '';
    console.log('  [OK] ' + r.productName);
    if (r.contractProduct && r.contractProduct !== r.productName) {
      console.log('       contratto riporta: ' + r.contractProduct);
    }
    console.log('       crediti: ' + creditsLabel(r.credits) + '   attivazione: ' + (r.activation || 'n/d') + '   scadenza: ' + (r.expiration || 'n/d'));
    if (feature) console.log('       abilita: ' + feature);
  });

  if (inactive.length) {
    console.log('\nProdotti NON attivi (' + inactive.length + '):');
    inactive.forEach(function (r) {
      console.log('  [--] ' + r.productName + ' [' + r.origin + ']  ->  ' + r.error);
    });
  }

  console.log('\n=== VERIFICA CONFIGURAZIONE .env ===\n');
  const activeNames = {};
  active.forEach(function (r) { activeNames[r.productName] = true; });
  let warnings = 0;
  for (let i = 0; i < ENV_PRODUCT_VARS.length; i++) {
    const varName = ENV_PRODUCT_VARS[i];
    const value = str(process.env[varName] || '').trim();
    if (!value) continue;
    if (activeNames[value]) {
      console.log('  [OK] ' + varName + ' = "' + value + '"  -> prodotto attivo');
    } else {
      warnings++;
      const hints = CANONICAL_PRODUCTS.filter(function (p) { return activeNames[p]; }).join(', ');
      console.log('  [!!] ' + varName + ' = "' + value + '"  -> NON autentica.');
      if (hints) console.log('       Nomi-prodotto attivi disponibili: ' + hints);
    }
  }
  if (!warnings) console.log('  Nessun problema rilevato nelle variabili RTWS_PRODUCT_* valorizzate.');

  console.log('\nFine diagnostica.');
}

main().catch(function (error) {
  console.error('Errore inatteso:', error.message);
  process.exit(1);
});
