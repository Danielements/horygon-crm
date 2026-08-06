const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { writeAudit } = require('../services/audit');
const { writeSystemLog } = require('../services/system-log');
const { generateOutboundXmlForInvoice } = require('../services/sdi-fatturapa');

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

router.post('/fatture/:id/test-send', requirePermesso('fatture', 'edit'), (req, res) => {
  try {
    const result = generateOutboundXmlForInvoice(req.params.id, { mode: 'test' });
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
