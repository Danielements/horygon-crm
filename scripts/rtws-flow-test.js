#!/usr/bin/env node
'use strict';

// Validazione live della catena completa targa -> ricambio -> OE + prezzo.
// Esercita i 3 step con i prodotti ATTIVI e salva l'XML grezzo di ogni chiamata
// in data/rtws-flow/ per ispezione.
//
//   STEP 1  GetRTCompletoDaTargaMin  (RTWS_TARGATELAIO)  targa -> IdMar/IdMod/IdVer
//   STEP 2  GetIdParBDRTCompleto     (RTWS_BDRT)         veicolo -> lista {idpar, descrizione}
//   STEP 3  GetRicambiDBRT           (RTWS_BDRT)         idpar -> OE + prezzo
//
// ATTENZIONE: lo STEP 1 consuma crediti RTWS_TARGATELAIO (50 disponibili).
// Ogni esecuzione = 1 lookup targa. Gli step 2-3 (BDRT) sono illimitati.
//
// Uso (sul server):
//   node scripts/rtws-flow-test.js <TARGA> [testo-ricambio]
// Esempi:
//   node scripts/rtws-flow-test.js EF123GH
//   node scripts/rtws-flow-test.js EF123GH "filtro olio"
//
// Autosufficiente, compatibile con Node.js 12+.

const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------- caricamento .env senza dipendenze ----------
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
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  });
}
(function () {
  const root = path.resolve(__dirname, '..');
  loadEnvFile(path.join(root, '.env'));
  const env = process.env.NODE_ENV || 'production';
  loadEnvFile(path.join(root, '.env.' + env));
  if (env !== 'production') loadEnvFile(path.join(root, '.env.local'));
})();

// ---------- helper XML/SOAP ----------
function str(v) { return v === undefined || v === null ? '' : String(v); }
function xmlEscape(v) {
  return str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function xmlDecode(v) {
  return str(v).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function getTag(xml, tag) {
  const m = str(xml).match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? xmlDecode(m[1]).trim() : '';
}
function getBlock(xml, tag) {
  const m = str(xml).match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? m[1] : '';
}
function collectBlocks(xml, tag) {
  const re = new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'ig');
  const out = [];
  let m;
  while ((m = re.exec(str(xml))) !== null) out.push(m[1]);
  return out;
}
function normalizePlate(v) { return str(v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function serviceUrl() {
  const b = str(process.env.RTWS_WSDL_URL || process.env.RTWS_SERVICE_URL || '').trim();
  return b.replace(/\?wsdl$/i, '').replace(/\?WSDL$/i, '');
}
function envelope(method, inner) {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://www.w3.org/2003/05/soap-envelope">\n' +
    '  <soap:Body>\n    <' + method + ' xmlns="http://tempuri.org/">\n      ' + inner + '\n    </' + method + '>\n  </soap:Body>\n</soap:Envelope>';
}
function callSoap(method, inner) {
  return new Promise(function (resolve) {
    const url = serviceUrl();
    if (!url) return resolve({ ok: false, error: 'RTWS_WSDL_URL non configurato' });
    let ep;
    try { ep = new URL(url); } catch (e) { return resolve({ ok: false, error: 'URL non valido: ' + url }); }
    const xml = envelope(method, inner);
    const req = https.request({
      protocol: ep.protocol, hostname: ep.hostname, port: ep.port || 443, path: ep.pathname, method: 'POST',
      timeout: Number(process.env.RTWS_TIMEOUT_MS || 12000),
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8; action="http://tempuri.org/' + method + '"',
        'Content-Length': Buffer.byteLength(xml)
      }
    }, function (res) {
      let raw = '';
      res.on('data', function (c) { raw += c; });
      res.on('end', function () {
        const code = res.statusCode || 0;
        if (code >= 200 && code < 300) resolve({ ok: true, rawXml: raw });
        else resolve({ ok: false, rawXml: raw, error: getTag(raw, 'faultstring') || ('HTTP ' + code) });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', function (e) { resolve({ ok: false, error: e.message }); });
    req.write(xml); req.end();
  });
}
async function login(productName) {
  const inner =
    '<aziendaName>' + xmlEscape(process.env.RTWS_AZIENDA_NAME || '') + '</aziendaName>' +
    '<clientName>' + xmlEscape(process.env.RTWS_CLIENT_NAME || '') + '</clientName>' +
    '<password>' + xmlEscape(process.env.RTWS_PASSWORD || '') + '</password>' +
    '<productName>' + xmlEscape(productName) + '</productName>';
  const r = await callSoap('Login', inner);
  if (!r.ok) throw new Error('Login ' + productName + ' fallito: ' + r.error);
  const state = getTag(r.rawXml, 'LoginState');
  const sid = getTag(r.rawXml, 'SessionId');
  if (state !== 'SUCCESS' || !sid) throw new Error('Login ' + productName + ' non riuscito: ' + (getTag(r.rawXml, 'ErrorMsg') || state));
  return sid;
}

// ---------- output dir per XML grezzi ----------
const OUT_DIR = path.resolve(__dirname, '..', 'data', 'rtws-flow');
function saveRaw(name, xml) {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (e) {}
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, str(xml));
  return file;
}

// ---------- parsing (con fallback su piu' nomi-tag) ----------
function parseAllestimenti(rawXml) {
  const container = getBlock(rawXml, 'Allestimenti') || rawXml;
  let blocks = collectBlocks(container, 'AllestimentoCompleto');
  if (!blocks.length) blocks = collectBlocks(container, 'AllestimentoEsteso');
  if (!blocks.length) blocks = collectBlocks(container, 'Allestimento');
  return blocks.map(function (b) {
    return {
      id_marca: getTag(b, 'IdMar'), id_modello: getTag(b, 'IdMod'), id_versione: getTag(b, 'IdVer'),
      marca: getTag(b, 'DsMar'), modello: getTag(b, 'DsMod'), versione: getTag(b, 'DsVer'),
      potenza_kw: getTag(b, 'PotenzaKw'), alimentazione: getTag(b, 'Alimentazione'),
      inizio: getTag(b, 'InizioCommercializzazione'), fine: getTag(b, 'FineCommercializzazione')
    };
  }).filter(function (a) { return a.id_marca && a.id_modello && a.id_versione; });
}
function parseParts(rawXml) {
  const container = getBlock(rawXml, 'DBRT_Parts') || rawXml;
  let blocks = collectBlocks(container, 'parts');
  if (!blocks.length) blocks = collectBlocks(container, 'Parts');
  return blocks.map(function (b) {
    return {
      idpar: getTag(b, 'idpar') || getTag(b, 'Idpar') || getTag(b, 'IdPar'),
      simmetria: getTag(b, 'simmetria') || getTag(b, 'Idsim'),
      descrizione: getTag(b, 'descrizione') || getTag(b, 'Descrizione') || getTag(b, 'Dspar')
    };
  }).filter(function (p) { return p.idpar; });
}
function parseVariants(rawXml) {
  const out = [];
  collectBlocks(rawXml, 'DBRT_Part').forEach(function (partBlock) {
    const idpar = getTag(partBlock, 'Idpar') || getTag(partBlock, 'idpar');
    collectBlocks(partBlock, 'VarianteListino').forEach(function (v) {
      out.push({
        idpar: idpar,
        descrizione: getTag(v, 'Dspar'),
        codice: getTag(v, 'Parno'),
        prezzo: getTag(v, 'Przli'),
        colore: getTag(v, 'Color'),
        ulteriore: getTag(v, 'Ultds')
      });
    });
  });
  return out;
}

// ---------- STEP ----------
async function step1(plate) {
  const sid = await login(process.env.RTWS_PRODUCT_TARGATELAIO || 'RTWS_TARGATELAIO');
  const inner = '<sessionId>' + xmlEscape(sid) + '</sessionId><context><Targa>' + xmlEscape(normalizePlate(plate)) + '</Targa></context>';
  const r = await callSoap('GetRTCompletoDaTargaMin', inner);
  saveRaw('step1_GetRTCompletoDaTargaMin.xml', r.rawXml || r.error);
  if (!r.ok) throw new Error('GetRTCompletoDaTargaMin fallito: ' + r.error);
  return parseAllestimenti(r.rawXml);
}
async function step2(bdrtSid, marca, modello, versione) {
  const inner = '<sessionId>' + xmlEscape(bdrtSid) + '</sessionId><context>' +
    '<Marca>' + xmlEscape(marca) + '</Marca><Modello>' + xmlEscape(modello) + '</Modello><Versione>' + xmlEscape(versione) + '</Versione>' +
    '<CodLingua>IT</CodLingua></context>';
  const r = await callSoap('GetIdParBDRTCompleto', inner);
  saveRaw('step2_GetIdParBDRTCompleto.xml', r.rawXml || r.error);
  if (!r.ok) throw new Error('GetIdParBDRTCompleto fallito: ' + r.error);
  return parseParts(r.rawXml);
}
async function step3(bdrtSid, marca, modello, versione, idpar) {
  const inner = '<sessionId>' + xmlEscape(bdrtSid) + '</sessionId><context>' +
    '<Marca>' + xmlEscape(marca) + '</Marca><Modello>' + xmlEscape(modello) + '</Modello><Versione>' + xmlEscape(versione) + '</Versione>' +
    '<CodLingua>IT</CodLingua><Idpars><Idpar>' + xmlEscape(idpar) + '</Idpar></Idpars></context>';
  const r = await callSoap('GetRicambiDBRT', inner);
  saveRaw('step3_GetRicambiDBRT.xml', r.rawXml || r.error);
  if (!r.ok) throw new Error('GetRicambiDBRT fallito: ' + r.error);
  return parseVariants(r.rawXml);
}

async function main() {
  const plate = process.argv[2];
  const term = str(process.argv[3]).toLowerCase().trim();
  if (!plate) {
    console.error('Uso: node scripts/rtws-flow-test.js <TARGA> [testo-ricambio]');
    process.exit(1);
  }
  console.log('=== Test flusso completo RTWS: targa -> ricambio ===\n');
  console.log('Targa: ' + normalizePlate(plate) + (term ? ('   filtro ricambio: "' + term + '"') : ''));
  console.log('ATTENZIONE: lo STEP 1 consuma 1 credito RTWS_TARGATELAIO.\n');

  // STEP 1
  console.log('--- STEP 1: identificazione veicolo (GetRTCompletoDaTargaMin, TARGATELAIO) ---');
  const allest = await step1(plate);
  if (!allest.length) {
    console.log('Nessun allestimento identificato per questa targa. Controlla data/rtws-flow/step1_*.xml');
    process.exit(2);
  }
  console.log('Allestimenti trovati: ' + allest.length);
  allest.slice(0, 5).forEach(function (a, i) {
    console.log('  [' + i + '] ' + a.marca + ' ' + a.modello + ' ' + a.versione +
      '  (IdMar=' + a.id_marca + ' IdMod=' + a.id_modello + ' IdVer=' + a.id_versione + ')' +
      (a.alimentazione ? '  ' + a.alimentazione : '') + (a.potenza_kw ? ' ' + a.potenza_kw + 'kW' : ''));
  });
  const v = allest[0];
  console.log('Uso il primo allestimento: IdMar=' + v.id_marca + ' IdMod=' + v.id_modello + ' IdVer=' + v.id_versione + '\n');

  // Login BDRT (illimitato) riusato per step 2 e 3
  const bdrtSid = await login(process.env.RTWS_PRODUCT_BDRT || 'RTWS_BDRT');

  // STEP 2
  console.log('--- STEP 2: lista componenti (GetIdParBDRTCompleto, BDRT) ---');
  const parts = await step2(bdrtSid, v.id_marca, v.id_modello, v.id_versione);
  console.log('Componenti disponibili per il veicolo: ' + parts.length);
  let matched = parts;
  if (term) {
    matched = parts.filter(function (p) { return p.descrizione.toLowerCase().indexOf(term) !== -1; });
    console.log('Componenti che contengono "' + term + '": ' + matched.length);
    matched.slice(0, 15).forEach(function (p) { console.log('  idpar=' + p.idpar + '  ' + p.descrizione + (p.simmetria ? '  [' + p.simmetria + ']' : '')); });
  } else {
    parts.slice(0, 20).forEach(function (p) { console.log('  idpar=' + p.idpar + '  ' + p.descrizione); });
    if (parts.length > 20) console.log('  ... (+' + (parts.length - 20) + ' altri, vedi data/rtws-flow/step2_*.xml)');
  }
  const chosen = (matched[0] || parts[0]);
  if (!chosen) { console.log('\nNessun componente da dettagliare.'); process.exit(0); }
  console.log('\nComponente scelto per il dettaglio: idpar=' + chosen.idpar + '  ' + chosen.descrizione + '\n');

  // STEP 3
  console.log('--- STEP 3: dettaglio ricambio, OE + prezzo (GetRicambiDBRT, BDRT) ---');
  const variants = await step3(bdrtSid, v.id_marca, v.id_modello, v.id_versione, chosen.idpar);
  if (!variants.length) {
    console.log('Nessuna variante/listino restituito per idpar=' + chosen.idpar + '. Vedi data/rtws-flow/step3_*.xml');
  } else {
    console.log('Varianti trovate: ' + variants.length);
    variants.forEach(function (x) {
      console.log('  OE=' + (x.codice || 'n/d') + '  prezzo=' + (x.prezzo || 'n/d') + '  ' + (x.descrizione || '') + (x.colore ? '  colore=' + x.colore : ''));
    });
  }

  console.log('\n=== ESITO ===');
  console.log('Catena targa -> veicolo -> componente -> OE+prezzo: FUNZIONANTE con i prodotti attivi.');
  console.log('XML grezzi salvati in: ' + OUT_DIR);
}

main().catch(function (e) {
  console.error('\nERRORE:', e.message);
  console.error('Controlla gli XML grezzi in data/rtws-flow/ per i dettagli.');
  process.exit(1);
});
