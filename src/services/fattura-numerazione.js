const db = require('../db/database');
const { getSetting } = require('./google');

// Numerazione fiscale delle fatture emesse.
//
// E' una cosa diversa dal `ProgressivoInvio` SdI, che e' un progressivo tecnico
// del file e vive in `sdi_progressivi`. Questo e' il numero contabile: deve
// essere progressivo e senza salti dentro l'anno, ed e' quello che il cliente
// e il commercialista vedono.
//
// Prima la fattura da ordine prendeva il codice dell'ordine come numero
// (`FAT-2026-RD-PREV-20260625-354`), per giunta troncato a venti caratteri.
// Non e' una numerazione: e' il nome di un'altra cosa.

// Il formato e' configurabile perche' le convenzioni cambiano da azienda ad
// azienda. Il default riproduce quello che c'e' gia' a sistema: il solo numero.
const PLACEHOLDER = /\{(numero|anno)\}/g;

function formatoNumerazione() {
  const configurato = String(getSetting('fatture.numerazione.formato', '{numero}') || '{numero}').trim();
  return configurato.includes('{numero}') ? configurato : '{numero}';
}

function applicaFormato(numero, anno) {
  return formatoNumerazione().replace(PLACEHOLDER, (_, campo) => (campo === 'anno' ? String(anno) : String(numero)));
}

function annoDi(data) {
  const testo = String(data || '').trim();
  const match = testo.match(/^(\d{4})-\d{2}-\d{2}$/);
  return match ? Number(match[1]) : new Date().getFullYear();
}

// Il progressivo si legge dalle fatture gia' emesse nello stesso anno.
//
// Si prende il primo gruppo di cifre del numero, cosi' la lettura regge sia
// "6" sia "6/2026" sia "FT-6": l'anno sta gia' nel filtro, e quello che conta
// e' il contatore. I numeri che non cominciano per cifra vengono ignorati,
// perche' non appartengono a nessuna serie.
function ultimoProgressivo(anno) {
  const rows = db.prepare(`
    SELECT numero
    FROM fatture
    WHERE tipo = 'emessa'
      AND numero IS NOT NULL
      AND substr(COALESCE(data, ''), 1, 4) = ?
  `).all(String(anno));
  let massimo = 0;
  for (const row of rows) {
    const match = String(row.numero).trim().match(/^(\d+)/);
    if (!match) continue;
    const valore = Number(match[1]);
    if (Number.isFinite(valore) && valore > massimo) massimo = valore;
  }
  return massimo;
}

// L'unicita' si cerca **dentro l'anno**, non su tutta la tabella.
//
// La numerazione riparte da uno a ogni esercizio: con il formato di default,
// che e' il solo numero, la fattura 1 del 2026 e la fattura 1 del 2027 sono
// due documenti diversi e legittimi. Cercare il numero ovunque farebbe
// ricominciare il 2027 da 6 solo perche' il 2026 e' arrivato a cinque.
function numeroGiaUsato(numero, anno) {
  return Boolean(db.prepare(`
    SELECT id FROM fatture
    WHERE numero = ? AND tipo = 'emessa' AND substr(COALESCE(data, ''), 1, 4) = ?
    LIMIT 1
  `).get(numero, String(anno)));
}

// Restituisce il prossimo numero libero della serie dell'anno.
//
// Non prenota niente: chi lo chiama lo scrive dentro la stessa transazione in
// cui inserisce la fattura. Con un solo utente che emette e' sufficiente, e
// non introduce uno stato da tenere allineato a mano come i progressivi SdI.
function nextNumeroFattura({ data = null } = {}) {
  const anno = annoDi(data);
  let progressivo = ultimoProgressivo(anno) + 1;
  let candidato = applicaFormato(progressivo, anno);
  // Un numero occupato da una fattura di un altro anno, o da una serie
  // scritta a mano, non deve produrre un duplicato.
  let tentativi = 0;
  while (numeroGiaUsato(candidato, anno) && tentativi < 10000) {
    progressivo += 1;
    candidato = applicaFormato(progressivo, anno);
    tentativi += 1;
  }
  return { numero: candidato, progressivo, anno };
}

module.exports = { annoDi, nextNumeroFattura, ultimoProgressivo };
