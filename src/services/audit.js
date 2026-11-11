const db = require('../db/database');

function writeAudit({ utente_id = null, azione, entita_tipo = null, entita_id = null, dettagli = null }) {
  try {
    db.prepare(`
      INSERT INTO audit_log (utente_id, azione, entita_tipo, entita_id, dettagli)
      VALUES (?,?,?,?,?)
    `).run(utente_id, azione, entita_tipo, entita_id, dettagli ? JSON.stringify(dettagli) : null);
  } catch {}
}

module.exports = { writeAudit };
