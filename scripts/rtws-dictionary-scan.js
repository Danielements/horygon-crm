#!/usr/bin/env node
'use strict';

// Costruisce il dizionario universale idpar -> descrizione interrogando GetRicambiDBRT
// a blocchi contro un veicolo di riferimento ben catalogato.
// GetRicambiDBRT accetta una lista di idpar per chiamata: scansioniamo un range
// in poche chiamate e raccogliamo la descrizione (Dspar) di ogni idpar trovato.
//
// Il dizionario e' UNIVERSALE (idpar 4916 = "Filtro olio" per qualsiasi veicolo):
// l'output va in data/rtws-idpar-dictionary.json e viene ARRICCHITO ad ogni run,
// cosi' puoi lanciarlo su piu' veicoli diversi (benzina, diesel, SUV) per coprire
// tutto il catalogo.
//
// Usa solo RTWS_BDRT (illimitato): NON consuma crediti TARGATELAIO.
//
// Uso (sul server):
//   node scripts/rtws-dictionary-scan.js <Marca> <Modello> <Versione> [maxIdpar] [batchSize]
// Esempio (Renault Clio del test, scansione 1..10000):
//   node scripts/rtws-dictionary-scan.js 19 85 2
//   node scripts/rtws-dictionary-scan.js 19 85 2 15000 50
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

const DICT_FILE = path.resolve(__dirname, '..', 'data', 'rtws-idpar-dictionary.json');
function loadDict() {
  try { return JSON.parse(fs.readFileSync(DICT_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveDict(dict) {
  try { fs.mkdirSync(path.dirname(DICT_FILE), { recursive: true }); } catch (e) {}
  // ordina per idpar numerico
  const ordered = {};
  Object.keys(dict).map(Number).sort(function (a, b) { return a - b; }).forEach(function (k) { ordered[k] = dict[k]; });
  fs.writeFileSync(DICT_FILE, JSON.stringify(ordered, null, 2));
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function scanBatch(sid, marca, modello, versione, idparList) {
  const idparsXml = idparList.map(function (n) { return '<Idpar>' + n + '</Idpar>'; }).join('');
  const inner = '<sessionId>' + xmlEscape(sid) + '</sessionId><context>' +
    '<Marca>' + xmlEscape(marca) + '</Marca><Modello>' + xmlEscape(modello) + '</Modello><Versione>' + xmlEscape(versione) + '</Versione>' +
    '<CodLingua>IT</CodLingua><Idpars>' + idparsXml + '</Idpars></context>';
  const r = await callSoap('GetRicambiDBRT', inner);
  if (!r.ok) return { ok: false, error: r.error };
  const found = {};
  collectBlocks(r.rawXml, 'DBRT_Part').forEach(function (pb) {
    const idpar = getTag(pb, 'Idpar') || getTag(pb, 'idpar');
    if (!idpar) return;
    // descrizione: primo Dspar disponibile tra le varianti
    let descr = '';
    const variants = collectBlocks(pb, 'VarianteListino');
    for (let i = 0; i < variants.length && !descr; i++) descr = getTag(variants[i], 'Dspar');
    if (descr) found[idpar] = descr;
  });
  return { ok: true, found: found };
}

async function main() {
  const marca = process.argv[2], modello = process.argv[3], versione = process.argv[4];
  const maxIdpar = Number(process.argv[5] || 10000);
  const batchSize = Number(process.argv[6] || 50);
  if (!marca || !modello || !versione) {
    console.error('Uso: node scripts/rtws-dictionary-scan.js <Marca> <Modello> <Versione> [maxIdpar] [batchSize]');
    console.error('Esempio: node scripts/rtws-dictionary-scan.js 19 85 2');
    process.exit(1);
  }
  console.log('=== Scansione dizionario idpar (GetRicambiDBRT, BDRT illimitato) ===');
  console.log('Veicolo: Marca=' + marca + ' Modello=' + modello + ' Versione=' + versione);
  console.log('Range idpar: 1..' + maxIdpar + '   blocco: ' + batchSize + '   (nessun credito TARGATELAIO)\n');

  const dict = loadDict();
  const startCount = Object.keys(dict).length;
  console.log('Dizionario esistente: ' + startCount + ' voci. Le nuove voci verranno aggiunte.\n');

  let sid = await login(process.env.RTWS_PRODUCT_BDRT || 'RTWS_BDRT');

  let newInThisRun = 0;
  let maxFound = 0;
  let batchErrors = 0;
  const totalBatches = Math.ceil(maxIdpar / batchSize);
  let batchNo = 0;

  for (let start = 1; start <= maxIdpar; start += batchSize) {
    batchNo++;
    const list = [];
    for (let n = start; n < start + batchSize && n <= maxIdpar; n++) list.push(n);
    const res = await scanBatch(sid, marca, modello, versione, list);
    if (!res.ok) {
      batchErrors++;
      // rilogin in caso di sessione scaduta, poi continua
      if (/session|scadut|access/i.test(res.error)) {
        try { const s2 = await login(process.env.RTWS_PRODUCT_BDRT || 'RTWS_BDRT'); if (s2) sid = s2; } catch (e) {}
      }
    } else {
      const keys = Object.keys(res.found);
      keys.forEach(function (idpar) {
        if (!dict[idpar]) newInThisRun++;
        dict[idpar] = res.found[idpar];
        const n = Number(idpar); if (n > maxFound) maxFound = n;
      });
    }
    // progresso + salvataggio incrementale ogni 10 blocchi
    if (batchNo % 10 === 0 || start + batchSize > maxIdpar) {
      saveDict(dict);
      process.stdout.write('\r  blocco ' + batchNo + '/' + totalBatches + '  (fino a idpar ' + Math.min(start + batchSize - 1, maxIdpar) + ')  voci totali: ' + Object.keys(dict).length + '   ');
    }
    await sleep(120);
  }

  saveDict(dict);
  console.log('\n');
  console.log('=== FINE SCANSIONE ===');
  console.log('Voci nuove in questo run: ' + newInThisRun);
  console.log('Voci totali nel dizionario: ' + Object.keys(dict).length);
  console.log('idpar piu\' alto trovato: ' + maxFound + (maxFound >= maxIdpar - batchSize ? '  (vicino al limite: valuta un maxIdpar piu\' alto)' : ''));
  if (batchErrors) console.log('Blocchi con errore (saltati): ' + batchErrors);
  console.log('Dizionario salvato in: ' + DICT_FILE);
  console.log('\nSuggerimento: rilancia su un veicolo diverso (es. un diesel o un SUV) per coprire ricambi assenti su questo modello.');
}

main().catch(function (e) { console.error('\nERRORE:', e.message); process.exit(1); });
