const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');
const { writeSystemLog } = require('../services/system-log');
const { generateOutboundXmlForInvoice } = require('../services/sdi-fatturapa');
const { transmitInvoiceToSdiTest } = require('../services/sdi-transmission');
const { buildRiceviFattureResponse, processInboundSdiRequest } = require('../services/sdi-soap-inbound');
const { receiveSdiNotificationXml } = require('../services/sdi-inbound');
const { importInvoiceXml } = require('../services/fattura-import');
const { XMLParser } = require('fast-xml-parser');

const ROOT = path.resolve(__dirname, '../../');
const INBOUND_DIR = path.join(ROOT, 'uploads', 'sdi-inbound');

const xmlTextParser = express.raw({
  type: ['application/xml', 'text/xml', 'application/soap+xml', 'multipart/related', 'text/plain'],
  limit: '30mb'
});

router.get('/ws/inbound', (req, res) => {
  if ('wsdl' in (req.query || {})) {
    const wsdl = readInboundWsdl(req);
    res.type('application/wsdl+xml').send(wsdl);
    return;
  }
  res.json({
    ok: true,
    service: 'sdi-ws-inbound',
    endpoint: `${getPublicBaseUrl(req)}/api/sdi/ws/inbound`,
    wsdl: `${getPublicBaseUrl(req)}/api/sdi/ws/inbound?wsdl`,
    accepts: ['application/xml', 'text/xml', 'application/soap+xml'],
    modes: ['fattura-passiva', 'notifica-sdi']
  });
});

router.post('/ws/inbound', xmlTextParser, (req, res) => {
  try {
    const result = processInboundSdiRequest(req);
    if (result.responseKind === 'ricevi_fatture_er01') {
      res
        .set('Content-Type', 'text/xml; charset="utf-8"')
        .status(200)
        .send(buildRiceviFattureResponse(result.soapVersion));
      return;
    }
    res.status(200).end();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    writeSystemLog({
      livello: 'error',
      origine: 'sdi.ws.inbound',
      route: '/api/sdi/ws/inbound',
      metodo: 'POST',
      messaggio: 'sdi.soap.parse_failed',
      stack: err.stack || null,
      dettagli: {
        errorName: err.name,
        errorMessage: err.message,
        cause: err.cause ? String(err.cause.message || err.cause) : null
      }
    });
    res.status(400).end();
  }
});

router.use(authMiddleware);

router.get('/flows', requirePermesso('fatture', 'read'), (req, res) => {
  const rows = db.prepare(`
    SELECT
      fl.*,
      f.numero,
      f.data,
      f.totale,
      a.ragione_sociale
    FROM fatture_sdi_flussi fl
    LEFT JOIN fatture f ON f.id = fl.fattura_id
    LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    ORDER BY fl.creato_il DESC
    LIMIT 100
  `).all();
  res.json(rows);
});

router.get('/notifications', requirePermesso('fatture', 'read'), (req, res) => {
  const rows = db.prepare(`
    SELECT
      n.*,
      f.numero,
      f.data,
      a.ragione_sociale
    FROM fatture_sdi_notifiche n
    LEFT JOIN fatture f ON f.id = n.fattura_id
    LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    ORDER BY n.creato_il DESC
    LIMIT 100
  `).all();
  res.json(rows);
});

router.post('/fatture/:id/test-send', requirePermesso('fatture', 'edit'), async (req, res) => {
  try {
    const result = await generateOutboundXmlForInvoice(req.params.id, { mode: 'test' });
    writeAudit({
      utente_id: req.user.id,
      azione: 'sdi.fattura.test_send',
      entita_tipo: 'fattura',
      entita_id: Number(req.params.id),
      dettagli: {
        flowId: result.flowId,
        filename: result.filename,
        xmlPath: result.xmlPath
      }
    });
    writeSystemLog({
      livello: 'info',
      origine: 'sdi.test-send',
      route: `/api/sdi/fatture/${req.params.id}/test-send`,
      metodo: 'POST',
      utente_id: req.user.id,
      messaggio: `XML SDI generato in modalita test per fattura ${req.params.id}`,
      dettagli: {
        flowId: result.flowId,
        filename: result.filename,
        xmlPath: result.xmlPath,
        hash: result.hash
      }
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    writeSystemLog({
      livello: 'error',
      origine: 'sdi.test-send',
      route: `/api/sdi/fatture/${req.params.id}/test-send`,
      metodo: 'POST',
      utente_id: req.user.id,
      messaggio: error.message,
      stack: error.stack || null
    });
    res.status(400).json({ error: error.message });
  }
});

router.post('/fatture/:id/test-transmit', requirePermesso('fatture', 'edit'), async (req, res) => {
  try {
    const result = await transmitInvoiceToSdiTest(req.params.id);
    writeAudit({
      utente_id: req.user.id,
      azione: 'sdi.fattura.test_transmit',
      entita_tipo: 'fattura',
      entita_id: Number(req.params.id),
      dettagli: {
        flowId: result.flowId,
        filename: result.filename,
        xmlPath: result.xmlPath,
        endpoint: result.transmission.endpoint,
        statusCode: result.transmission.statusCode,
        identificativoSdi: result.transmission.identificativoSdi
      }
    });
    writeSystemLog({
      livello: result.transmission.success ? 'info' : 'error',
      origine: 'sdi.test-transmit',
      route: `/api/sdi/fatture/${req.params.id}/test-transmit`,
      metodo: 'POST',
      utente_id: req.user.id,
      messaggio: result.transmission.success
        ? `Fattura trasmessa a SDI TEST: ${result.transmission.identificativoSdi || result.filename}`
        : `Invio SDI TEST fallito: ${result.transmission.statusCode}`,
      dettagli: {
        flowId: result.flowId,
        filename: result.filename,
        xmlPath: result.xmlPath,
        hash: result.hash,
        transmission: result.transmission
      }
    });
    const status = result.transmission.success ? 200 : 502;
    res.status(status).json({ ok: result.transmission.success, ...result });
  } catch (error) {
    writeSystemLog({
      livello: 'error',
      origine: 'sdi.test-transmit',
      route: `/api/sdi/fatture/${req.params.id}/test-transmit`,
      metodo: 'POST',
      utente_id: req.user.id,
      messaggio: error.message,
      stack: error.stack || null
    });
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;

function getPublicBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function readInboundWsdl(req) {
  const requested = String(req.query.wsdl || 'ricezione').trim().toLowerCase();
  const filename = ['trasmissione', 'notifiche', 'notifications'].includes(requested)
    ? path.join(ROOT, 'resources', 'sdi', 'wsdl', 'TrasmissioneFatture_v1.1.wsdl')
    : path.join(ROOT, 'resources', 'sdi', 'wsdl', 'RicezioneFatture_v1.0.wsdl');
  const location = `${getPublicBaseUrl(req)}/api/sdi/ws/inbound`;
  return fs.readFileSync(filename, 'utf8')
    .replace(/<soapbind:address\s+location="[^"]*"\s*\/>/i, `<soapbind:address location="${xmlEscape(location)}" />`);
}

function buildInboundWsdl(req) {
  const location = `${getPublicBaseUrl(req)}/api/sdi/ws/inbound`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions name="RicezioneFatture"
  targetNamespace="http://www.fatturapa.gov.it/sdi/ws/ricezione/v1.0/types"
  xmlns:tns="http://www.fatturapa.gov.it/sdi/ws/ricezione/v1.0/types"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/">
  <types>
    <xsd:schema targetNamespace="http://www.fatturapa.gov.it/sdi/ws/ricezione/v1.0/types">
      <xsd:element name="fileSdIConMetadati" type="xsd:string"/>
      <xsd:element name="rispostaRiceviFatture">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="Esito" type="xsd:string"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
    </xsd:schema>
  </types>
  <message name="RiceviFattureRequest">
    <part name="parameters" element="tns:fileSdIConMetadati"/>
  </message>
  <message name="RiceviFattureResponse">
    <part name="parameters" element="tns:rispostaRiceviFatture"/>
  </message>
  <portType name="RicezioneFatturePortType">
    <operation name="RiceviFatture">
      <input message="tns:RiceviFattureRequest"/>
      <output message="tns:RiceviFattureResponse"/>
    </operation>
  </portType>
  <binding name="RicezioneFattureBinding" type="tns:RicezioneFatturePortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="RiceviFatture">
      <soap:operation soapAction="http://www.fatturapa.it/RicezioneFatture/RiceviFattureSdI"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>
  </binding>
  <service name="RicezioneFattureService">
    <port name="RicezioneFatturePort" binding="tns:RicezioneFattureBinding">
      <soap:address location="${xmlEscape(location)}"/>
    </port>
  </service>
</definitions>`;
}

function unwrapInboundEnvelope(xml) {
  const raw = String(xml || '').trim();
  const withoutXmlDeclaration = raw.replace(/^\uFEFF?/, '').replace(/^<\?xml[^>]*>\s*/i, '');
  const isSoapEnvelope = /^<[\w:-]*Envelope\b/i.test(withoutXmlDeclaration)
    || /http:\/\/schemas\.xmlsoap\.org\/soap\/envelope\//i.test(raw)
    || /http:\/\/www\.w3\.org\/2003\/05\/soap-envelope/i.test(raw);
  if (!isSoapEnvelope) {
    return { payloadXml: raw, isSoap: false };
  }
  const bodyMatch = withoutXmlDeclaration.match(/<[\w:-]*Body\b[^>]*>([\s\S]*?)<\/[\w:-]*Body>/i);
  const bodyContent = bodyMatch ? bodyMatch[1].trim() : withoutXmlDeclaration;
  const cdataMatch = bodyContent.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
  if (cdataMatch) return { payloadXml: cdataMatch[1].trim(), isSoap: true };
  const parsedBodyPayload = extractSoapBodyWithParser(withoutXmlDeclaration);
  if (parsedBodyPayload) return { payloadXml: parsedBodyPayload, isSoap: true };
  const xmlStart = bodyContent.search(/<\??(?:xml|[A-Za-z_])/i);
  if (xmlStart >= 0) return { payloadXml: bodyContent.slice(xmlStart).trim(), isSoap: true };
  return { payloadXml: bodyContent, isSoap: true };
}

function extractWrappedInboundPayload(bodyXml) {
  const raw = String(bodyXml || '').trim();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true
  });
  try {
    const parsed = parser.parse(raw);
    const rootKey = Object.keys(parsed || {}).find((key) => key !== '?xml') || '';
    const rootNode = rootKey ? parsed[rootKey] : null;
    if (rootKey === 'Envelope') {
      const envelope = unwrapInboundEnvelope(raw);
      if (envelope.isSoap && envelope.payloadXml !== raw) return extractWrappedInboundPayload(envelope.payloadXml);
    }
    if (rootKey === 'fileSdIConMetadati' && rootNode && typeof rootNode === 'object') {
      const fileContent = decodeBase64Xml(rootNode.File);
      const metadataXml = decodeBase64Xml(rootNode.Metadati);
      return {
        operationName: rootKey,
        fileName: rootNode.NomeFile || null,
        payloadXml: fileContent || raw,
        metadataXml: metadataXml || null,
        metadataFileName: rootNode.NomeFileMetadati || null
      };
    }
  } catch {}
  return {
    operationName: detectRootElement(raw),
    fileName: null,
    payloadXml: raw,
    metadataXml: null,
    metadataFileName: null
  };
}

function detectRootElement(xml) {
  const match = String(xml || '').trim().match(/^<\??xml[^>]*>\s*<([\w:-]+)|^<([\w:-]+)/i);
  const root = match ? (match[1] || match[2] || '') : '';
  return root.includes(':') ? root.split(':').pop() : root;
}

function isInvoiceRoot(rootElement) {
  return ['FatturaElettronica', 'FatturaElettronicaSemplificata'].includes(String(rootElement || '').trim());
}

function extractSoapBodyWithParser(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    preserveOrder: true,
    trimValues: false
  });
  try {
    const parsed = parser.parse(xml);
    const envelopeNode = findOrderedNode(parsed, 'Envelope');
    const bodyNode = findOrderedNode(envelopeNode?.Envelope, 'Body');
    const bodyChildren = bodyNode?.Body;
    if (!Array.isArray(bodyChildren)) return null;
    const payloadNode = bodyChildren.find((node) => {
      const key = node && typeof node === 'object' ? Object.keys(node).find((k) => !k.startsWith(':@')) : null;
      return key && key !== '#text';
    });
    if (!payloadNode) return null;
    return buildXmlFromOrderedNode(payloadNode).trim();
  } catch {
    return null;
  }
}

function findOrderedNode(nodes, localName) {
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const key = Object.keys(node).find((k) => stripPrefix(k) === localName);
    if (key) return { [localName]: node[key], attributes: node[':@'] || {} };
  }
  return null;
}

function buildXmlFromOrderedNode(node) {
  const key = Object.keys(node).find((k) => !k.startsWith(':@'));
  if (!key) return '';
  const attrs = node[':@'] || {};
  const attrText = Object.entries(attrs)
    .map(([name, value]) => ` ${name.replace(/^@_/, '')}="${xmlEscape(value)}"`)
    .join('');
  const children = node[key];
  if (!Array.isArray(children)) return `<${key}${attrText}>${xmlEscape(children || '')}</${key}>`;
  const inner = children.map((child) => {
    if (child && typeof child === 'object' && Object.prototype.hasOwnProperty.call(child, '#text')) {
      return xmlEscape(child['#text']);
    }
    return buildXmlFromOrderedNode(child);
  }).join('');
  return `<${key}${attrText}>${inner}</${key}>`;
}

function stripPrefix(name) {
  return String(name || '').includes(':') ? String(name).split(':').pop() : String(name || '');
}

function persistInboundXml(xml, originalFilename) {
  const now = new Date();
  const dayDir = path.join(
    INBOUND_DIR,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0')
  );
  if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true });
  const filenameBase = sanitizeFilePart(originalFilename || detectRootElement(xml) || 'sdi-inbound');
  const hash = require('crypto').createHash('sha256').update(Buffer.from(String(xml), 'utf8')).digest('hex');
  const absolutePath = path.join(dayDir, `${hash}_${filenameBase}.xml`);
  if (!fs.existsSync(absolutePath)) fs.writeFileSync(absolutePath, xml, 'utf8');
  return {
    absolutePath,
    relativePath: `/${path.relative(ROOT, absolutePath).replace(/\\/g, '/')}`,
    sha256: hash
  };
}

function sanitizeFilePart(value) {
  return String(value || '')
    .trim()
    .replace(/\.xml$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'file';
}

function respondInboundSuccess(req, res, result) {
  const soapVersion = detectSoapVersion(req);
  const responseBody = buildSoapAck('OK', result.kind === 'invoice' ? 'Fattura acquisita' : 'Messaggio acquisito', soapVersion, result.operationName);
  const contentType = soapVersion === '1.2' ? 'application/soap+xml; charset="utf-8"' : 'text/xml; charset="utf-8"';
  writeSystemLog({
    livello: 'info',
    origine: 'sdi.ws.inbound',
    route: '/api/sdi/ws/inbound',
    metodo: 'POST',
    messaggio: 'Risposta SDI inviata',
    dettagli: {
      contentType,
      soapVersion,
      operationName: result.operationName || null,
      esito: 'ER01',
      responseBytes: Buffer.byteLength(responseBody, 'utf8'),
      responseBody
    }
  });
  res
    .set('Content-Type', contentType)
    .status(200)
    .send(responseBody);
}

function respondInboundError(req, res, error) {
  const soapVersion = detectSoapVersion(req);
  const responseBody = buildSoapAck('KO', error.message || 'Errore endpoint SDI', soapVersion);
  const contentType = soapVersion === '1.2' ? 'application/soap+xml; charset="utf-8"' : 'text/xml; charset="utf-8"';
  res
    .set('Content-Type', contentType)
    .status(500)
    .send(responseBody);
}

function detectSoapVersion(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  const body = String(req.body || '');
  if (contentType.includes('application/soap+xml')) return '1.2';
  if (body.includes('http://www.w3.org/2003/05/soap-envelope')) return '1.2';
  return '1.1';
}

function buildSoapAck(esito, messaggio, soapVersion = '1.1', operationName = null) {
  const envelopeNs = soapVersion === '1.2'
    ? 'http://www.w3.org/2003/05/soap-envelope'
    : 'http://schemas.xmlsoap.org/soap/envelope/';
  const responseNs = 'http://www.fatturapa.gov.it/sdi/ws/ricezione/v1.0/types';
  return `<soap:Envelope xmlns:soap="${envelopeNs}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:ns1="${responseNs}"><soap:Body><ns1:rispostaRiceviFatture><Esito>ER01</Esito></ns1:rispostaRiceviFatture></soap:Body></soap:Envelope>`;
}

function decodeBase64Xml(value) {
  const clean = String(value || '').trim();
  if (!clean) return null;
  try {
    return Buffer.from(clean, 'base64').toString('utf8').trim();
  } catch {
    return null;
  }
}

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
