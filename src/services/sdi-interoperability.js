const db = require('../db/database');

const CALLBACK_BY_NOTIFICATION = {
  RicevutaConsegna: 'RicevutaConsegna',
  RicevutaScarto: 'RicevutaScarto',
  NotificaScarto: 'NotificaScarto',
  NotificaMancataConsegna: 'NotificaMancataConsegna',
  RicevutaImpossibilitaRecapito: 'RicevutaImpossibilitaRecapito',
  NotificaDecorrenzaTermini: 'NotificaDecorrenzaTermini',
  AttestazioneTrasmissioneFattura: 'AttestazioneTrasmissioneFattura',
  NotificaEsito: 'NotificaEsito'
};

function registerOutboundTransmission({ flow, invoice, customer, payloadMeta = {}, transmission = {} }) {
  const testName = inferTestName(invoice?.numero || invoice?.numero_documento, customer?.codice_destinatario, payloadMeta);
  if (!testName) return null;
  const existing = findByFlow(flow.id);
  const data = {
    test_name: testName,
    fattura_id: flow.fattura_id || invoice?.id || null,
    flow_id: flow.id,
    nome_file: flow.nome_file || transmission.filename || null,
    progressivo_invio: payloadMeta.progressivo_invio || null,
    codice_destinatario: payloadMeta.codice_destinatario || customer?.codice_destinatario || null,
    identificativo_sdi: transmission.identificativoSdi || flow.identificativo_sdi || null,
    data_invio: new Date().toISOString(),
    callback_atteso: inferExpectedCallback(testName),
    stato_portale: null,
    note: payloadMeta.note || null,
    payload_meta: JSON.stringify({ payloadMeta, transmission })
  };
  return existing ? updateRow(existing.id, data) : insertRow(data);
}

function updateInteroperabilityCallback({ flow, parsed, soapAction, contentType, isMtom, httpStatus = 200 }) {
  if (!flow && !parsed?.identificativoSdi) return null;
  const existing = flow?.id ? findByFlow(flow.id) : findBySdi(parsed.identificativoSdi);
  if (!existing) return null;
  const callback = CALLBACK_BY_NOTIFICATION[parsed.tipoNotifica] || parsed.tipoNotifica || null;
  return updateRow(existing.id, {
    identificativo_sdi: parsed.identificativoSdi || existing.identificativo_sdi || null,
    callback_ricevuto: callback,
    soap_action: soapAction || null,
    content_type: contentType || null,
    is_mtom: isMtom ? 1 : 0,
    http_status: httpStatus,
    payload_meta: JSON.stringify({
      ...(parseJsonObject(existing.payload_meta)),
      callback: parsed
    })
  });
}

function registerManualInteroperabilityTest(data) {
  const existing = data.flow_id ? findByFlow(data.flow_id) : null;
  return existing ? updateRow(existing.id, data) : insertRow(data);
}

function inferTestName(numero, codiceDestinatario, payloadMeta = {}) {
  const n = String(numero || '').trim().toUpperCase();
  const code = String(codiceDestinatario || payloadMeta.codice_destinatario || '').trim().toUpperCase();
  if (n.startsWith('TEST-MC-001')) return 'Mancata consegna / impossibilita recapito';
  if (n.startsWith('TEST-DT-001')) return 'Decorrenza termini';
  if (n.startsWith('TEST-AT-001')) return 'Attestazione avvenuta trasmissione';
  if (n.startsWith('TEST-EC-KO-001')) return 'Scarto esito PA';
  if (code === 'XS0000' || code === 'XS00001') return 'Mancata consegna / attestazione';
  return null;
}

function inferExpectedCallback(testName) {
  const normalized = String(testName || '').toLowerCase();
  if (normalized.includes('mancata') || normalized.includes('impossibilita')) return 'NotificaMancataConsegna/RicevutaImpossibilitaRecapito';
  if (normalized.includes('attestazione')) return 'AttestazioneTrasmissioneFattura';
  if (normalized.includes('decorrenza')) return 'NotificaDecorrenzaTermini';
  if (normalized.includes('scarto esito')) return 'ScartoEsito';
  return null;
}

function findByFlow(flowId) {
  return db.prepare('SELECT * FROM sdi_interoperability_tests WHERE flow_id = ? ORDER BY id DESC LIMIT 1').get(flowId);
}

function findBySdi(identificativoSdi) {
  return db.prepare('SELECT * FROM sdi_interoperability_tests WHERE identificativo_sdi = ? ORDER BY id DESC LIMIT 1').get(identificativoSdi);
}

function insertRow(data) {
  const result = db.prepare(`
    INSERT INTO sdi_interoperability_tests (
      test_name, fattura_id, flow_id, nome_file, progressivo_invio, codice_destinatario,
      identificativo_sdi, data_invio, callback_atteso, callback_ricevuto, soap_action,
      content_type, is_mtom, http_status, stato_portale, note, payload_meta, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `).run(
    data.test_name,
    data.fattura_id || null,
    data.flow_id || null,
    data.nome_file || null,
    data.progressivo_invio || null,
    data.codice_destinatario || null,
    data.identificativo_sdi || null,
    data.data_invio || null,
    data.callback_atteso || null,
    data.callback_ricevuto || null,
    data.soap_action || null,
    data.content_type || null,
    data.is_mtom ? 1 : 0,
    data.http_status || null,
    data.stato_portale || null,
    data.note || null,
    data.payload_meta || null
  );
  return Number(result.lastInsertRowid);
}

function updateRow(id, data) {
  const current = db.prepare('SELECT * FROM sdi_interoperability_tests WHERE id = ?').get(id);
  const next = { ...current, ...data };
  db.prepare(`
    UPDATE sdi_interoperability_tests
    SET test_name=?,
        fattura_id=?,
        flow_id=?,
        nome_file=?,
        progressivo_invio=?,
        codice_destinatario=?,
        identificativo_sdi=?,
        data_invio=?,
        callback_atteso=?,
        callback_ricevuto=?,
        soap_action=?,
        content_type=?,
        is_mtom=?,
        http_status=?,
        stato_portale=?,
        note=?,
        payload_meta=?,
        updated_at=datetime('now')
    WHERE id=?
  `).run(
    next.test_name,
    next.fattura_id || null,
    next.flow_id || null,
    next.nome_file || null,
    next.progressivo_invio || null,
    next.codice_destinatario || null,
    next.identificativo_sdi || null,
    next.data_invio || null,
    next.callback_atteso || null,
    next.callback_ricevuto || null,
    next.soap_action || null,
    next.content_type || null,
    next.is_mtom ? 1 : 0,
    next.http_status || null,
    next.stato_portale || null,
    next.note || null,
    next.payload_meta || null,
    id
  );
  return id;
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = {
  inferTestName,
  registerManualInteroperabilityTest,
  registerOutboundTransmission,
  updateInteroperabilityCallback
};
