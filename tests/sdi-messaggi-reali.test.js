const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseSdiNotificationXml } = require('../src/services/sdi-notification-parser');
const { classifyDocument } = require('../src/services/sdi-document-classifier');

// Messaggi realmente ricevuti da SdI durante l'interoperabilita', estratti dal
// Sistema di Accreditamento. Sono verita' sul campo: se il codice non li legge
// correttamente, non li leggera' nemmeno in produzione.
//
// Il SdI usa due namespace distinti per gli stessi concetti:
//   flusso PA       http://www.fatturapa.gov.it/sdi/messaggi/v1.0
//   flusso B2B/B2C  http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fattura/messaggi/v1.0
// e in alcuni casi due nomi diversi per lo stesso documento
// (MetadatiInvioFile per la PA, FileMetadati per il B2B).

const DIR = path.join(__dirname, 'fixtures', 'sdi-messaggi');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');

const CAMPIONI = [
  { file: 'IT03365990591_00011_RC_004.xml', root: 'RicevutaConsegna', tipo: 'RICEVUTA_CONSEGNA', stato: 'consegnata', flusso: 'PA' },
  { file: 'IT03365990591_00011_NE_005.xml', root: 'NotificaEsito', tipo: 'NOTIFICA_ESITO', stato: 'esito', flusso: 'PA' },
  { file: 'IT03365990591_3900I_NS_001.xml', root: 'NotificaScarto', tipo: 'NOTIFICA_SCARTO', stato: 'scarto', flusso: 'PA' },
  { file: 'IT03365990591_00011_MT_001.xml', root: 'MetadatiInvioFile', tipo: 'METADATI_INVIO_FILE', stato: 'metadati_invio', flusso: 'PA' },
  { file: 'IT03365990591_00011_EC_001.xml', root: 'NotificaEsitoCommittente', tipo: 'NOTIFICA_ESITO_COMMITTENTE', stato: null, flusso: 'PA' },
  { file: 'IT03365990591_7D00E_NS_001.xml', root: 'RicevutaScarto', tipo: 'RICEVUTA_SCARTO', stato: 'scarto', flusso: 'B2B' },
  { file: 'IT03365990591_G000E_MC_004.xml', root: 'RicevutaImpossibilitaRecapito', tipo: 'RICEVUTA_IMPOSSIBILITA_RECAPITO', stato: 'UNDELIVERABLE', flusso: 'B2B' },
  { file: 'IT03365990591_G000E_MT_001.xml', root: 'FileMetadati', tipo: 'METADATI_INVIO_FILE', stato: 'metadati_invio', flusso: 'B2B' }
];

test('ogni messaggio reale viene classificato con il tipo corretto', () => {
  CAMPIONI.forEach(({ file, tipo }) => {
    const result = classifyDocument(Buffer.from(read(file), 'utf8'));
    assert.equal(result.type, tipo, `${file} classificato ${result.type} invece di ${tipo}`);
    assert.equal(result.isInvoice, false, `${file} non e una fattura`);
  });
});

test('ogni messaggio reale viene interpretato con radice e stato corretti', () => {
  CAMPIONI.filter((c) => c.stato).forEach(({ file, root, stato }) => {
    const parsed = parseSdiNotificationXml(read(file), { originalFilename: file });
    assert.equal(parsed.rootElement, root, `${file}: radice ${parsed.rootElement}`);
    assert.equal(parsed.statoNormalizzato, stato, `${file}: stato ${parsed.statoNormalizzato}`);
    assert.match(parsed.identificativoSdi || '', /^\d+$/, `${file}: IdentificativoSdI mancante`);
    assert.ok(parsed.nomeFileFattura, `${file}: NomeFile mancante`);
  });
});

test('la firma XAdES inclusa nel messaggio non confonde il parser', () => {
  // Tutti i messaggi SdI arrivano con ds:Signature enveloped: i valori estratti
  // devono venire dal messaggio, non dal blocco di firma.
  const parsed = parseSdiNotificationXml(read('IT03365990591_00011_RC_004.xml'));
  assert.equal(parsed.identificativoSdi, '32477881');
  assert.equal(parsed.nomeFileFattura, 'IT03365990591_00011.xml');
  assert.equal(parsed.destinatarioCodice, 'ESOJKL');
  assert.equal(parsed.destinatarioDescrizione, 'PA Simulata - Sogei');
  assert.equal(parsed.codiceErrore, null, 'una ricevuta di consegna non ha errori');
});

test('gli errori di scarto vengono estratti con codice, descrizione e suggerimento', () => {
  const pa = parseSdiNotificationXml(read('IT03365990591_3900I_NS_001.xml'));
  assert.equal(pa.codiceErrore, '00102');
  assert.match(pa.descrizioneErrore, /firma non valida/i);

  const b2b = parseSdiNotificationXml(read('IT03365990591_7D00E_NS_001.xml'));
  assert.equal(b2b.codiceErrore, '00305');
  assert.match(b2b.descrizioneErrore, /IdCodice.*non valido/i);
  assert.equal(b2b.errori.length, 1);
  assert.match(b2b.errori[0].suggerimento || '', /CessionarioCommittente/i);
});

test('la ricevuta di impossibilita recapito porta la data di messa a disposizione', () => {
  const parsed = parseSdiNotificationXml(read('IT03365990591_G000E_MC_004.xml'));
  assert.equal(parsed.statoNormalizzato, 'UNDELIVERABLE');
  assert.equal(parsed.subtype, 'B2X_IMPOSSIBILITA_RECAPITO');
  assert.equal(parsed.dataMessaADisposizione, '2026-08-07');
  assert.match(parsed.descrizione || '', /area riservata/i);
  assert.equal(parsed.hash, '62c80fd4c4af8f8e4a6c04e533bd8247145bc6c17ab6982e36bc7bc04a5522f4');
});

test('la notifica di esito PA espone l esito del committente', () => {
  const parsed = parseSdiNotificationXml(read('IT03365990591_00011_NE_005.xml'));
  assert.equal(parsed.esitoCommittente, 'EC01');
  assert.equal(parsed.identificativoSdi, '32477881');
});

test('i metadati portano codice destinatario, formato e tentativi di invio', () => {
  const pa = parseSdiNotificationXml(read('IT03365990591_00011_MT_001.xml'));
  assert.equal(pa.destinatarioCodice || pa.codiceDestinatario, 'ESOJKL');
  assert.equal(pa.formato, 'FPA12');
  assert.equal(pa.tentativiInvio, '1');

  const b2b = parseSdiNotificationXml(read('IT03365990591_G000E_MT_001.xml'));
  assert.equal(b2b.codiceDestinatario, 'XS00001');
  assert.equal(b2b.formato, 'FPR12');
  assert.equal(b2b.tentativiInvio, '1');
});

test('l esito committente che produciamo coincide con quello accettato dal SdI', () => {
  // Questo file e' quello che HORYGON ha inviato e che SdI ha accettato con ES01:
  // e' la verifica che il nostro generatore produce la struttura giusta.
  const { buildNotificaEsitoCommittenteXml } = require('../src/services/sdi-esito-committente');
  const nostro = buildNotificaEsitoCommittenteXml({
    identificativoSdi: '32477881',
    numeroFattura: 'ESOJKL-00011-1',
    annoFattura: '2017',
    posizioneFattura: '1',
    esito: 'EC01',
    messageIdCommittente: 'H0000012461174'
  });

  const atteso = read('IT03365990591_00011_EC_001.xml');
  const normalizza = (xml) => xml.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
  assert.equal(normalizza(nostro), normalizza(atteso), 'il documento generato deve coincidere con quello accettato');
});
