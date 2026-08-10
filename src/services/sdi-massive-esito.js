const { XMLParser } = require('fast-xml-parser');

// Lettura del file di esito restituito da esitoRichiesta.
//
// Il tracciato e' descritto in "Specifiche tecniche del formato dei file
// utilizzati dai Servizi Massivi" v1.5 par. 1.2, che rimanda a
// ScaricoRichiesteEsito_v1.0.xsd. Quello schema non e' fra i contratti
// pubblicati insieme al WSDL: qui si segue la tabella della specifica, e i
// campi ignoti vengono conservati invece che scartati.
//
// Senza questo passaggio il backfill si ferma: gli IdFile da passare a
// scaricoFile esistono solo dentro questo file, non nella risposta SOAP.

// TipoElementi ammessi dalla specifica. Per il backfill fatture interessa solo
// "Fatt": gli altri archivi appartengono a servizi diversi (corrispettivi,
// bollo, registri IVA) e vanno riconosciuti per poterli ignorare di proposito.
const TIPI_ELEMENTI = {
  Fatt: 'fatture',
  Corr: 'corrispettivi',
  Bollo_a: 'bollo elenco A',
  Bollo_b: 'bollo elenco B',
  IVA_REGI: 'registri IVA',
  IVA_PROS: 'prospetti IVA',
  IVA_DICH: 'dichiarazioni IVA annuali',
  FATT_ELENCO_VIDIMAZIONI_RSM: 'dati di sintesi fatture RSM'
};

function parseEsitoRichiestaFile(buffer) {
  const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'utf8');
  if (!content.length) throw new Error('File di esito vuoto');

  // Un archivio ZIP al posto dell'XML significa che si sta leggendo la cosa
  // sbagliata: meglio dirlo che fallire piu' avanti con un errore di parsing.
  if (content[0] === 0x50 && content[1] === 0x4b) {
    throw new Error('Il file di esito e un archivio ZIP, non l XML EsitoRichiesta atteso');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true
  });

  let parsed;
  try {
    parsed = parser.parse(content.toString('utf8'));
  } catch (error) {
    throw new Error(`File di esito non parsabile: ${error.message}`);
  }

  const root = parsed?.EsitoRichiesta || findNode(parsed, 'EsitoRichiesta');
  if (!root) throw new Error('File di esito senza elemento EsitoRichiesta');

  const esito = root.Esito || {};
  const archivi = toArray(esito?.ElencoArchivi?.Archivio).map(describeArchivio).filter(Boolean);
  const errori = toArray(esito?.ElencoErrori?.Errore).map((errore) => ({
    codice: text(errore?.Codice),
    descrizione: text(errore?.Descrizione)
  })).filter((errore) => errore.codice || errore.descrizione);

  const numeroArchivi = integer(root.NumeroArchivi);
  return {
    versione: text(root['@_versione']) || null,
    idRichiesta: text(root.IdRichiesta),
    piva: text(root.Piva),
    // Oltre questa data la richiesta non e' piu' interrogabile e gli archivi
    // non sono piu' scaricabili: e' la scadenza del job, non un dettaglio.
    dataFineDisponibilita: text(root.DataFineDisponibilita),
    numeroArchivi,
    numeroErrori: integer(root.NumeroErrori),
    archivi,
    errori,
    // Il conteggio dichiarato e quello effettivo devono coincidere: se non
    // coincidono si scaricherebbe meno di quanto prodotto senza accorgersene.
    conteggioCoerente: numeroArchivi === null || numeroArchivi === archivi.length
  };
}

function describeArchivio(archivio) {
  if (!archivio || typeof archivio !== 'object') return null;
  const idFile = text(archivio.IdFile);
  if (!idFile) return null;
  const tipo = text(archivio.TipoElementi);
  return {
    idFile,
    nomeFile: text(archivio.NomeFile),
    dimensioneFile: integer(archivio.DimensioneFile),
    tipoElementi: tipo,
    tipoElementiDescrizione: tipo ? (TIPI_ELEMENTI[tipo] || 'tipologia non documentata') : null,
    numeroElementi: integer(archivio.NumeroElementi),
    fatture: tipo === 'Fatt'
  };
}

// Un archivio per richiesta contiene una sola tipologia di elementi (par. 1.2):
// per il backfill fatture il resto va lasciato dov'e'.
function selectInvoiceArchives(esito) {
  return (esito?.archivi || []).filter((archivio) => archivio.fatture);
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function findNode(source, key) {
  if (!source || typeof source !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  for (const value of Object.values(source)) {
    const found = findNode(value, key);
    if (found) return found;
  }
  return null;
}

function text(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return null;
  const clean = String(value).trim();
  return clean || null;
}

function integer(value) {
  const clean = text(value);
  if (clean === null) return null;
  const parsed = Number.parseInt(clean, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = {
  TIPI_ELEMENTI,
  parseEsitoRichiestaFile,
  selectInvoiceArchives
};
