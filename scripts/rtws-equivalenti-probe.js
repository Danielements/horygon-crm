#!/usr/bin/env node
'use strict';

// Sonda compatibili/equivalenti: prova i 4 metodi LISTINI per un OE e mostra
// quale restituisce i ricambi aftermarket. NON consuma crediti TARGATELAIO.
//
//   GetListiniEquivalenti     (PartNumber)                  -> equivalenti
//   GetPartNumberSostituenti  (IdMarca, PartNumber)         -> sostituenti
//   SearchListiniByOe         (Oe, idMar, Top)              -> listini da OE
//   SearchListiniCompletoByOe (Oe, idMar, Top, SoloOrdinabili)
//
// Uso (sul server):
//   node scripts/rtws-equivalenti-probe.js <OE> [idMar]
// Esempio (filtro olio Clio, marca 19):
//   node scripts/rtws-equivalenti-probe.js 152082327R 19
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
function collectBlocks(xml, tag) { const re = new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'ig'); const out = []; let m; while ((m = re.exec(str(xml))) !== null) out.push(m[1]); return out; }
function countTag(xml, tag) { return (str(xml).match(new RegExp('<' + tag + '>', 'ig')) || []).length; }

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
      timeout: Number(process.env.RTWS_TIMEOUT_MS || 15000),
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
  if (!r.ok) throw new Error('Login ' + productName + ' fallito: ' + r.error);
  const sid = getTag(r.rawXml, 'SessionId');
  if (getTag(r.rawXml, 'LoginState') !== 'SUCCESS' || !sid) throw new Error('Login ' + productName + ' non riuscito');
  return sid;
}

const OUT_DIR = path.resolve(__dirname, '..', 'data', 'rtws-flow');
function saveRaw(name, xml) { try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (e) {} fs.writeFileSync(path.join(OUT_DIR, name), str(xml)); }

function report(label, r, fileTag) {
  saveRaw('equi_' + fileTag + '.xml', r.rawXml || r.error);
  if (!r.ok) { console.log('  ' + label + ': ERRORE ' + r.error); return; }
  const code = getTag(r.rawXml, 'Code');
  // conteggio generico di elementi ricambio: PartNumber o Parno o Oe presenti
  const n = Math.max(countTag(r.rawXml, 'PartNumber'), countTag(r.rawXml, 'Parno'));
  console.log('  ' + label + ': state Code=' + code + '  elementi(PartNumber)=' + n);
  // primi 3 campioni
  ['RicambioEquiRes', 'RicambioSost', 'RicambioRes', 'SearchRicambioRes'].forEach(function (tag) {
    const blocks = collectBlocks(r.rawXml, tag);
    if (blocks.length) {
      console.log('    (' + tag + ' x' + blocks.length + ') es.: ' + blocks.slice(0, 3).map(function (b) {
        return (getTag(b, 'PartNumber') || getTag(b, 'Parno')) + ' ' + (getTag(b, 'Descrizione') || getTag(b, 'Dspar')) + ' ' + (getTag(b, 'Prezzo') || getTag(b, 'Przli'));
      }).join(' | '));
    }
  });
}

async function main() {
  const oe = process.argv[2];
  const idMar = process.argv[3] || '';
  if (!oe) { console.error('Uso: node scripts/rtws-equivalenti-probe.js <OE> [idMar]'); process.exit(1); }
  console.log('=== Sonda compatibili/equivalenti per OE=' + oe + (idMar ? ' idMar=' + idMar : '') + ' ===\n');

  const sid = await login(process.env.RTWS_PRODUCT_LISTINI || 'RTWS_LISTINI');

  console.log('--- 1) GetListiniEquivalenti (solo PartNumber) ---');
  report('GetListiniEquivalenti', await callSoap('GetListiniEquivalenti',
    '<sessionId>' + xmlEscape(sid) + '</sessionId><context><PartNumber>' + xmlEscape(oe) + '</PartNumber></context>'), 'GetListiniEquivalenti');

  console.log('--- 2) GetPartNumberSostituenti (IdMarca + PartNumber) ---');
  report('GetPartNumberSostituenti', await callSoap('GetPartNumberSostituenti',
    '<sessionId>' + xmlEscape(sid) + '</sessionId><context><IdMarca>' + xmlEscape(idMar) + '</IdMarca><PartNumber>' + xmlEscape(oe) + '</PartNumber></context>'), 'GetPartNumberSostituenti');

  console.log('--- 3) SearchListiniByOe (Oe + idMar + Top) ---');
  report('SearchListiniByOe', await callSoap('SearchListiniByOe',
    '<sessionId>' + xmlEscape(sid) + '</sessionId><context><Oe>' + xmlEscape(oe) + '</Oe><idMar>' + xmlEscape(idMar) + '</idMar><Top>10</Top></context>'), 'SearchListiniByOe');

  console.log('--- 4) SearchListiniCompletoByOe (Oe + idMar + Top + SoloOrdinabili) ---');
  report('SearchListiniCompletoByOe', await callSoap('SearchListiniCompletoByOe',
    '<sessionId>' + xmlEscape(sid) + '</sessionId><context><Oe>' + xmlEscape(oe) + '</Oe><idMar>' + xmlEscape(idMar) + '</idMar><Top>10</Top><SoloOrdinabili>false</SoloOrdinabili></context>'), 'SearchListiniCompletoByOe');

  console.log('\nXML grezzi in: ' + OUT_DIR);
  console.log('Quello che restituisce piu\' elementi e\' il metodo da usare per i compatibili.');
}

main().catch(function (e) { console.error('\nERRORE:', e.message); process.exit(1); });
