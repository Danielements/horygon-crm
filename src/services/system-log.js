const db = require('../db/database');

function safeJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ note: 'serialization_failed' });
  }
}

function writeSystemLog({
  livello = 'error',
  origine = 'app',
  route = null,
  metodo = null,
  status_code = null,
  utente_id = null,
  messaggio,
  stack = null,
  dettagli = null
}) {
  if (!messaggio) return;
  try {
    db.prepare(`
      INSERT INTO system_log
      (livello, origine, route, metodo, status_code, utente_id, messaggio, stack, dettagli)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      livello,
      origine,
      route,
      metodo,
      status_code,
      utente_id,
      String(messaggio).slice(0, 2000),
      stack ? String(stack).slice(0, 12000) : null,
      safeJson(dettagli)
    );
  } catch {}
}

function listSystemLogs({
  level = '',
  origin = '',
  q = '',
  limit = 200
} = {}) {
  let sql = `
    SELECT l.*, u.nome AS utente_nome, u.email AS utente_email
    FROM system_log l
    LEFT JOIN utenti u ON u.id = l.utente_id
    WHERE 1=1
  `;
  const params = [];
  if (level) {
    sql += ' AND l.livello = ?';
    params.push(level);
  }
  if (origin) {
    sql += ' AND lower(COALESCE(l.origine, \'\')) LIKE ?';
    params.push(`%${String(origin).toLowerCase()}%`);
  }
  if (q) {
    sql += ' AND (lower(COALESCE(l.messaggio, \'\')) LIKE ? OR lower(COALESCE(l.route, \'\')) LIKE ? OR lower(COALESCE(l.dettagli, \'\')) LIKE ?)';
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY l.id DESC LIMIT ?';
  params.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));
  return db.prepare(sql).all(...params);
}

function clearSystemLogs() {
  return db.prepare('DELETE FROM system_log').run();
}

module.exports = { writeSystemLog, listSystemLogs, clearSystemLogs };
