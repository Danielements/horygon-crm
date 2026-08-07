const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');
const { writeAudit } = require('./audit');
const { extractCmsContent, extractCmsCertificates } = require('./sdi-cades');

const ROOT = path.resolve(__dirname, '../../');

// Ciclo di firma esterna, per i dispositivi di firma qualificata remota che non
// espongono API server-to-server (per esempio FirmaOK di Poste, dove la chiave
// resta sui sistemi del certificatore e ogni firma va autorizzata con PIN e OTP).
//
//   XML generato -> scarica -> firma fuori dal CRM -> ricarica .p7m
//   -> verifica -> pronto per l'invio
//
// La verifica che conta e' il confronto fra l'XML estratto dal P7M e quello che
// il CRM aveva generato: senza, si potrebbe firmare un documento diverso da
// quello prodotto e il CRM lo assocerebbe alla fattura sbagliata.

const STATO_FIRMA_RICHIESTA = 'firma_richiesta';
const STATO_FIRMA_VERIFICATA = 'firma_verificata';

class SignedDocumentMismatchError extends Error {
  constructor(atteso, trovato) {
    super(
      'Il file firmato non corrisponde all XML generato dal CRM: '
      + `atteso SHA-256 ${atteso}, trovato ${trovato}`
    );
    this.name = 'SignedDocumentMismatchError';
    this.code = 'SIGNED_DOCUMENT_MISMATCH';
    this.atteso = atteso;
    this.trovato = trovato;
  }
}

function getFlow(flowId) {
  const flow = db.prepare('SELECT * FROM fatture_sdi_flussi WHERE id = ?').get(flowId);
  if (!flow) throw new Error(`Flusso SDI ${flowId} non trovato`);
  return flow;
}

// Restituisce l'XML da portare al dispositivo di firma.
function getDocumentToSign(flowId) {
  const flow = getFlow(flowId);
  if (flow.stato !== STATO_FIRMA_RICHIESTA) {
    throw new Error(`Il flusso ${flowId} non e in attesa di firma (stato: ${flow.stato})`);
  }
  const relative = flow.sdi_xml_immutabile_path || flow.xml_path;
  if (!relative) throw new Error(`Flusso ${flowId} senza XML da firmare`);
  const absolute = resolveInsideUploads(relative);
  if (!fs.existsSync(absolute)) throw new Error(`XML da firmare non trovato: ${relative}`);

  // Il nome proposto e' quello che SdI si aspettera' una volta firmato.
  return {
    flowId: flow.id,
    filename: flow.nome_file,
    signedFilename: `${String(flow.nome_file || '').replace(/\.p7m$/i, '')}.p7m`,
    xmlSha256: flow.sdi_xml_sha256,
    buffer: fs.readFileSync(absolute)
  };
}

// Verifica il file firmato senza scrivere nulla: usata sia dall'upload sia da
// un eventuale controllo preventivo.
function verifySignedFile({ signedBuffer, expectedXmlSha256, now = new Date() }) {
  if (!Buffer.isBuffer(signedBuffer) || !signedBuffer.length) {
    throw new Error('File firmato mancante o vuoto');
  }

  let extracted;
  try {
    extracted = extractCmsContent(signedBuffer);
  } catch (error) {
    throw new Error(`Il file caricato non e un P7M leggibile: ${error.message}`);
  }

  const extractedSha256 = sha256(extracted);
  if (expectedXmlSha256 && extractedSha256 !== expectedXmlSha256) {
    throw new SignedDocumentMismatchError(expectedXmlSha256, extractedSha256);
  }

  const certificates = extractCmsCertificates(signedBuffer).map((der) => {
    try {
      const certificate = new crypto.X509Certificate(der);
      return {
        subject: certificate.subject,
        issuer: certificate.issuer,
        serialNumber: certificate.serialNumber,
        validFrom: certificate.validFrom,
        validTo: certificate.validTo,
        expired: new Date(certificate.validTo).getTime() < new Date(now).getTime(),
        notYetValid: new Date(certificate.validFrom).getTime() > new Date(now).getTime()
      };
    } catch {
      return null;
    }
  }).filter(Boolean);

  const signer = certificates[0] || null;
  // SdI verifica scadenza, revoca e affidabilita' della CA (controlli 00100-00107).
  // Revoca e CA non sono verificabili in locale: la scadenza si', ed e' il caso
  // piu' frequente e piu' banale da evitare.
  if (signer?.expired) {
    throw new Error(`Il certificato di firma e scaduto il ${signer.validTo}: SdI scarterebbe con 00100`);
  }
  if (signer?.notYetValid) {
    throw new Error(`Il certificato di firma non e ancora valido (dal ${signer.validFrom})`);
  }

  return {
    ok: true,
    extractedXml: extracted,
    extractedSha256,
    signedSha256: sha256(signedBuffer),
    signer,
    certificates,
    // Quello che il CRM non puo' garantire da solo, e che restera' in capo a SdI.
    nonVerificabileInLocale: ['revoca del certificato', 'affidabilita della CA emittente']
  };
}

// Accetta il file firmato, lo archivia accanto all'originale e porta il flusso
// allo stato pronto per l'invio.
function attachSignedFile({ flowId, signedBuffer, filename = null, utenteId = null }) {
  const flow = getFlow(flowId);
  if (flow.stato === STATO_FIRMA_VERIFICATA) {
    throw new Error(`Il flusso ${flowId} ha gia un file firmato verificato`);
  }
  if (flow.stato !== STATO_FIRMA_RICHIESTA) {
    throw new Error(`Il flusso ${flowId} non e in attesa di firma (stato: ${flow.stato})`);
  }

  let verification;
  try {
    verification = verifySignedFile({ signedBuffer, expectedXmlSha256: flow.sdi_xml_sha256 });
  } catch (error) {
    audit('sdi.firma.rifiutata', {
      utenteId,
      fatturaId: flow.fattura_id,
      dettagli: { flowId, filename, errore: error.message, codice: error.code || null }
    });
    throw error;
  }

  const stored = persistSigned(flow, signedBuffer, filename);
  const meta = {
    ...parseJson(flow.firma_meta),
    modalita: 'esterna',
    formato: 'CAdES-BES',
    nome_file_caricato: filename || null,
    p7m_sha256: verification.signedSha256,
    xml_sha256: verification.extractedSha256,
    firmatario: verification.signer?.subject || null,
    emittente: verification.signer?.issuer || null,
    valido_fino: verification.signer?.validTo || null,
    verificato_il: new Date().toISOString()
  };

  db.prepare(`
    UPDATE fatture_sdi_flussi
    SET stato = ?,
        nome_file = ?,
        xml_path = ?,
        hash_file = ?,
        firma_applicata = 'CAdES-BES',
        firma_meta = ?,
        ultimo_evento_il = datetime('now')
    WHERE id = ?
  `).run(
    STATO_FIRMA_VERIFICATA,
    stored.filename,
    stored.relativePath,
    verification.signedSha256,
    JSON.stringify(meta),
    flow.id
  );

  if (flow.fattura_id) {
    db.prepare('UPDATE fatture SET stato_sdi = ? WHERE id = ?').run(STATO_FIRMA_VERIFICATA, flow.fattura_id);
  }

  audit('sdi.firma.verificata', {
    utenteId,
    fatturaId: flow.fattura_id,
    dettagli: { flowId, filename: stored.filename, firmatario: meta.firmatario, p7mSha256: meta.p7m_sha256 }
  });

  return {
    flowId: flow.id,
    filename: stored.filename,
    path: stored.relativePath,
    signer: verification.signer,
    certificates: verification.certificates,
    nonVerificabileInLocale: verification.nonVerificabileInLocale,
    stato: STATO_FIRMA_VERIFICATA
  };
}

function persistSigned(flow, signedBuffer, filename) {
  const base = String(flow.nome_file || filename || 'documento.xml').replace(/\.p7m$/i, '');
  const signedFilename = `${base}.p7m`;
  const dir = path.join(ROOT, 'uploads', 'sdi-outbound-firmati', new Date().toISOString().slice(0, 10).replace(/-/g, '/'));
  fs.mkdirSync(dir, { recursive: true });
  const hash = sha256(signedBuffer);
  const absolute = path.join(dir, `${hash}_${signedFilename}`);
  if (!fs.existsSync(absolute)) fs.writeFileSync(absolute, signedBuffer);
  return {
    filename: signedFilename,
    relativePath: `/${path.relative(ROOT, absolute).replace(/\\/g, '/')}`
  };
}

function resolveInsideUploads(relative) {
  const clean = String(relative || '').replace(/^[/\\]+/, '');
  const absolute = path.resolve(ROOT, clean);
  const uploads = path.resolve(ROOT, 'uploads');
  if (!absolute.startsWith(uploads + path.sep)) throw new Error('Percorso XML non valido');
  return absolute;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function audit(azione, { utenteId, fatturaId, dettagli }) {
  try {
    writeAudit({ utente_id: utenteId, azione, entita_tipo: 'fattura', entita_id: fatturaId || null, dettagli });
  } catch {}
}

module.exports = {
  STATO_FIRMA_RICHIESTA,
  STATO_FIRMA_VERIFICATA,
  SignedDocumentMismatchError,
  attachSignedFile,
  getDocumentToSign,
  verifySignedFile
};
