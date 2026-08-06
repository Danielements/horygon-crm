const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');
const { writeSystemLog } = require('../services/system-log');
const { generateOutboundXmlForInvoice } = require('../services/sdi-fatturapa');
const { receiveSdiNotificationXml } = require('../services/sdi-inbound');

const xmlTextParser = express.text({
  type: ['application/xml', 'text/xml', 'application/soap+xml', 'text/plain'],
  limit: '5mb'
});

router.post('/ws/inbound', xmlTextParser, (req, res) => {
  try {
    const xml = String(req.body || '').trim();
    if (!xml) return res.status(400).json({ error: 'Body XML mancante' });
    const result = receiveSdiNotificationXml(xml, {
      originalFilename: req.headers['x-original-filename'] ? String(req.headers['x-original-filename']) : null
    });
    writeSystemLog({
      livello: 'info',
      origine: 'sdi.ws.inbound',
      route: '/api/sdi/ws/inbound',
      metodo: 'POST',
      messaggio: `Notifica SDI ricevuta: ${result.parsed.tipoNotifica}`,
      dettagli: {
        flowId: result.flowId,
        fatturaId: result.fatturaId,
        stato: result.statoNormalizzato,
        identificativoSdi: result.parsed.identificativoSdi,
        nomeFileFattura: result.parsed.nomeFileFattura
      }
    });
    res.json({
      ok: true,
      flowId: result.flowId,
      fatturaId: result.fatturaId,
      tipoNotifica: result.parsed.tipoNotifica,
      statoNormalizzato: result.statoNormalizzato
    });
  } catch (error) {
    writeSystemLog({
      livello: 'error',
      origine: 'sdi.ws.inbound',
      route: '/api/sdi/ws/inbound',
      metodo: 'POST',
      messaggio: error.message,
      stack: error.stack || null
    });
    res.status(400).json({ error: error.message });
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

module.exports = router;
