#!/usr/bin/env node
'use strict';

// Sonda "ricambi": valida il metodo che conta (GetRicambiDBRT) e cerca dove vive
// l'enumerazione idpar (GetIdParBDRT / GetIdParBDRTCompleto) tra i prodotti attivi.
// NON consuma crediti TARGATELAIO (solo Login su vari prodotti + chiamate BDRT/LISTINI).
//
// A) GetRicambiDBRT(M/M/V, [idpar])  con un idpar noto -> OE + prezzo   (test decisivo)
//    prova due serializzazioni dell'array Idpars: <Idpar> (WSDL) e <int> (esempio manuale)
// B) GetIdParBDRT  provato sotto BDRT / LISTINI / TARGATELAIO -> in quale prodotto risponde?
// C) GetIdParBDRTCompleto con Pratica -> sblocca l'enumerazione?
//
// Uso (sul server):
//   node scripts/rtws-ricambi-probe.js <Marca> <Modello> <Versione> [idpar1,idpar2,...]
// Esempio (Clio, filtro olio=4916 radiatore=2383 dagli esempi del manuale):
//   node scripts/rtws-ricambi-probe.js 19 85 2 4916,2383
//
// Autosufficiente, compatibile con Node.js 12+.

const https = require('https');
const fs = require('fs');
const path = require('path');

function loadEnvFile(fp) {
  if (!fs.existsSync(fp)) return;
  fs.readFileSync(fp, 'utf8').split(/\r?\n/).forEach(function (line) {
    const t = line.trim(); if (!t || t.charAt(0) === '#') return;
    const eq = t.indexOf('='); if (eq === -1) return;
    const k = t.slice(0, eq).trim(); let v = t.slice(eq + 1).trim();
    const a = v.charAt(0), b = v.charAt(v.length - 1);
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  });
}
(function () {
  const root = path.resolve(__dirname, '..');
  loadEnvFile(path.join(root, '.env'));
  const env = process.env.NODE_ENV || 'production';
  loadEnvFile(path.join(root, '.env.' + env));
  if (env !== 'production') loadEnvFile(path.join(root, '.env.local'));
})();

function str(v) { return v === undefined || v === null ? '' : String(v); }
function xmlEscape(v) { return str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function xmlDecode(v) { return str(v).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
function getTag(xml, tag) { const m = str(xml).match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'i')); return m ? xmlDecode(m[1]).trim() : ''; }
function getBlock(xml, tag) { const m = str(xml).match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'i')); return m ? m[1] : ''; }
function collectBlocks(xml, tag) { const re = new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'ig'); const out = []; let m; while ((m = re.exec(str(xml))) !== null) out.push(m[1]); return out; }

function serviceUrl() { const b = str(process.env.RTWS_WSDL_URL || '').trim(); return b.replace(/\?wsdl$/i, '').replace(/\?WSDL$/i, ''); }
function envelope(method, inner) {
  return '<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://www.w3.org/2003/05/soap-envelope">\n  <soap:Body>\n    <' + method + ' xmlns="http://tempuri.org/">\n      ' + inner + '\n    </' + method + '>\n  </soap:Body>\n</soap:Envelope>';
}
function callSoap(method, inner) {
  return new Promise(function (resolve) {
    const url = serviceUrl(); if (!url) return resolve({ ok: false, error: 'RTWS_WSDL_URL non configurato' });
    let ep; try { ep = new URL(url); } catch (e) { return resolve({ ok: false, error: 'URL non valido' }); }
    const xml = envelope(method, inner);
    const req = https.request({
      protocol: ep.protocol, hostname: ep.hostname, port: ep.port || 443, path: ep.pathname, method: 'POST',
      timeout: Number(process.env.RTWS_TIMEOUT_MS || 12000),
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8; action="http://tempuri.org/' + method + '"', 'Content-Length': Buffer.byteLength(xml) }
    }, function (res) {
      let raw = ''; res.on('data', function (c) { raw += c; });
      res.on('end', function () { const code = res.statusCode || 0; if (code >= 200 && code < 300) resolve({ ok: true, rawXml: raw }); else resolve({ ok: false, rawXml: raw, error: getTag(raw, 'Text') || getTag(raw, 'faultstring') || ('HTTP ' + code) }); });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', function (e) { resolve({ ok: false, error: e.message }); });
    req.write(xml); req.end();
  });
}
async function login(productName) {
  const inner = '<aziendaName>' + xmlEscape(process.env.RTWS_AZIENDA_NAME || '') + '</aziendaName><clientName>' + xmlEscape(process.env.RTWS_CLIENT_NAME || '') + '</clientName><password>' + xmlEscape(process.env.RTWS_PASSWORD || '') + '</password><productName>' + xmlEscape(productName) + '</productName>';
  const r = await callSoap('Login', inner);
  if (!r.ok) return null;
  const sid = getTag(r.rawXml, 'SessionId');
  return (getTag(r.rawXml, 'LoginState') === 'SUCCESS' && sid) ? sid : null;
}

const OUT_DIR = path.resolve(__dirname, '..', 'data', 'rtws-flow');
function saveRaw(name, xml) { try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (e) {} fs.writeFileSync(path.join(OUT_DIR, name), str(xml)); }

function parseVariants(rawXml) {
  const out = [];
  collectBlocks(rawXml, 'DBRT_Part').forEach(function (pb) {
    const idpar = getTag(pb, 'Idpar') || getTag(pb, 'idpar');
    collectBlocks(pb, 'VarianteListino').forEach(function (v) {
      out.push({ idpar: idpar, descrizione: getTag(v, 'Dspar'), codice: getTag(v, 'Parno'), prezzo: getTag(v, 'Przli'), colore: getTag(v, 'Color') });
    });
  });
  return out;
}

async function main() {
  const marca = process.argv[2], modello = process.argv[3], versione = process.argv[4];
  const idpars = str(process.argv[5] || '4916,2383').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  if (!marca || !modello || !versione) {
    console.error('Uso: node scripts/rtws-ricambi-probe.js <Marca> <Modello> <Versione> [idpar1,idpar2,...]');
    console.error('Esempio: node scripts/rtws-ricambi-probe.js 19 85 2 4916,2383');
    process.exit(1);
  }
  console.log('=== Sonda ricambi RTWS ===');
  console.log('Veicolo: Marca=' + marca + ' Modello=' + modello + ' Versione=' + versione + '   idpar da provare: ' + idpars.join(', ') + '\n');

  const bdrt = await login(process.env.RTWS_PRODUCT_BDRT || 'RTWS_BDRT');
  if (!bdrt) { console.error('Login BDRT fallito.'); process.exit(1); }

  // A) GetRicambiDBRT con idpar noto — prova array come <Idpar> e come <int>
  console.log('--- A) GetRicambiDBRT con idpar noto (test decisivo) ---');
  for (let i = 0; i < idpars.length; i++) {
    const idpar = idpars[i];
    let found = false;
    const serializations = [['Idpar', 'Idpar'], ['int', 'int']];
    for (let s = 0; s < serializations.length && !found; s++) {
      const elem = serializations[s][0];
      const inner = '<sessionId>' + xmlEscape(bdrt) + '</sessionId><context>' +
        '<Marca>' + xmlEscape(marca) + '</Marca><Modello>' + xmlEscape(modello) + '</Modello><Versione>' + xmlEscape(versione) + '</Versione>' +
        '<CodLingua>IT</CodLingua><Idpars><' + elem + '>' + xmlEscape(idpar) + '</' + elem + '></Idpars></context>';
      const r = await callSoap('GetRicambiDBRT', inner);
      saveRaw('ricambi_GetRicambiDBRT_' + idpar + '_' + elem + '.xml', r.rawXml || r.error);
      if (!r.ok) { console.log('  idpar ' + idpar + ' [array=<' + elem + '>]: ERRORE ' + r.error); continue; }
      const variants = parseVariants(r.rawXml);
      if (variants.length) {
        found = true;
        console.log('  idpar ' + idpar + ' [array=<' + elem + '>]: ' + variants.length + ' variante/i');
        variants.forEach(function (x) { console.log('      OE=' + (x.codice || 'n/d') + '  prezzo=' + (x.prezzo || 'n/d') + '  ' + (x.descrizione || '')); });
      } else {
        console.log('  idpar ' + idpar + ' [array=<' + elem + '>]: 0 varianti (DBRT_Parts vuoto)');
      }
    }
  }
  console.log('');

  // B) In quale prodotto vive GetIdParBDRT?
  console.log('--- B) GetIdParBDRT: in quale prodotto attivo risponde? ---');
  const products = [
    ['BDRT', process.env.RTWS_PRODUCT_BDRT || 'RTWS_BDRT'],
    ['LISTINI', process.env.RTWS_PRODUCT_LISTINI || 'RTWS_LISTINI'],
    ['TARGATELAIO', process.env.RTWS_PRODUCT_TARGATELAIO || 'RTWS_TARGATELAIO'],
  ];
  for (let i = 0; i < products.length; i++) {
    const label = products[i][0], prod = products[i][1];
    const sid = await login(prod);
    if (!sid) { console.log('  ' + label + ': login fallito'); continue; }
    const inner = '<sessionId>' + xmlEscape(sid) + '</sessionId><context><Marca>' + xmlEscape(marca) + '</Marca><Modello>' + xmlEscape(modello) + '</Modello><Versione>' + xmlEscape(versione) + '</Versione></context>';
    const r = await callSoap('GetIdParBDRT', inner);
    saveRaw('ricambi_GetIdParBDRT_' + label + '.xml', r.rawXml || r.error);
    if (!r.ok) { console.log('  ' + label + ': ' + r.error); continue; }
    const ids = collectBlocks(getBlock(r.rawXml, 'DBRT_Parts'), 'int').map(function (b) { return xmlDecode(b).trim(); });
    console.log('  ' + label + ': OK, idpar restituiti=' + ids.length + (ids.length ? '  (primi: ' + ids.slice(0, 15).join(', ') + ')' : ''));
  }
  console.log('');

  // C) GetIdParBDRTCompleto con Pratica -> sblocca?
  console.log('--- C) GetIdParBDRTCompleto con Pratica ---');
  const pratiche = ['0', '1', 'TEST'];
  for (let i = 0; i < pratiche.length; i++) {
    const p = pratiche[i];
    const inner = '<sessionId>' + xmlEscape(bdrt) + '</sessionId><context><Marca>' + xmlEscape(marca) + '</Marca><Modello>' + xmlEscape(modello) + '</Modello><Versione>' + xmlEscape(versione) + '</Versione><CodLingua>IT</CodLingua><Pratica>' + xmlEscape(p) + '</Pratica></context>';
    const r = await callSoap('GetIdParBDRTCompleto', inner);
    saveRaw('ricambi_GetIdParBDRTCompleto_pratica_' + p + '.xml', r.rawXml || r.error);
    if (!r.ok) { console.log('  Pratica="' + p + '": ERRORE ' + r.error); continue; }
    const parts = collectBlocks(getBlock(r.rawXml, 'DBRT_Parts'), 'parts');
    console.log('  Pratica="' + p + '": componenti=' + parts.length);
  }

  console.log('\nXML grezzi in: ' + OUT_DIR);
  console.log('Se (A) restituisce OE+prezzo -> abbiamo il percorso: idpar noto -> GetRicambiDBRT (bastano BDRT+LISTINI).');
}

main().catch(function (e) { console.error('\nERRORE:', e.message); process.exit(1); });
