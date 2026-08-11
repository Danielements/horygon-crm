const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');
const { writeSystemLog } = require('../services/system-log');
const { getSetting } = require('../services/google');
const { getMassiveClient } = require('../services/sdi-massive-transport');
const { advanceJobs, isAutoEnabled } = require('../services/sdi-backfill-scheduler');
const { getMassiveSigningStatus, REQUEST_TYPES } = require('../services/sdi-massive-request');
const { planBackfill, resolveTenantVatNumber } = require('../services/sdi-historical-sync');
const {
  abandonJob,
  attachSignedRequest,
  deleteJob,
  downloadArchives,
  getRequestToSign,
  importArchives,
  pollRequest,
  prepareRequest,
  reportJob,
  reprocessArchives,
  submitRequest
} = require('../services/sdi-backfill');

// Backfill dello storico fatture dai Servizi Massivi.
//
// Ogni passo e' una rotta distinta perche' il ciclo non e' automatizzabile fino
// in fondo: in mezzo c'e' una firma qualificata con PIN e OTP, e le
// interrogazioni di esito sono contingentate. Una rotta unica "fai tutto"
// nasconderebbe proprio i punti in cui bisogna fermarsi.

// Il .p7m della richiesta e' binario: stesso trattamento del ciclo fatture.
const signedFileParser = express.raw({ type: () => true, limit: '10mb' });

router.use(authMiddleware);

// L'applicazione e' di fatto mono-tenant: il tenant 1 e' HORYGON, seminato in
// bootstrap. Questo e' l'unico punto da cambiare se un giorno cambiera'.
function currentTenantId() {
  const configured = Number(getSetting('sdi.tenant_id', 1));
  return Number.isInteger(configured) && configured > 0 ? configured : 1;
}

router.get('/stato', requirePermesso('fatture', 'read'), (req, res) => {
  const tenantId = currentTenantId();
  const signing = getMassiveSigningStatus();
  const payload = {
    tenantId,
    tipiRichiesta: Object.keys(REQUEST_TYPES),
    firma: { mode: signing.mode, available: signing.available, external: Boolean(signing.external), reason: signing.reason || null },
    endpoint: getSetting('sdi.massive.endpoint', 'https://servizi.fatturapa.it/sm-scarico-file'),
    automatico: isAutoEnabled(),
    intervalloMinuti: Number(getSetting('sdi.massive.auto.interval_minutes', '15'))
  };
  try {
    payload.partitaIva = resolveTenantVatNumber(tenantId);
    payload.pronto = true;
  } catch (error) {
    // Non e' un errore HTTP: e' esattamente l'informazione che serve prima di
    // cominciare, cioe' cosa manca ancora per poter interrogare i servizi.
    payload.pronto = false;
    payload.bloccante = error.message;
  }
  res.json(payload);
});

// Pianifica le finestre temporali. L'intervallo massimo per richiesta e' tre
// mesi (controllo 00201), quindi un periodo lungo diventa piu' job.
router.post('/piano', requirePermesso('fatture', 'edit'), (req, res) => {
  const tenantId = currentTenantId();
  try {
    const result = planBackfill({
      tenantId,
      requestType: String(req.body?.requestType || 'INCOMING'),
      dateFrom: String(req.body?.dateFrom || ''),
      dateTo: String(req.body?.dateTo || ''),
      months: Number(req.body?.months || 3),
      dryRun: req.body?.dryRun === true,
      utenteId: req.user.id
    });
    writeAudit({
      utente_id: req.user.id,
      azione: 'sdi.storico.piano',
      entita_tipo: 'sdi_historical_sync_job',
      entita_id: null,
      dettagli: {
        requestType: req.body?.requestType,
        dateFrom: req.body?.dateFrom,
        dateTo: req.body?.dateTo,
        finestre: result.windows.length,
        creati: result.created.map((job) => job.id),
        saltati: result.skipped.length
      }
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/jobs', requirePermesso('fatture', 'read'), (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM sdi_historical_sync_job
    WHERE tenant_id = ?
    ORDER BY date_from DESC, id DESC
    LIMIT 200
  `).all(currentTenantId());
  res.json(rows);
});

router.get('/jobs/:id', requirePermesso('fatture', 'read'), (req, res) => {
  try {
    res.json(reportJob(Number(req.params.id), currentTenantId()));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

router.post('/jobs/:id/prepara', requirePermesso('fatture', 'edit'), async (req, res) => {
  // Asincrona perche' qui la richiesta viene validata contro gli XSD ufficiali
  // prima di essere proposta alla firma.
  await handleAsync(req, res, 'prepara', () => prepareRequest({
    tenantId: currentTenantId(),
    jobId: Number(req.params.id),
    utenteId: req.user.id
  }));
});

router.delete('/jobs/:id', requirePermesso('fatture', 'edit'), (req, res) => {
  handle(req, res, 'elimina', () => deleteJob({
    jobId: Number(req.params.id),
    tenantId: currentTenantId(),
    utenteId: req.user.id,
    // La conferma viaggia in query: una DELETE non porta corpo in modo
    // affidabile attraverso tutti i client.
    force: String(req.query.force || '') === 'true'
  }));
});

router.get('/jobs/:id/richiesta-da-firmare', requirePermesso('fatture', 'read'), (req, res) => {
  try {
    const document = getRequestToSign(Number(req.params.id), currentTenantId());
    res
      .set('Content-Type', 'application/xml; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${document.filename}"`)
      .send(document.buffer);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/jobs/:id/firma', requirePermesso('fatture', 'edit'), signedFileParser, (req, res) => {
  const jobId = Number(req.params.id);
  try {
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const result = attachSignedRequest({
      jobId,
      tenantId: currentTenantId(),
      signedBuffer: buffer,
      filename: String(req.query.filename || req.headers['x-filename'] || '').trim() || null,
      utenteId: req.user.id
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    logFailure(req, 'firma', jobId, error);
    // Stesso significato del ciclo fatture: si e' firmato un documento diverso
    // da quello registrato, quindi il job interrogherebbe un periodo sbagliato.
    res.status(error.code === 'SIGNED_DOCUMENT_MISMATCH' ? 409 : 400).json({
      error: error.message,
      code: error.code || null,
      attesoSha256: error.atteso || null,
      trovatoSha256: error.trovato || null
    });
  }
});

router.post('/jobs/:id/inoltra', requirePermesso('fatture', 'edit'), async (req, res) => {
  await handleAsync(req, res, 'inoltra', () => submitRequest({
    jobId: Number(req.params.id),
    tenantId: currentTenantId(),
    client: getMassiveClient(),
    utenteId: req.user.id
  }));
});

router.post('/jobs/:id/esito', requirePermesso('fatture', 'edit'), async (req, res) => {
  await handleAsync(req, res, 'esito', () => pollRequest({
    jobId: Number(req.params.id),
    tenantId: currentTenantId(),
    client: getMassiveClient(),
    utenteId: req.user.id
  }));
});

router.post('/jobs/:id/scarica', requirePermesso('fatture', 'edit'), async (req, res) => {
  await handleAsync(req, res, 'scarica', () => downloadArchives({
    jobId: Number(req.params.id),
    tenantId: currentTenantId(),
    client: getMassiveClient(),
    // Per le fatture messe a disposizione il download vale come presa visione
    // fiscale: la conferma deve arrivare dal chiamante, non da un default.
    acknowledgeVisualizzazione: req.body?.acknowledgeVisualizzazione === true,
    utenteId: req.user.id
  }));
});

// Fa avanzare tutti i job di un passo, senza aspettare il timer. Stessa logica
// del pilota automatico: non tocca mai la firma.
router.post('/avanza', requirePermesso('fatture', 'edit'), async (req, res) => {
  try {
    const result = await advanceJobs({ tenantId: currentTenantId(), utenteId: req.user.id });
    res.json({ ok: true, ...result });
  } catch (error) {
    logFailure(req, 'avanza', 0, error);
    res.status(400).json({ error: error.message });
  }
});

// Chiude un job senza via d'uscita, cosi' lo stesso periodo torna pianificabile.
router.post('/jobs/:id/abbandona', requirePermesso('fatture', 'edit'), (req, res) => {
  handle(req, res, 'abbandona', () => abandonJob({
    jobId: Number(req.params.id),
    tenantId: currentTenantId(),
    motivo: String(req.body?.motivo || '').trim() || null,
    utenteId: req.user.id
  }));
});

// Ri-elabora archivi gia' scaricati: cancella le fatture prodotte da questo job
// e rimette gli archivi in coda. Nessuna nuova richiesta a SdI, nessuna firma.
// Serve quando migliora il parser: i file sono gia' in casa.
router.post('/jobs/:id/riprocessa', requirePermesso('fatture', 'edit'), (req, res) => {
  handle(req, res, 'riprocessa', () => reprocessArchives({
    jobId: Number(req.params.id),
    tenantId: currentTenantId(),
    utenteId: req.user.id,
    motivo: String(req.body?.motivo || '').trim() || null
  }));
});

router.post('/jobs/:id/importa', requirePermesso('fatture', 'edit'), async (req, res) => {
  await handleAsync(req, res, 'importa', () => importArchives({
    jobId: Number(req.params.id),
    tenantId: currentTenantId(),
    dryRun: req.body?.dryRun === undefined ? null : req.body.dryRun === true,
    utenteId: req.user.id
  }));
});

function handle(req, res, step, work) {
  try {
    res.json({ ok: true, ...work() });
  } catch (error) {
    logFailure(req, step, Number(req.params.id), error);
    res.status(400).json({ error: error.message, code: error.code || null });
  }
}

async function handleAsync(req, res, step, work) {
  try {
    const result = await work();
    writeSystemLog({
      livello: 'info',
      origine: 'sdi.storico',
      route: req.originalUrl,
      metodo: 'POST',
      utente_id: req.user.id,
      messaggio: `Backfill SdI, passo "${step}" sul job ${req.params.id}: ${result.status || 'ok'}`,
      dettagli: result
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    logFailure(req, step, Number(req.params.id), error);
    res.status(400).json({ error: error.message, code: error.code || null, retryable: Boolean(error.retryable) });
  }
}

function logFailure(req, step, jobId, error) {
  writeSystemLog({
    livello: 'error',
    origine: 'sdi.storico',
    route: req.originalUrl,
    metodo: req.method,
    utente_id: req.user?.id,
    messaggio: `Backfill SdI, passo "${step}" fallito sul job ${jobId}: ${error.message}`,
    stack: error.stack || null,
    dettagli: { jobId, step, code: error.code || null }
  });
}

module.exports = router;
