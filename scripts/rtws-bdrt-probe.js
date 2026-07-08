#!/usr/bin/env node
'use strict';

// Sonda BDRT su codici veicolo noti (Marca/Modello/Versione interi).
// Serve a capire perche' GetIdParBDRTCompleto torna vuoto: verifica se i codici
// sono validi in BDRT e cosa serve per enumerare i ricambi.
// NON consuma crediti TARGATELAIO: usa solo RTWS_BDRT (illimitato).
//
//   GetMMA               -> il veicolo esiste in BDRT con questi codici?
//   GetCategorieBDRT     -> categorie disponibili per il veicolo
//   GetGruppiBDRT        -> gruppi disponibili
//   GetIdParBDRT         -> lista idpar (variante "semplice")
//   GetIdParBDRTCompleto -> lista idpar+descrizione (senza e con categoria)
//
// Uso (sul server):
//   node scripts/rtws-bdrt-probe.js <Marca> <Modello> <Versione>
// Esempio (Renault Clio del test targa):
//   node scripts/rtws-bdrt-probe.js 19 85 2
//
// Autosufficiente, compatibile con Node.js 12+.

const https = require('https');
const fs = require('fs');
const path = require('path');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach(function (line) {
    const t = line.trim();
    if (!t || t.charAt(0) === '#') return;
    const eq = t.indexOf('=');
    if (eq === -1) return;
    const k = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    const a = val.charAt(0), b = val.charAt(val.length - 1);
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) val = val.slice(1, -1);
    if (!(k in process.env)) process.env[k] = val;
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
function collectBlocks(xml, tag) {
  const re = new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'ig');
  const out = []; let m;
  while ((m = re.exec(str(xml))) !== null) out.push(m[1]);
  return out;
}
function collectValues(xml, tag) { return collectBlocks(xml, tag).map(function (b) { return xmlDecode(b).trim(); }).filter(Boolean); }

function serviceUrl() { const b = str(process.env.RTWS_WSDL_URL || '').trim(); return b.replace(/\?wsdl$/i, '').replace(/\?WSDL$/i, ''); }
function envelope(method, inner) {
  return '<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://www.w3.org/2003/05/soap-envelope">\n  <soap:Body>\n    <' + method + ' xmlns="http://tempuri.org/">\n      ' + inner + '\n    </' + method + '>\n  </soap:Body>\n</soap:Envelope>';
}
function callSoap(method, inner) {
  return new Promise(function (resolve) {
    const url = serviceUrl();
    if (!url) return resolve({ ok: false, error: 'RTWS_WSDL_URL non configurato' });
    let ep; try { ep = new URL(url); } catch (e) { return resolve({ ok: false, error: 'URL non valido' }); }
    const xml = envelope(method, inner);
    const req = https.request({
      protocol: ep.protocol, hostname: ep.hostname, port: ep.port || 443, path: ep.pathname, method: 'POST',
      timeout: Number(process.env.RTWS_TIMEOUT_MS || 12000),
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8; action="http://tempuri.org/' + method + '"', 'Content-Length': Buffer.byteLength(xml) }
    }, function (res) {
      let raw = ''; res.on('data', function (c) { raw += c; });
      res.on('end', function () { const code = res.statusCode || 0; if (code >= 200 && code < 300) resolve({ ok: true, rawXml: raw }); else resolve({ ok: false, rawXml: raw, error: getTag(raw, 'faultstring') || ('HTTP ' + code) }); });
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

function mmv(sid, marca, modello, versione) {
  return '<sessionId>' + xmlEscape(sid) + '</sessionId><context><Marca>' + xmlEscape(marca) + '</Marca><Modello>' + xmlEscape(modello) + '</Modello><Versione>' + xmlEscape(versione) + '</Versione></context>';
}

async function main() {
  const marca = process.argv[2], modello = process.argv[3], versione = process.argv[4];
  if (!marca || !modello || !versione) {
    console.error('Uso: node scripts/rtws-bdrt-probe.js <Marca> <Modello> <Versione>');
    console.error('Esempio: node scripts/rtws-bdrt-probe.js 19 85 2');
    process.exit(1);
  }
  console.log('=== Sonda BDRT su codici veicolo ===');
  console.log('Marca=' + marca + '  Modello=' + modello + '  Versione=' + versione + '  (prodotto BDRT, nessun credito TARGATELAIO)\n');

  const sid = await login(process.env.RTWS_PRODUCT_BDRT || 'RTWS_BDRT');

  // 1. GetMMA — il veicolo esiste in BDRT?
  console.log('--- 1) GetMMA (i codici sono validi in BDRT?) ---');
  let r = await callSoap('GetMMA', mmv(sid, marca, modello, versione));
  saveRaw('probe_GetMMA.xml', r.rawXml || r.error);
  if (!r.ok) console.log('  ERRORE: ' + r.error);
  else {
    const veicolo = getBlock(r.rawXml, 'Veicolo');
    const stateCode = getTag(r.rawXml, 'Code');
    if (veicolo && veicolo.replace(/\s/g, '')) {
      console.log('  VEICOLO RICONOSCIUTO (state Code=' + stateCode + '):');
      console.log('    Marca=' + (getTag(veicolo, 'DsMar') || getTag(veicolo, 'Marca')) + '  Modello=' + (getTag(veicolo, 'DsMod') || getTag(veicolo, 'Modello')) + '  Versione=' + (getTag(veicolo, 'DsVer') || getTag(veicolo, 'Versione')));
    } else {
      console.log('  Nessun blocco <Veicolo> (state Code=' + stateCode + '). I codici potrebbero NON essere BDRT.');
    }
  }
  console.log('');

  // 2. GetCategorieBDRT
  console.log('--- 2) GetCategorieBDRT (categorie del veicolo) ---');
  r = await callSoap('GetCategorieBDRT', mmv(sid, marca, modello, versione));
  saveRaw('probe_GetCategorieBDRT.xml', r.rawXml || r.error);
  let categorie = [];
  if (!r.ok) console.log('  ERRORE: ' + r.error);
  else { categorie = collectValues(getBlock(r.rawXml, 'Categorie'), 'string'); console.log('  Categorie: ' + (categorie.length ? categorie.join(' | ') : '(nessuna)')); }
  console.log('');

  // 3. GetGruppiBDRT
  console.log('--- 3) GetGruppiBDRT (gruppi del veicolo) ---');
  r = await callSoap('GetGruppiBDRT', mmv(sid, marca, modello, versione));
  saveRaw('probe_GetGruppiBDRT.xml', r.rawXml || r.error);
  if (!r.ok) console.log('  ERRORE: ' + r.error);
  else { const gruppi = collectValues(getBlock(r.rawXml, 'Gruppi'), 'string'); console.log('  Gruppi: ' + (gruppi.length ? gruppi.slice(0, 20).join(' | ') : '(nessuno)')); }
  console.log('');

  // 4. GetIdParBDRT (variante semplice -> lista int)
  console.log('--- 4) GetIdParBDRT (lista idpar, variante semplice) ---');
  r = await callSoap('GetIdParBDRT', mmv(sid, marca, modello, versione));
  saveRaw('probe_GetIdParBDRT.xml', r.rawXml || r.error);
  if (!r.ok) console.log('  ERRORE: ' + r.error);
  else { const ids = collectValues(getBlock(r.rawXml, 'DBRT_Parts'), 'int'); console.log('  idpar restituiti: ' + ids.length + (ids.length ? '  (primi: ' + ids.slice(0, 15).join(', ') + ')' : '')); }
  console.log('');

  // 5. GetIdParBDRTCompleto senza categoria (gia' visto vuoto, riconferma)
  console.log('--- 5) GetIdParBDRTCompleto SENZA categoria ---');
  r = await callSoap('GetIdParBDRTCompleto', mmv(sid, marca, modello, versione) .replace('</context>', '<CodLingua>IT</CodLingua></context>'));
  saveRaw('probe_GetIdParBDRTCompleto_nocat.xml', r.rawXml || r.error);
  if (!r.ok) console.log('  ERRORE: ' + r.error);
  else { const parts = collectBlocks(getBlock(r.rawXml, 'DBRT_Parts'), 'parts'); console.log('  componenti: ' + parts.length); }
  console.log('');

  // 6. GetIdParBDRTCompleto CON prima categoria (se esiste)
  if (categorie.length) {
    const cat = categorie[0];
    console.log('--- 6) GetIdParBDRTCompleto CON categoria "' + cat + '" ---');
    const inner = '<sessionId>' + xmlEscape(sid) + '</sessionId><context><Marca>' + xmlEscape(marca) + '</Marca><Modello>' + xmlEscape(modello) + '</Modello><Versione>' + xmlEscape(versione) + '</Versione><Categoria>' + xmlEscape(cat) + '</Categoria><CodLingua>IT</CodLingua></context>';
    r = await callSoap('GetIdParBDRTCompleto', inner);
    saveRaw('probe_GetIdParBDRTCompleto_cat.xml', r.rawXml || r.error);
    if (!r.ok) console.log('  ERRORE: ' + r.error);
    else {
      const parts = collectBlocks(getBlock(r.rawXml, 'DBRT_Parts'), 'parts');
      console.log('  componenti nella categoria: ' + parts.length);
      parts.slice(0, 15).forEach(function (p) { console.log('    idpar=' + (getTag(p, 'idpar') || getTag(p, 'Idpar')) + '  ' + (getTag(p, 'descrizione') || getTag(p, 'Descrizione'))); });
    }
  } else {
    console.log('--- 6) saltato: nessuna categoria da provare ---');
  }

  console.log('\nXML grezzi in: ' + OUT_DIR);
  console.log('Se GetMMA non riconosce il veicolo -> i codici TARGATELAIO non sono BDRT (serve conversione).');
  console.log('Se GetMMA riconosce ma le liste sono vuote -> il veicolo non ha ricambi catalogati in BDRT, o serve un altro parametro.');
}

main().catch(function (e) { console.error('\nERRORE:', e.message); process.exit(1); });
