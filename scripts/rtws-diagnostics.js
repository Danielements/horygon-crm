#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');

function s(value) {
  return String(value ?? '').trim();
}

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

function getXmlTagBlock(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1] : '';
}

function collectXmlBlocks(xml, tag) {
  return [...String(xml || '').matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'ig'))].map((match) => match[1]);
}

function normalizePlate(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function makeSafeToken(value, fallback = 'rtws') {
  const token = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return token || fallback;
}

function timestampToken() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function getRtwsServiceUrl() {
  const base = s(process.env.RTWS_WSDL_URL || process.env.RTWS_SERVICE_URL || '');
  return base.replace(/\?wsdl$/i, '').replace(/\?WSDL$/i, '');
}

function getDebugDir() {
  const configured = s(process.env.RTWS_DEBUG_DIR);
  return path.resolve(configured || path.join(process.cwd(), 'data', 'rtws-debug'));
}

function ensureDebugDir() {
  const dir = getDebugDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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
    if (!serviceUrl) {
      resolve({ ok: false, error: 'RTWS_WSDL_URL non configurato' });
      return;
    }

    const endpoint = new URL(serviceUrl);
    const xml = buildSoap12Envelope(methodName, innerXml);
    const req = https.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || 443,
      path: endpoint.pathname,
      method: 'POST',
      timeout: Number(process.env.RTWS_TIMEOUT_MS || 12000),
      headers: {
        'Content-Type': `application/soap+xml; charset=utf-8; action="http://tempuri.org/${methodName}"`,
        'Content-Length': Buffer.byteLength(xml)
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) {
          resolve({ ok: true, rawXml: raw, statusCode: res.statusCode || 0, requestXml: xml });
          return;
        }
        resolve({
          ok: false,
          rawXml: raw,
          statusCode: res.statusCode || 0,
          requestXml: xml,
          error: getXmlTagValue(raw, 'faultstring') || `RTWS HTTP ${res.statusCode || 'ERR'}`
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ ok: false, error: error.message, requestXml: xml }));
    req.write(xml);
    req.end();
  });
}

async function getRtwsSession(productName) {
  const loginXml = `
    <aziendaName>${xmlEscape(process.env.RTWS_AZIENDA_NAME || '')}</aziendaName>
    <clientName>${xmlEscape(process.env.RTWS_CLIENT_NAME || '')}</clientName>
    <password>${xmlEscape(process.env.RTWS_PASSWORD || '')}</password>
    <productName>${xmlEscape(productName || '')}</productName>
  `;
  const result = await callRtwsSoap('Login', loginXml);
  if (!result.ok) throw new Error(result.error || 'Login RTWS fallito');
  const loginState = getXmlTagValue(result.rawXml, 'LoginState');
  const sessionId = getXmlTagValue(result.rawXml, 'SessionId');
  const errorMsg = getXmlTagValue(result.rawXml, 'ErrorMsg');
  if (loginState !== 'SUCCESS' || !sessionId) {
    throw new Error(errorMsg || `Login RTWS non riuscito (${loginState || 'UNKNOWN'})`);
  }
  return {
    sessionId,
    loginState,
    rawXml: result.rawXml,
    requestXml: result.requestXml,
    statusCode: result.statusCode || 0
  };
}

function parseState(rawXml) {
  return {
    code: getXmlTagValue(rawXml, 'Code') || '',
    description: getXmlTagValue(rawXml, 'Description') || '',
    fault: getXmlTagValue(rawXml, 'faultstring') || ''
  };
}

function parseVehicleAllestimenti(rawXml, blockTag = 'AllestimentoEsteso') {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'Allestimenti'), blockTag).map((block) => ({
    id_marca: getXmlTagValue(block, 'IdMar') || '',
    id_modello: getXmlTagValue(block, 'IdMod') || '',
    id_versione: getXmlTagValue(block, 'IdVer') || '',
    make: getXmlTagValue(block, 'DsMar') || '',
    model: getXmlTagValue(block, 'DsMod') || '',
    version: getXmlTagValue(block, 'DsVer') || '',
    infocar_code: getXmlTagValue(block, 'CodiceInfocarAM') || '',
    link_type: getXmlTagValue(block, 'TipologiaLink') || getXmlTagValue(block, 'TipoLink') || '',
    start_commercialization: getXmlTagValue(block, 'InizioCommercializzazione') || '',
    end_commercialization: getXmlTagValue(block, 'FineCommercializzazione') || ''
  })).filter((item) => item.id_marca || item.make || item.model || item.version || item.infocar_code);
}

function parseTecDocAllestimenti(rawXml) {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'Allestimenti'), 'AllestimentoCompletoTecDoc').map((block) => ({
    id_marca: getXmlTagValue(block, 'IdMar') || '',
    id_modello: getXmlTagValue(block, 'IdMod') || '',
    id_versione: getXmlTagValue(block, 'IdVer') || '',
    make: getXmlTagValue(block, 'DsMar') || '',
    model: getXmlTagValue(block, 'DsMod') || '',
    version: getXmlTagValue(block, 'DsVer') || '',
    infocar_code: getXmlTagValue(block, 'CodiceInfocarAM') || '',
    fuel: getXmlTagValue(block, 'Alimentazione') || '',
    power_kw: getXmlTagValue(block, 'PotenzaKw') || '',
    ktypes: collectXmlBlocks(getXmlTagBlock(block, 'KType'), 'string')
  })).filter((item) => item.id_marca || item.make || item.model || item.version || item.ktypes.length);
}

function parseSimpleVehicle(rawXml) {
  return {
    plate: getXmlTagValue(rawXml, 'Targa') || getXmlTagValue(rawXml, 'targa') || '',
    vin: getXmlTagValue(rawXml, 'Telaio') || getXmlTagValue(rawXml, 'telaio') || '',
    engine_code: getXmlTagValue(rawXml, 'CodiceMotore') || getXmlTagValue(rawXml, 'codiceMotore') || '',
    vehicle_type: getXmlTagValue(rawXml, 'TipoVeicolo') || getXmlTagValue(rawXml, 'tipoVeicolo') || '',
    registration_it: getXmlTagValue(rawXml, 'DataPrimaImmatricolazioneItalia') || getXmlTagValue(rawXml, 'dataPrimaImmatricolazioneItalia') || '',
    registration_foreign: getXmlTagValue(rawXml, 'DataPrimaImmatricolazioneEstera') || getXmlTagValue(rawXml, 'dataPrimaImmatricolazioneEstera') || '',
    last_revision: getXmlTagValue(rawXml, 'DataUltimaRevisione') || getXmlTagValue(rawXml, 'dataUltimaRevisione') || '',
    link_type: getXmlTagValue(rawXml, 'TipoLink') || getXmlTagValue(rawXml, 'TipologiaLink') || '',
    search_type: getXmlTagValue(rawXml, 'TipoRicerca') || ''
  };
}

function parseListinoItems(rawXml, itemTag = 'RicambioRes') {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'Ricambi') || rawXml, itemTag).map((block) => ({
    id_marca: getXmlTagValue(block, 'IdMar') || '',
    id_par: getXmlTagValue(block, 'IdPar') || getXmlTagValue(block, 'Idpar') || '',
    id_riga: getXmlTagValue(block, 'IdRiga') || '',
    oe_code: getXmlTagValue(block, 'OE') || getXmlTagValue(block, 'Oe') || '',
    part_number: getXmlTagValue(block, 'PartNumber') || getXmlTagValue(block, 'Parno') || '',
    price: getXmlTagValue(block, 'Prezzo') || getXmlTagValue(block, 'Przli') || '',
    description: getXmlTagValue(block, 'Descrizione') || getXmlTagValue(block, 'Dspar') || '',
    flag_manuale: getXmlTagValue(block, 'FlagManuale') || '',
    status: getXmlTagValue(block, 'Stato') || ''
  })).filter((item) => item.oe_code || item.part_number || item.description || item.price);
}

function parseEquivalentItems(rawXml) {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'Ricambi') || rawXml, 'RicambioEquiRes').map((block) => ({
    id_marca: getXmlTagValue(block, 'IdMar') || '',
    part_number: getXmlTagValue(block, 'PartNumber') || '',
    description: getXmlTagValue(block, 'Descrizione') || '',
    price: getXmlTagValue(block, 'Prezzo') || ''
  })).filter((item) => item.part_number || item.description || item.price);
}

function parseSearchRtByOe(rawXml) {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'Allestimenti') || rawXml, 'AllestimentoRes').map((block) => ({
    id_marca: getXmlTagValue(block, 'IdMar') || '',
    id_modello: getXmlTagValue(block, 'IdMod') || '',
    id_versione: getXmlTagValue(block, 'IdVer') || '',
    make: getXmlTagValue(block, 'DsMar') || '',
    model: getXmlTagValue(block, 'DsMod') || '',
    version: getXmlTagValue(block, 'DsVer') || '',
    oe_code: getXmlTagValue(block, 'OE') || ''
  })).filter((item) => item.id_marca || item.make || item.oe_code);
}

function parseRicambiByOe(rawXml) {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'SparePart_OEList') || rawXml, 'SparePart_OE').map((block) => ({
    oe_code: getXmlTagValue(block, 'OE') || '',
    matches: collectXmlBlocks(getXmlTagBlock(block, 'SparePartInfos') || block, 'SparePartInfo').map((infoBlock) => ({
      id_par: getXmlTagValue(infoBlock, 'Idpar') || '',
      description: getXmlTagValue(infoBlock, 'Dspar') || '',
      id_sim: getXmlTagValue(infoBlock, 'Idsim') || '',
      variants: collectXmlBlocks(getXmlTagBlock(infoBlock, 'OEList') || infoBlock, 'OEDetail').map((detailBlock) => ({
        part_number: getXmlTagValue(detailBlock, 'Parno') || '',
        extra_description: getXmlTagValue(detailBlock, 'Ultds') || '',
        pecos: getXmlTagValue(detailBlock, 'Pecos') || '',
        color: getXmlTagValue(detailBlock, 'Color') || ''
      })).filter((item) => item.part_number || item.extra_description || item.pecos || item.color)
    })).filter((item) => item.id_par || item.description || item.variants.length)
  })).filter((item) => item.oe_code || item.matches.length);
}

function parseRicambiDbrt(rawXml) {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'DBRT_Parts') || rawXml, 'DBRT_Part').map((block) => ({
    id_par: getXmlTagValue(block, 'Idpar') || '',
    id_sim: getXmlTagValue(block, 'Idsim') || '',
    variants: collectXmlBlocks(getXmlTagBlock(block, 'VariantiListino') || block, 'VarianteListino').map((variantBlock) => ({
      description: getXmlTagValue(variantBlock, 'Dspar') || '',
      part_number: getXmlTagValue(variantBlock, 'Parno') || '',
      extra_description: getXmlTagValue(variantBlock, 'Ultds') || '',
      pecos: getXmlTagValue(variantBlock, 'Pecos') || '',
      color: getXmlTagValue(variantBlock, 'Color') || '',
      list_price: getXmlTagValue(variantBlock, 'Przli') || ''
    })).filter((item) => item.description || item.part_number || item.list_price)
  })).filter((item) => item.id_par || item.variants.length);
}

function parsePartNumberSostituenti(rawXml) {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'PartNumbers') || rawXml, 'RicambioSost').map((block) => ({
    current_group: getXmlTagValue(block, 'IdGruppo') || '',
    part_number: getXmlTagValue(block, 'PartNumber') || '',
    dismissed_at: getXmlTagValue(block, 'Data') || ''
  })).filter((item) => item.current_group || item.part_number);
}

function parseKtypes(rawXml) {
  return collectXmlBlocks(getXmlTagBlock(rawXml, 'KType') || rawXml, 'string').map((value) => xmlDecode(value).trim()).filter(Boolean);
}

function resolveProduct(alias) {
  const upper = s(alias).toUpperCase();
  const map = {
    BDRT: process.env.RTWS_PRODUCT_BDRT,
    LISTINI: process.env.RTWS_PRODUCT_LISTINI,
    IDENTIFICAZIONE: process.env.RTWS_PRODUCT_IDENTIFICATION,
    IDENTIFICATION: process.env.RTWS_PRODUCT_IDENTIFICATION,
    EQUIVALENTI: process.env.RTWS_PRODUCT_EQUIVALENTI,
    TARGATELAIO: process.env.RTWS_PRODUCT_TARGATELAIO
  };
  return s(map[upper] || alias);
}

function writeDebugLog(command, payload) {
  const dir = ensureDebugDir();
  const filePath = path.join(dir, `${timestampToken()}-${makeSafeToken(command)}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

async function runScenario({ command, productAlias, methodName, contextXml, parseResponse }) {
  const productName = resolveProduct(productAlias);
  if (!productName) {
    throw new Error(`Prodotto RTWS non configurato per alias ${productAlias}`);
  }

  const login = await getRtwsSession(productName);
  const body = `
    <sessionId>${xmlEscape(login.sessionId)}</sessionId>
    ${contextXml}
  `;
  const result = await callRtwsSoap(methodName, body);
  const state = parseState(result.rawXml || '');
  const parsed = parseResponse ? parseResponse(result.rawXml || '') : null;
  const payload = {
    command,
    productAlias,
    productName,
    methodName,
    createdAt: new Date().toISOString(),
    login: {
      loginState: login.loginState,
      statusCode: login.statusCode,
      requestXml: login.requestXml,
      rawXml: login.rawXml
    },
    requestXml: result.requestXml || '',
    response: {
      ok: !!result.ok,
      statusCode: result.statusCode || 0,
      error: result.error || '',
      state
    },
    parsed,
    rawXml: result.rawXml || ''
  };
  const logFile = writeDebugLog(command, payload);
  return { payload, logFile };
}

function printUsage() {
  console.log(`
Uso:
  npm run rtws:diag -- help
  npm run rtws:diag -- echo <BDRT|LISTINI|IDENTIFICAZIONE|EQUIVALENTI|TARGATELAIO> [testo]
  npm run rtws:diag -- score <BDRT|LISTINI|IDENTIFICAZIONE|EQUIVALENTI|TARGATELAIO>
  npm run rtws:diag -- ident:targa <TARGA>
  npm run rtws:diag -- ident:esteso <TARGA>
  npm run rtws:diag -- targatelaio:min <TARGA>
  npm run rtws:diag -- equivalenti:tecdoc <TARGA>
  npm run rtws:diag -- equivalenti:ktype:infocar <INFOCAR_CODE>
  npm run rtws:diag -- equivalenti:substitutes <IDMARCA> <PARTNUMBER>
  npm run rtws:diag -- listini:update-oe <OE> [IDMAR] [IDPAR] [IDRIGA]
  npm run rtws:diag -- listini:equivalenti <PARTNUMBER>
  npm run rtws:diag -- bdrt:search-rt-by-oe <OE_PATTERN> [TOP]
  npm run rtws:diag -- bdrt:ricambi-by-oe <IDMAR> <IDMOD> <IDVER> <OE1,OE2>
  npm run rtws:diag -- bdrt:ricambi-dbrt <IDMAR> <IDMOD> <IDVER> <IDPAR1,IDPAR2>

Log salvati in:
  ${getDebugDir()}
`);
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (!getRtwsServiceUrl()) {
    throw new Error('RTWS_WSDL_URL mancante');
  }

  if (!s(process.env.RTWS_AZIENDA_NAME) || !s(process.env.RTWS_PASSWORD)) {
    throw new Error('RTWS_AZIENDA_NAME o RTWS_PASSWORD mancanti');
  }

  if (!s(process.env.RTWS_CLIENT_NAME)) {
    throw new Error('RTWS_CLIENT_NAME mancante: per questi prodotti il login richiede il client name corretto');
  }

  let result;

  switch (command) {
    case 'echo': {
      const [productAlias, ...textParts] = args;
      const text = textParts.join(' ') || 'ping';
      result = await runScenario({
        command,
        productAlias,
        methodName: 'GetEcho',
        contextXml: `<context>${xmlEscape(text)}</context>`,
        parseResponse: (rawXml) => ({ echo: getXmlTagValue(rawXml, 'GetEchoResult') || getXmlTagValue(rawXml, 'EchoResult') || '' })
      });
      break;
    }

    case 'score': {
      const [productAlias] = args;
      result = await runScenario({
        command,
        productAlias,
        methodName: 'GetScore',
        contextXml: '',
        parseResponse: (rawXml) => ({ score: getXmlTagValue(rawXml, 'GetScoreResult') || getXmlTagValue(rawXml, 'Score') || '' })
      });
      break;
    }

    case 'ident:targa': {
      const [plate] = args;
      result = await runScenario({
        command,
        productAlias: 'IDENTIFICAZIONE',
        methodName: 'GetRTDaTarga',
        contextXml: `<context><Targa>${xmlEscape(normalizePlate(plate))}</Targa></context>`,
        parseResponse: (rawXml) => ({
          vehicle: parseSimpleVehicle(rawXml),
          allestimenti: parseVehicleAllestimenti(rawXml)
        })
      });
      break;
    }

    case 'ident:esteso': {
      const [plate] = args;
      result = await runScenario({
        command,
        productAlias: 'IDENTIFICAZIONE',
        methodName: 'GetRTEstesoDaTarga',
        contextXml: `<context><Targa>${xmlEscape(normalizePlate(plate))}</Targa></context>`,
        parseResponse: (rawXml) => ({
          vehicle: parseSimpleVehicle(rawXml),
          allestimenti: parseVehicleAllestimenti(rawXml)
        })
      });
      break;
    }

    case 'targatelaio:min': {
      const [plate] = args;
      result = await runScenario({
        command,
        productAlias: 'TARGATELAIO',
        methodName: 'GetRTDaTargaMin',
        contextXml: `<context><Targa>${xmlEscape(normalizePlate(plate))}</Targa></context>`,
        parseResponse: (rawXml) => ({
          vehicle: parseSimpleVehicle(rawXml),
          allestimenti: parseVehicleAllestimenti(rawXml)
        })
      });
      break;
    }

    case 'equivalenti:tecdoc': {
      const [plate] = args;
      result = await runScenario({
        command,
        productAlias: 'EQUIVALENTI',
        methodName: 'GetRTCompletoDaTargaMinTecDocSingolo',
        contextXml: `<context><Targa>${xmlEscape(normalizePlate(plate))}</Targa></context>`,
        parseResponse: (rawXml) => ({
          vehicle: parseSimpleVehicle(rawXml),
          allestimenti: parseTecDocAllestimenti(rawXml)
        })
      });
      break;
    }

    case 'equivalenti:ktype:infocar': {
      const [infocarCode] = args;
      result = await runScenario({
        command,
        productAlias: 'EQUIVALENTI',
        methodName: 'GetKType',
        contextXml: `<context><InfocarCode>${xmlEscape(infocarCode || '')}</InfocarCode></context>`,
        parseResponse: (rawXml) => ({ ktypes: parseKtypes(rawXml) })
      });
      break;
    }

    case 'equivalenti:substitutes': {
      const [idMarca, partNumber] = args;
      result = await runScenario({
        command,
        productAlias: 'EQUIVALENTI',
        methodName: 'GetPartNumberSostituenti',
        contextXml: `
          <context>
            <IdMarca>${xmlEscape(idMarca || '')}</IdMarca>
            <PartNumber>${xmlEscape(partNumber || '')}</PartNumber>
          </context>
        `,
        parseResponse: (rawXml) => ({ substitutes: parsePartNumberSostituenti(rawXml) })
      });
      break;
    }

    case 'listini:update-oe': {
      const [oeCode, idMar = '0', idPar = '0', idRiga = '1'] = args;
      result = await runScenario({
        command,
        productAlias: 'LISTINI',
        methodName: 'GetUpdateListini',
        contextXml: `
          <context>
            <Ricambi>
              <RicambioReq>
                <IdMar>${xmlEscape(idMar)}</IdMar>
                <IdPar>${xmlEscape(idPar)}</IdPar>
                <OE>${xmlEscape(oeCode || '')}</OE>
                <IdRiga>${xmlEscape(idRiga)}</IdRiga>
              </RicambioReq>
            </Ricambi>
          </context>
        `,
        parseResponse: (rawXml) => ({ items: parseListinoItems(rawXml) })
      });
      break;
    }

    case 'listini:equivalenti': {
      const [partNumber] = args;
      result = await runScenario({
        command,
        productAlias: 'LISTINI',
        methodName: 'GetListiniEquivalenti',
        contextXml: `<context><PartNumber>${xmlEscape(partNumber || '')}</PartNumber></context>`,
        parseResponse: (rawXml) => ({ items: parseEquivalentItems(rawXml) })
      });
      break;
    }

    case 'bdrt:search-rt-by-oe': {
      const [oePattern, top = '10'] = args;
      result = await runScenario({
        command,
        productAlias: 'BDRT',
        methodName: 'SearchRTByOe',
        contextXml: `
          <context>
            <Oe>${xmlEscape(oePattern || '')}</Oe>
            <Top>${xmlEscape(top)}</Top>
          </context>
        `,
        parseResponse: (rawXml) => ({ matches: parseSearchRtByOe(rawXml) })
      });
      break;
    }

    case 'bdrt:ricambi-by-oe': {
      const [idMar, idMod, idVer, oeCsv] = args;
      const oeList = String(oeCsv || '')
        .split(',')
        .map((item) => s(item))
        .filter(Boolean)
        .map((item) => `<OE>${xmlEscape(item)}</OE>`)
        .join('');
      result = await runScenario({
        command,
        productAlias: 'BDRT',
        methodName: 'GetRicambiByOE',
        contextXml: `
          <context>
            <Marca>${xmlEscape(idMar || '')}</Marca>
            <Modello>${xmlEscape(idMod || '')}</Modello>
            <Versione>${xmlEscape(idVer || '')}</Versione>
            <Oelist>${oeList}</Oelist>
          </context>
        `,
        parseResponse: (rawXml) => ({ matches: parseRicambiByOe(rawXml) })
      });
      break;
    }

    case 'bdrt:ricambi-dbrt': {
      const [idMar, idMod, idVer, idParCsv] = args;
      const idPars = String(idParCsv || '')
        .split(',')
        .map((item) => s(item))
        .filter(Boolean)
        .map((item) => `<int>${xmlEscape(item)}</int>`)
        .join('');
      result = await runScenario({
        command,
        productAlias: 'BDRT',
        methodName: 'GetRicambiDBRT',
        contextXml: `
          <context>
            <Marca>${xmlEscape(idMar || '')}</Marca>
            <Modello>${xmlEscape(idMod || '')}</Modello>
            <Versione>${xmlEscape(idVer || '')}</Versione>
            <Idpars>${idPars}</Idpars>
          </context>
        `,
        parseResponse: (rawXml) => ({ matches: parseRicambiDbrt(rawXml) })
      });
      break;
    }

    default:
      throw new Error(`Comando non riconosciuto: ${command}`);
  }

  console.log(JSON.stringify({
    ok: result.payload.response.ok,
    command: result.payload.command,
    product: result.payload.productName,
    method: result.payload.methodName,
    state: result.payload.response.state,
    parsed: result.payload.parsed,
    logFile: result.logFile
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message || String(error)
  }, null, 2));
  process.exitCode = 1;
});
