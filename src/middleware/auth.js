const jwt = require('jsonwebtoken');
const db = require('../db/database');

// Verifica JWT e carica permessi utente
function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autenticato' });
  try {
    req.user = jwt.verify(token, process.env.SESSION_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token non valido' });
  }
}

// Factory: richiede permesso specifico su sezione
function requirePermesso(sezione, azione) {
  return (req, res, next) => {
    // Superuser (ruolo_id=4) passa sempre
    if (req.user?.ruolo_id === 4) return next();
    const perm = db.prepare(
      'SELECT * FROM permessi WHERE ruolo_id = ? AND sezione = ?'
    ).get(req.user?.ruolo_id, sezione);
    if (!perm || !perm[`can_${azione}`]) {
      return res.status(403).json({ error: `Permesso negato: ${azione} su ${sezione}` });
    }
    next();
  };
}

module.exports = { authMiddleware, requirePermesso };
