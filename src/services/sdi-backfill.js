const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const db = require('../db/database');
const { extractTo } = require('./safe-zip-reader');
const { importDocument } = require('./sdi-import-pipeline');
const {
  buildMassiveRequestFilename,
  buildMassiveRequestXml,
  buildRichiestaServiziMassiviXml,
  getMassiveSigningStatus,
  signMassiveRequest,
  verifySignedMassiveRequest
} = require('./sdi-massive-request');
const {
  audit: auditJob,
  getFiscalConfiguration,
  getJob,
  recordItem,
  refreshJobCounters,
  registerArchive,
  reopenJobForReimport,
  resolveTenantVatNumber,
  summarizeJob,
  transitionJob
} = require('./sdi-historical-sync');

const ROOT = path.resolve(__dirname, '../../');
const REQUEST_DIR = path.join(ROOT, 'uploads', 'sdi-massive-requests');
const ARCHIVE_DIR = path.join(ROOT, 'uploads', 'sdi-storico');

// Orchestratore del backfill storico dai Servizi Massivi.
//
// Lega i mattoni che esistevano gia' e non si parlavano:
//
//   richiesta -> firma qualificata -> inoltroRichiesta -> esitoRichiesta
//     -> scaricoFile -> estrazione ZIP -> import documento per documento
//
// Ogni passo e' una funzione separata e ripartibile. Non c'e' un ciclo unico
// che fa tutto: fra la costruzione della richiesta e il suo inoltro c'e' una
// firma qualificata con PIN e OTP, che e' un'operazione umana e puo' passare
// giorni. Lo stato vive sul job, non in memoria.
//
// La rete resta fuori: il client SMTS viene iniettato da chi chiama, cosi' i
// test girano su fixture senza toccare nulla.

// --- 1. costruzione della richiesta --------------------------------------

function prepareRequest({ tenantId, jobId, utenteId = null }) {
  const job = requireJob(jobId, tenantId);
  if (job.status !== 'CREATED') {
    throw new Error(`Il job ${jobId} non e piu in preparazione (stato: ${job.status})`);
  }

  const vatNumber = resolveTenantVatNumber(tenantId);
  const xml = buildMassiveRequestXml({
    requestType: job.request_type,
    vatNumbers: [vatNumber],
    dateFrom: job.date_from,
    dateTo: job.date_to,
    // FILE_FATTURA restituisce gli XML delle fatture con i loro metadati;
    // ELENCO darebbe solo un CSV di estremi, che non e' importabile.
    tipoOutput: 'FILE_FATTURA',
    flow: 'ALL'
  });
  const filename = buildMassiveRequestFilename({
    vatNumber,
    requestType: job.request_type,
    dateFrom: job.date_from,
    dateTo: job.date_to,
    suffix: `J${job.id}`
  });

  // Il documento da firmare e' l'involucro RichiestaServiziMassivi, che porta
  // l'InputMassivo dentro di se' in base-64 (specifiche formato SMTS v1.5 par.
  // 1.1). Firmare l'InputMassivo nudo produrrebbe un file che il servizio
  // rifiuta, e la firma sarebbe da rifare.
  const involucro = buildRichiestaServiziMassiviXml({
    tipoRichiesta: 'FATT',
    nomeFile: filename,
    contenutoXml: xml
  });

  const xmlBuffer = Buffer.from(involucro, 'utf8');
  const xmlSha256 = sha256(xmlBuffer);
  const stored = persist(REQUEST_DIR, tenantId, `${xmlSha256}_${filename}`, xmlBuffer);

  db.prepare(`
    UPDATE sdi_historical_sync_job
    SET request_filename = ?, request_xml_path = ?, request_xml_sha256 = ?,
        request_signed_path = NULL, request_signed_sha256 = NULL, request_signature_meta = NULL,
        aggiornato_il = datetime('now')
    WHERE id = ?
  `).run(filename, stored.relativePath, xmlSha256, job.id);

  const signing = getMassiveSigningStatus();
  auditJob('SDI_HISTORICAL_REQUEST_PREPARED', {
    tenantId, jobId: job.id, utenteId,
    dettagli: { filename, xmlSha256, requestType: job.request_type, dateFrom: job.date_from, dateTo: job.date_to, signingMode: signing.mode }
  });

  // Con la firma locale non c'e' motivo di fermarsi: si firma e si prosegue.
  if (signing.available && !signing.external) {
    // Anche la firma locale firma l'involucro, non l'InputMassivo.
    return { ...attachSignedRequestBuffer({ job: getJob(job.id), signed: signMassiveRequest(involucro), utenteId, tenantId }), filename, xmlSha256 };
  }

  return {
    jobId: job.id,
    filename,
    signedFilename: `${filename}.p7m`,
    xmlSha256,
    xmlPath: stored.relativePath,
    signingMode: signing.mode,
    // Vero ogni volta che il server non firmera' da solo, non solo con
    // mode=external: con la firma non configurata il ciclo esterno resta
    // l'unica strada, e dire il contrario lascerebbe il job fermo senza
    // spiegare cosa manca.
    needsExternalSignature: true,
    signingReason: signing.reason || null,
    status: getJob(job.id).status
  };
}

// --- 2. ciclo di firma esterna della richiesta ----------------------------

function getRequestToSign(jobId, tenantId = null) {
  const job = requireJob(jobId, tenantId);
  if (!job.request_xml_path) throw new Error(`Il job ${jobId} non ha ancora una richiesta preparata`);
  if (job.status !== 'CREATED') {
    throw new Error(`La richiesta del job ${jobId} non e piu in attesa di firma (stato: ${job.status})`);
  }
  const absolute = resolveInsideUploads(job.request_xml_path);
  if (!fs.existsSync(absolute)) throw new Error(`Richiesta da firmare non trovata: ${job.request_xml_path}`);
  return {
    jobId: job.id,
    filename: job.request_filename,
    signedFilename: `${String(job.request_filename || '').replace(/\.p7m$/i, '')}.p7m`,
    xmlSha256: job.request_xml_sha256,
    buffer: fs.readFileSync(absolute)
  };
}

function attachSignedRequest({ jobId, tenantId = null, signedBuffer, filename = null, utenteId = null }) {
  const job = requireJob(jobId, tenantId);
  if (job.status !== 'CREATED') {
    throw new Error(`La richiesta del job ${jobId} non e piu in attesa di firma (stato: ${job.status})`);
  }
  if (!job.request_xml_sha256) throw new Error(`Il job ${jobId} non ha ancora una richiesta preparata`);

  let verification;
  try {
    verification = verifySignedMassiveRequest({ signedBuffer, expectedXmlSha256: job.request_xml_sha256 });
  } catch (error) {
    auditJob('SDI_HISTORICAL_REQUEST_SIGNATURE_REJECTED', {
      tenantId: job.tenant_id, jobId: job.id, utenteId,
      dettagli: { filename, errore: error.message, codice: error.code || null }
    });
    throw error;
  }

  return attachSignedRequestBuffer({
    job,
    utenteId,
    tenantId: job.tenant_id,
    signed: { buffer: signedBuffer, format: 'CAdES-BES', sha256: verification.signedSha256 },
    signer: verification.signer,
    uploadedName: filename
  });
}

function attachSignedRequestBuffer({ job, signed, signer = null, uploadedName = null, utenteId = null, tenantId }) {
  const signedFilename = `${String(job.request_filename || 'richiesta.xml').replace(/\.p7m$/i, '')}.p7m`;
  const stored = persist(REQUEST_DIR, tenantId || job.tenant_id, `${signed.sha256}_${signedFilename}`, signed.buffer);
  const meta = {
    modalita: signer ? 'esterna' : 'locale',
    formato: signed.format || 'CAdES-BES',
    nome_file_caricato: uploadedName || null,
    firmatario: signer?.subject || null,
    emittente: signer?.issuer || null,
    valido_fino: signer?.validTo || null,
    verificato_il: new Date().toISOString()
  };

  db.prepare(`
    UPDATE sdi_historical_sync_job
    SET request_signed_path = ?, request_signed_sha256 = ?, request_signature_meta = ?, aggiornato_il = datetime('now')
    WHERE id = ?
  `).run(stored.relativePath, signed.sha256, JSON.stringify(meta), job.id);

  transitionJob(job.id, 'SIGNED');
  auditJob('SDI_HISTORICAL_REQUEST_SIGNED', {
    tenantId: tenantId || job.tenant_id, jobId: job.id, utenteId,
    dettagli: { signedFilename, sha256: signed.sha256, firmatario: meta.firmatario, modalita: meta.modalita }
  });

  return {
    jobId: job.id,
    filename: signedFilename,
    path: stored.relativePath,
    sha256: signed.sha256,
    signer: signer || null,
    status: 'SIGNED'
  };
}

// --- 3. inoltro ------------------------------------------------------------

async function submitRequest({ jobId, tenantId = null, client, utenteId = null }) {
  const job = requireJob(jobId, tenantId);
  if (job.status !== 'SIGNED') throw new Error(`Il job ${jobId} non e firmato (stato: ${job.status})`);
  if (!job.request_signed_path) throw new Error(`Il job ${jobId} non ha un file di richiesta firmato`);

  const signedRequest = fs.readFileSync(resolveInsideUploads(job.request_signed_path));
  // Il NomeFile della SOAP request descrive cio' che si sta trasmettendo, ed e'
  // il file firmato: mandare il nome dell'XML in chiaro accanto al contenuto
  // di un .p7m sarebbe una dichiarazione falsa.
  const response = await client.submitRequest({
    filename: `${String(job.request_filename || 'richiesta.xml').replace(/\.p7m$/i, '')}.p7m`,
    signedRequest
  });

  transitionJob(job.id, 'SUBMITTED', { remoteRequestId: response.idRichiesta });
  auditJob('SDI_HISTORICAL_REQUEST_SUBMITTED', {
    tenantId: job.tenant_id, jobId: job.id, utenteId,
    dettagli: { idRichiesta: response.idRichiesta, dataOraRicezione: response.dataOraRicezione }
  });
  return { jobId: job.id, idRichiesta: response.idRichiesta, dataOraRicezione: response.dataOraRicezione, status: 'SUBMITTED' };
}

// --- 4. interrogazione dell'esito -----------------------------------------

// Le interrogazioni sono contingentate a dieci per richiesta: ogni chiamata
// qui e' una di quelle dieci, quindi non va messa in un ciclo stretto.
const MAX_ESITO_CALLS = 10;

async function pollRequest({ jobId, tenantId = null, client, utenteId = null }) {
  const job = requireJob(jobId, tenantId);
  if (!['SUBMITTED', 'PROCESSING'].includes(job.status)) {
    throw new Error(`Il job ${jobId} non e in attesa di esito (stato: ${job.status})`);
  }
  if (!job.remote_request_id) throw new Error(`Il job ${jobId} non ha un IdRichiesta`);

  // Il conteggio sta sul job e non solo nel client: fra l'inoltro e la
  // disponibilita' degli archivi possono passare ore, e un riavvio del
  // container azzererebbe un contatore tenuto in memoria. Quello vero lo tiene
  // SdI, e superarlo significa non poter piu' sapere se la richiesta e' pronta.
  const usate = Number(job.esito_calls || 0);
  if (usate >= MAX_ESITO_CALLS) {
    const error = new Error(
      `Il job ${jobId} ha gia usato le ${MAX_ESITO_CALLS} interrogazioni di esito ammesse per la richiesta `
      + `${job.remote_request_id}: gli archivi vanno scaricati con quanto gia noto, oppure serve una nuova richiesta`
    );
    error.code = 'ESITO_LIMIT';
    throw error;
  }
  // Incrementato prima della chiamata: se la richiesta parte e la risposta si
  // perde, SdI l'ha comunque contata. Meglio un'interrogazione in meno che
  // scoprire il limite superato quando serve davvero.
  db.prepare("UPDATE sdi_historical_sync_job SET esito_calls = ?, esito_last_at = datetime('now'), aggiornato_il = datetime('now') WHERE id = ?")
    .run(usate + 1, job.id);
  const rimaste = MAX_ESITO_CALLS - (usate + 1);

  const status = await client.getRequestStatus(job.remote_request_id);

  if (status.rejected) {
    const errori = status.esito?.errori || [];
    transitionJob(job.id, 'FAILED', {
      errors: errori.length ? errori : [{ codice: 'ST02', descrizione: 'Richiesta scartata dai Servizi Massivi' }]
    });
    auditJob('SDI_HISTORICAL_REQUEST_REJECTED', { tenantId: job.tenant_id, jobId: job.id, utenteId, dettagli: { errori } });
    return { jobId: job.id, status: 'FAILED', stato: status.stato, errori, interrogazioniRimaste: rimaste };
  }

  if (!status.ready) {
    if (job.status !== 'PROCESSING') transitionJob(job.id, 'PROCESSING');
    return {
      jobId: job.id,
      status: 'PROCESSING',
      stato: status.stato,
      statoDescrizione: status.statoDescrizione,
      interrogazioniRimaste: rimaste
    };
  }

  if (status.esitoErrore) {
    throw new Error(`Esito ricevuto ma non leggibile: ${status.esitoErrore}`);
  }

  const esitoPath = status.esitoFile?.buffer?.length
    ? persist(ARCHIVE_DIR, job.tenant_id, `esito_${job.id}_${sha256(status.esitoFile.buffer)}.xml`, status.esitoFile.buffer).relativePath
    : null;

  const archivi = status.archiviFatture || [];
  db.prepare("UPDATE sdi_historical_sync_job SET esito_file_path = ?, aggiornato_il = datetime('now') WHERE id = ?")
    .run(esitoPath, job.id);
  transitionJob(job.id, 'READY', {
    // Oltre DataFineDisponibilita gli archivi non sono piu' scaricabili.
    expiresAt: status.dataFineDisponibilita || null,
    archivesCount: archivi.length
  });
  auditJob('SDI_HISTORICAL_REQUEST_READY', {
    tenantId: job.tenant_id, jobId: job.id, utenteId,
    dettagli: {
      archivi: archivi.length,
      archiviTotali: (status.archivi || []).length,
      dataFineDisponibilita: status.dataFineDisponibilita,
      conteggioCoerente: status.esito?.conteggioCoerente
    }
  });

  return {
    jobId: job.id,
    status: 'READY',
    stato: status.stato,
    archivi,
    // Gli archivi di tipologia diversa da Fatt appartengono ad altri servizi:
    // vengono elencati per trasparenza, ma non scaricati dal backfill fatture.
    archiviIgnorati: (status.archivi || []).filter((archivio) => !archivio.fatture),
    dataFineDisponibilita: status.dataFineDisponibilita,
    conteggioCoerente: status.esito?.conteggioCoerente !== false,
    interrogazioniRimaste: rimaste
  };
}

// --- 5. scarico degli archivi ---------------------------------------------

async function downloadArchives({ jobId, tenantId = null, client, archivi = null, acknowledgeVisualizzazione = false, utenteId = null, now = new Date() }) {
  const job = requireJob(jobId, tenantId);
  if (!['READY', 'DOWNLOADING', 'PARTIAL'].includes(job.status)) {
    throw new Error(`Il job ${jobId} non ha archivi pronti (stato: ${job.status})`);
  }

  // DataFineDisponibilita e' il termine ultimo per richiamare i servizi legati
  // alla richiesta, download compreso (Formato File SMTS v1.5 par. 1.2). Oltre
  // quella data non c'e' niente da riprovare: serve una richiesta nuova, e
  // quindi un'altra firma qualificata. Dirlo subito evita di consumare
  // tentativi contro archivi che non esistono piu'.
  if (isExpired(job.expires_at, now)) {
    if (job.status !== 'EXPIRED') transitionJob(job.id, 'EXPIRED');
    const error = new Error(
      `Gli archivi del job ${jobId} non sono piu disponibili: la richiesta ${job.remote_request_id} `
      + `e scaduta il ${job.expires_at}. Serve una nuova richiesta, con una nuova firma`
    );
    error.code = 'ARCHIVI_SCADUTI';
    throw error;
  }

  // Istruzioni SMTS v1.5: scaricare un archivio di fatture messe a disposizione
  // vale come presa visione fiscale. Non e' un download qualunque e non deve
  // poter partire per inerzia: serve una conferma esplicita di chi lo chiede.
  if (job.request_type === 'AVAILABLE_TO_RECIPIENT' && !acknowledgeVisualizzazione) {
    throw new Error(
      'Lo scarico delle fatture messe a disposizione vale come presa visione fiscale: '
      + 'richiede una conferma esplicita (acknowledgeVisualizzazione=true)'
    );
  }

  const daScaricare = archivi || (await listReadyArchives({ job, client }));
  if (!daScaricare.length) {
    transitionJob(job.id, 'DOWNLOADING');
    return { jobId: job.id, status: 'DOWNLOADING', scaricati: [], nessunArchivio: true };
  }

  if (job.status !== 'DOWNLOADING') transitionJob(job.id, 'DOWNLOADING');

  const scaricati = [];
  const falliti = [];
  for (const archivio of daScaricare) {
    // Un archivio gia' scaricato non si riscarica: il rate limit e' di dieci
    // ogni due minuti e una ripartenza non deve consumarlo di nuovo.
    const esistente = db.prepare(
      'SELECT id FROM sdi_historical_sync_archive WHERE job_id = ? AND remote_archive_id = ? LIMIT 1'
    ).get(job.id, String(archivio.idFile));
    if (esistente) {
      scaricati.push({ archiveId: esistente.id, idFile: archivio.idFile, nomeFile: archivio.nomeFile, giaPresente: true });
      continue;
    }

    try {
      const downloaded = await client.downloadArchive(job.remote_request_id, archivio.idFile, {
        acknowledgeVisualizzazione
      });
      const buffer = downloaded.buffer || Buffer.alloc(0);
      if (!buffer.length) throw new Error('Archivio vuoto');
      const hash = sha256(buffer);
      const stored = persist(ARCHIVE_DIR, job.tenant_id, `${hash}_${safeName(downloaded.nomeFile || archivio.nomeFile || `archivio_${archivio.idFile}.zip`)}`, buffer);
      const archiveId = registerArchive({
        tenantId: job.tenant_id,
        jobId: job.id,
        remoteArchiveId: String(archivio.idFile),
        remoteFilename: downloaded.nomeFile || archivio.nomeFile || null,
        size: buffer.length,
        sha256: hash,
        localPath: stored.relativePath
      });
      scaricati.push({ archiveId, idFile: archivio.idFile, nomeFile: downloaded.nomeFile, size: buffer.length, sha256: hash });
    } catch (error) {
      falliti.push({ idFile: archivio.idFile, errore: error.message, code: error.code || null });
      // Il limite locale non e' un errore dell'archivio: fermarsi e riprendere
      // dopo e' l'unica cosa sensata, insistere porta a ER03.
      if (error.code === 'LOCAL_LIMIT' || error.code === 'ER03') break;
    }
  }

  if (job.request_type === 'AVAILABLE_TO_RECIPIENT' && scaricati.length) {
    db.prepare("UPDATE sdi_historical_sync_job SET presa_visione = 1, aggiornato_il = datetime('now') WHERE id = ?").run(job.id);
    auditJob('SDI_HISTORICAL_PRESA_VISIONE', {
      tenantId: job.tenant_id, jobId: job.id, utenteId,
      dettagli: { archivi: scaricati.map((a) => a.idFile) }
    });
  }

  return { jobId: job.id, status: getJob(job.id).status, scaricati, falliti };
}

async function listReadyArchives({ job, client }) {
  const status = await client.getRequestStatus(job.remote_request_id);
  if (!status.ready) throw new Error(`La richiesta ${job.remote_request_id} non e ancora elaborata (${status.stato})`);
  return status.archiviFatture || [];
}

// --- 6. import documento per documento ------------------------------------

async function importArchives({ jobId, tenantId = null, dryRun = null, utenteId = null }) {
  const job = requireJob(jobId, tenantId);
  // PARTIAL e' ammesso: e' la ripresa di una passata rimasta a meta'. Gli
  // archivi gia' importati sono marcati PROCESSED e non vengono ritoccati.
  if (!['DOWNLOADING', 'IMPORTING', 'PARTIAL'].includes(job.status)) {
    throw new Error(`Il job ${jobId} non ha archivi da importare (stato: ${job.status})`);
  }
  const simulazione = dryRun === null ? Boolean(job.dry_run) : Boolean(dryRun);
  const identifiers = tenantIdentifiers(job.tenant_id);

  const archivi = db.prepare(
    "SELECT * FROM sdi_historical_sync_archive WHERE job_id = ? AND COALESCE(status,'') <> 'PROCESSED' ORDER BY id"
  ).all(job.id);

  if (job.status !== 'IMPORTING') transitionJob(job.id, 'IMPORTING');

  const report = [];
  const errori = [];
  for (const archivio of archivi) {
    try {
      report.push(await importSingleArchive({ job, archivio, dryRun: simulazione, utenteId, identifiers }));
    } catch (error) {
      errori.push({ archiveId: archivio.id, errore: error.message, code: error.code || null });
      db.prepare("UPDATE sdi_historical_sync_archive SET status = 'FAILED' WHERE id = ?").run(archivio.id);
    }
  }

  // In dry-run non si conclude nulla: il job resta dov'e', altrimenti una
  // simulazione impedirebbe l'import vero (gli stati terminali sono definitivi).
  if (!simulazione) {
    const counters = getJob(job.id);
    const rimasti = db.prepare(
      "SELECT COUNT(*) n FROM sdi_historical_sync_archive WHERE job_id = ? AND COALESCE(status,'') <> 'PROCESSED'"
    ).get(job.id).n;
    const esito = errori.length || rimasti ? 'PARTIAL' : 'COMPLETED';
    transitionJob(job.id, esito, { errors: errori.length ? errori : undefined });
    auditJob('SDI_HISTORICAL_JOB_FINISHED', {
      tenantId: job.tenant_id, jobId: job.id, utenteId,
      dettagli: { esito, trovati: counters.documents_found, importati: counters.documents_imported, duplicati: counters.duplicates, errori: errori.length }
    });
  }

  return { jobId: job.id, dryRun: simulazione, status: getJob(job.id).status, archivi: report, errori };
}

async function importSingleArchive({ job, archivio, dryRun, utenteId, identifiers }) {
  const zipPath = resolveInsideUploads(archivio.local_path);
  if (!fs.existsSync(zipPath)) throw new Error(`Archivio non trovato su disco: ${archivio.local_path}`);

  const workDir = path.join(ARCHIVE_DIR, String(job.tenant_id), 'archivi', `job${job.id}_arc${archivio.id}`);
  const { files } = await extractTo(zipPath, workDir);

  // Prima i metadati, poi le fatture: l'identificativo SdI di una fattura sta
  // nel suo file di metadati, e va conosciuto prima di importarla.
  const metadati = [];
  const documenti = [];
  files.forEach((file) => {
    const meta = readCompanionMetadata(file.path);
    if (meta) metadati.push({ ...meta, file });
    else documenti.push(file);
  });

  const esiti = [];
  for (const file of documenti) {
    const buffer = fs.readFileSync(file.path);
    const companion = matchCompanionMetadata({ file, buffer, metadati });
    let outcome;
    try {
      outcome = importDocument({
        tenantId: job.tenant_id,
        buffer,
        filename: path.basename(file.name),
        source: 'SDI_HISTORICAL_SYNC',
        jobId: job.id,
        utenteId,
        dryRun,
        tenantIdentifiers: identifiers,
        identificativoSdi: companion?.idfile || null
      });
    } catch (error) {
      outcome = { outcome: 'FAILED', error: error.message, filename: path.basename(file.name) };
    }

    recordItem({
      tenantId: job.tenant_id,
      jobId: job.id,
      archiveId: archivio.id,
      entryName: file.name,
      documentType: outcome.documentType || null,
      direction: outcome.direction || null,
      identificativoSdi: outcome.identificativoSdi || companion?.idfile || null,
      originalFilename: outcome.filename || path.basename(file.name),
      originalSha256: outcome.originalSha256 || file.sha256,
      xmlSha256: outcome.xmlSha256 || null,
      localPath: relative(file.path),
      outcome: outcome.outcome,
      fatturaId: outcome.fatturaId || null,
      dedupLevel: outcome.dedupLevel || null,
      errorMessage: outcome.error || outcome.note || null
    });
    esiti.push({ entry: file.name, outcome: outcome.outcome, numero: outcome.numero || null, fatturaId: outcome.fatturaId || null });
  }

  if (!dryRun) {
    db.prepare("UPDATE sdi_historical_sync_archive SET status = 'PROCESSED', processed_at = datetime('now') WHERE id = ?")
      .run(archivio.id);
  }

  return {
    archiveId: archivio.id,
    nomeFile: archivio.remote_filename,
    documenti: documenti.length,
    metadati: metadati.length,
    esiti
  };
}

// --- ri-elaborazione di archivi gia' scaricati ----------------------------

// Rende ripetibile il parsing senza ripetere il download.
//
// Serve perche' scaricare e interpretare hanno costi diversi: il download
// costa una firma qualificata e scade, il parsing e' gratis. Quando il parser
// migliora, si vuole rileggere quello che si ha in casa, non richiederlo a SdI.
//
// Non basta rimettere gli archivi in coda: le fatture gia' inserite verrebbero
// riconosciute come duplicati e solo "arricchite", e l'arricchimento riempie i
// campi vuoti senza correggere quelli sbagliati. Quindi si cancella prima cio'
// che quel job aveva prodotto.
function reprocessArchives({ jobId, tenantId = null, utenteId = null, motivo = null }) {
  const job = requireJob(jobId, tenantId);

  const importate = db.prepare(`
    SELECT DISTINCT i.fattura_id
    FROM sdi_historical_sync_item i
    JOIN fatture f ON f.id = i.fattura_id
    WHERE i.job_id = ? AND i.outcome = 'IMPORTED' AND i.fattura_id IS NOT NULL
      AND f.tenant_id = ? AND f.source = 'SDI_HISTORICAL_SYNC'
  `).all(job.id, job.tenant_id).map((row) => row.fattura_id);

  db.exec('BEGIN');
  try {
    // Il vincolo su source e' la protezione che conta: una fattura creata dal
    // CRM o importata a mano non deve poter sparire per una ri-elaborazione,
    // nemmeno se un item la referenziasse per errore.
    const remove = db.prepare("DELETE FROM fatture WHERE id = ? AND tenant_id = ? AND source = 'SDI_HISTORICAL_SYNC'");
    importate.forEach((fatturaId) => remove.run(fatturaId, job.tenant_id));
    db.prepare('DELETE FROM sdi_historical_sync_item WHERE job_id = ?').run(job.id);
    db.prepare("UPDATE sdi_historical_sync_archive SET status = 'DOWNLOADED', processed_at = NULL WHERE job_id = ?").run(job.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  refreshJobCounters(job.id);
  reopenJobForReimport(job.id, { utenteId, motivo });
  auditJob('SDI_HISTORICAL_REPROCESS_PREPARED', {
    tenantId: job.tenant_id, jobId: job.id, utenteId,
    dettagli: { fattureRimosse: importate.length, motivo }
  });

  const archivi = db.prepare('SELECT COUNT(*) n FROM sdi_historical_sync_archive WHERE job_id = ?').get(job.id).n;
  return {
    jobId: job.id,
    status: getJob(job.id).status,
    fattureRimosse: importate.length,
    archiviDaRileggere: archivi,
    // Gli archivi restano dove sono: nessun nuovo scaricoFile, nessuna firma.
    nuovoDownload: false
  };
}

// --- metadati che accompagnano i file-fattura -----------------------------

// Formato File SMTS v1.5 par. 1.3.2: ogni file-fattura e' accompagnato da un
// file di metadati XML che riporta hashfile, idfile e dataaccoglienza.
//
// La specifica descrive il nome del file di metadati come derivato da quello
// della fattura, ma il suffisso esatto non e' leggibile nel documento. Qui non
// si indovina: il file viene riconosciuto dal contenuto, e l'abbinamento alla
// fattura passa prima dall'hash, che e' una prova, e solo in mancanza di quello
// dal nome, che e' un indizio.
function readCompanionMetadata(filePath) {
  if (!/\.xml$/i.test(filePath)) return null;
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  // I metadati sono poche centinaia di byte: leggere una fattura intera qui
  // sarebbe solo spreco.
  if (stat.size > 64 * 1024) return null;

  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  if (!/idfile|identificativoSdI/i.test(content) || !/hashfile|<hash>/i.test(content)) return null;

  const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true });
  let parsed;
  try { parsed = parser.parse(content); } catch { return null; }

  const idfile = findValueCaseInsensitive(parsed, ['idfile', 'identificativosdi']);
  const hashfile = findValueCaseInsensitive(parsed, ['hashfile', 'hash']);
  if (!idfile && !hashfile) return null;
  return {
    idfile: idfile ? String(idfile).trim() : null,
    hashfile: hashfile ? String(hashfile).trim().toLowerCase() : null,
    dataaccoglienza: findValueCaseInsensitive(parsed, ['dataaccoglienza', 'dataoraricezione']) || null,
    path: filePath
  };
}

function matchCompanionMetadata({ file, buffer, metadati }) {
  if (!metadati.length) return null;
  const hash = sha256(buffer).toLowerCase();
  const perHash = metadati.find((meta) => meta.hashfile && meta.hashfile === hash);
  if (perHash) return perHash;

  // Ripiego sul nome: il file di metadati e' derivato dal nome della fattura,
  // quindi il nome della fattura ne e' un prefisso.
  const base = path.basename(file.name).replace(/\.(xml|p7m)$/i, '');
  return metadati.find((meta) => {
    const metaBase = path.basename(meta.file.name).replace(/\.xml$/i, '');
    return metaBase !== base && metaBase.startsWith(base);
  }) || null;
}

function findValueCaseInsensitive(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const [name, value] of Object.entries(source)) {
    if (keys.includes(String(name).toLowerCase()) && value !== null && value !== undefined && typeof value !== 'object') {
      return value;
    }
    if (value && typeof value === 'object') {
      const nested = findValueCaseInsensitive(value, keys);
      if (nested !== null && nested !== undefined) return nested;
    }
  }
  return null;
}

// --- supporto --------------------------------------------------------------

function requireJob(jobId, tenantId = null) {
  const job = getJob(Number(jobId));
  if (!job) throw new Error(`Job ${jobId} non trovato`);
  // Il job appartiene a un tenant: chi interroga da un altro non deve poterlo
  // nemmeno vedere, altrimenti l'isolamento vale solo alla creazione.
  if (tenantId !== null && Number(job.tenant_id) !== Number(tenantId)) {
    throw new Error(`Job ${jobId} non trovato`);
  }
  return job;
}

// Forma attesa da determineDirection: singolari, non liste. Senza questi due
// valori ogni fattura importata resterebbe di direzione sconosciuta, e un
// backfill di direzione sconosciuta non serve a niente.
function tenantIdentifiers(tenantId) {
  const config = getFiscalConfiguration(tenantId);
  const identifiers = {
    vatNumber: config.vat_number || null,
    taxCode: config.tax_code || null,
    recipientCode: config.recipient_code || null
  };
  if (!identifiers.vatNumber && !identifiers.taxCode) {
    throw new Error(
      `Configurazione fiscale del tenant ${tenantId} senza partita IVA ne codice fiscale: `
      + 'la direzione delle fatture non sarebbe determinabile'
    );
  }
  return identifiers;
}

function persist(baseDir, tenantId, filename, buffer) {
  const dir = path.join(baseDir, String(tenantId), new Date().toISOString().slice(0, 10).replace(/-/g, '/'));
  fs.mkdirSync(dir, { recursive: true });
  const absolutePath = path.join(dir, safeName(filename));
  if (!fs.existsSync(absolutePath)) fs.writeFileSync(absolutePath, buffer);
  return { absolutePath, relativePath: relative(absolutePath) };
}

function resolveInsideUploads(relativePath) {
  const clean = String(relativePath || '').replace(/^[/\\]+/, '');
  const absolute = path.resolve(ROOT, clean);
  const uploads = path.resolve(ROOT, 'uploads');
  if (!absolute.startsWith(uploads + path.sep)) throw new Error('Percorso non valido fuori da uploads');
  return absolute;
}

function relative(absolutePath) {
  return `/${path.relative(ROOT, absolutePath).split(path.sep).join('/')}`;
}

// DataFineDisponibilita e' un giorno di calendario: la disponibilita' vale per
// tutto quel giorno, quindi si e' scaduti solo dal giorno dopo.
function isExpired(expiresAt, now = new Date()) {
  const value = String(expiresAt || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(now).toISOString().slice(0, 10) > value;
}

function safeName(value) {
  return String(value || 'file').replace(/[^A-Za-z0-9._-]+/g, '-');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8')).digest('hex');
}

function reportJob(jobId, tenantId = null) {
  const job = requireJob(jobId, tenantId);
  const summary = summarizeJob(job.id);
  const items = db.prepare(`
    SELECT outcome, COUNT(*) AS n FROM sdi_historical_sync_item WHERE job_id = ? GROUP BY outcome
  `).all(job.id);
  return {
    ...summary,
    firma: parseJson(job.request_signature_meta),
    outcomes: items,
    presaVisione: Boolean(job.presa_visione)
  };
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = {
  MAX_ESITO_CALLS,
  attachSignedRequest,
  downloadArchives,
  getRequestToSign,
  importArchives,
  isExpired,
  matchCompanionMetadata,
  pollRequest,
  prepareRequest,
  readCompanionMetadata,
  reportJob,
  reprocessArchives,
  submitRequest
};
