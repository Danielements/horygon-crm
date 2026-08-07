const db = require('../db/database');
const { getSetting } = require('./google');

// Specifiche tecniche SdI 1.8.4 par. 2.2: il progressivo univoco del file e' una
// stringa alfanumerica di lunghezza massima 5 caratteri con valori ammessi
// [a-z][A-Z][0-9], e "ogni file inviato al Sistema di Interscambio deve avere un
// nome diverso da qualsiasi altro file inviato in precedenza". Un nome gia' usato
// viene rifiutato con il controllo 00002 (Nome file duplicato), in modo definitivo.
//
// La sequenza e' unica per tutti gli ambienti: test e produzione condividono lo
// stesso contatore, cosi' un file di test non puo' mai bruciare un nome che
// servirebbe in produzione (e viceversa).

const SEQUENCE_KEY = 'outbound_file';
const PROGRESSIVO_LENGTH = 5;
const ALPHABET_SIZE = 36;

function allocateOutboundProgressivo() {
  const prefix = normalizePrefix(getSetting('sdi.progressivo.prefix', 'H'));
  const digits = PROGRESSIVO_LENGTH - prefix.length;
  const capacity = ALPHABET_SIZE ** digits;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const counter = nextSequenceValue();
    if (counter >= capacity) {
      throw new Error(
        `Sequenza progressivi SDI esaurita per il prefisso "${prefix}" (capienza ${capacity}). `
        + 'Cambiare sdi.progressivo.prefix per ripartire con un nuovo spazio di nomi.'
      );
    }
    const progressivo = `${prefix}${encodeBase36(counter, digits)}`;
    if (!isProgressivoAlreadyUsed(progressivo)) return progressivo;
  }
  throw new Error('Impossibile allocare un progressivo SDI libero dopo 50 tentativi');
}

function nextSequenceValue() {
  const start = toNonNegativeInteger(getSetting('sdi.progressivo.start', '1'), 1);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT valore FROM sdi_progressivi WHERE chiave = ?').get(SEQUENCE_KEY);
    const next = current ? Number(current.valore) + 1 : start;
    if (current) {
      db.prepare("UPDATE sdi_progressivi SET valore = ?, aggiornato_il = datetime('now') WHERE chiave = ?").run(next, SEQUENCE_KEY);
    } else {
      db.prepare("INSERT INTO sdi_progressivi (chiave, valore, aggiornato_il) VALUES (?,?,datetime('now'))").run(SEQUENCE_KEY, next);
    }
    db.exec('COMMIT');
    return next;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

// Rete di sicurezza contro i nomi generati prima dell'introduzione della sequenza
// (progressivi derivati da timestamp, quindi non prevedibili dal contatore).
function isProgressivoAlreadyUsed(progressivo) {
  const row = db.prepare(`
    SELECT 1
    FROM fatture_sdi_flussi
    WHERE direzione = 'outbound'
      AND tipo_messaggio = 'fattura'
      AND (nome_file LIKE ? OR nome_file LIKE ?)
    LIMIT 1
  `).get(`%\\_${progressivo}.xml`, `%\\_${progressivo}.xml.p7m`);
  return Boolean(row);
}

function peekOutboundSequence() {
  const row = db.prepare('SELECT valore, aggiornato_il FROM sdi_progressivi WHERE chiave = ?').get(SEQUENCE_KEY);
  const prefix = normalizePrefix(getSetting('sdi.progressivo.prefix', 'H'));
  const digits = PROGRESSIVO_LENGTH - prefix.length;
  return {
    prefix,
    lastValue: row ? Number(row.valore) : null,
    lastProgressivo: row ? `${prefix}${encodeBase36(Number(row.valore), digits)}` : null,
    capacity: ALPHABET_SIZE ** digits,
    updatedAt: row?.aggiornato_il || null
  };
}

function normalizePrefix(value) {
  const prefix = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (prefix.length >= PROGRESSIVO_LENGTH) {
    throw new Error(`sdi.progressivo.prefix deve essere piu corto di ${PROGRESSIVO_LENGTH} caratteri`);
  }
  return prefix;
}

function encodeBase36(value, digits) {
  return Number(value).toString(36).toUpperCase().padStart(digits, '0');
}

function toNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

module.exports = {
  PROGRESSIVO_LENGTH,
  allocateOutboundProgressivo,
  encodeBase36,
  normalizePrefix,
  peekOutboundSequence
};
