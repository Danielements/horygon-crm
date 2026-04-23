const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const { syncSingleContactToGoogle } = require('../services/google');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

router.use(authMiddleware);

try {
  const info = db.prepare(`PRAGMA table_info(anagrafiche_contatti)`).all();
  const anagraficaCol = info.find(c => c.name === 'anagrafica_id');
  if (anagraficaCol && anagraficaCol.notnull) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      CREATE TABLE IF NOT EXISTS anagrafiche_contatti_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        anagrafica_id INTEGER,
        nome TEXT NOT NULL,
        ruolo TEXT,
        telefono TEXT,
        email TEXT,
        note TEXT,
        google_resource_name TEXT,
        linked_user_id INTEGER,
        visibile_esterno INTEGER DEFAULT 0,
        attivo INTEGER DEFAULT 1,
        creato_il TEXT DEFAULT (datetime('now')),
        cognome TEXT,
        avatar_path TEXT,
        FOREIGN KEY (anagrafica_id) REFERENCES anagrafiche(id) ON DELETE CASCADE
      );
      INSERT INTO anagrafiche_contatti_new (
        id, anagrafica_id, nome, ruolo, telefono, email, note,
        google_resource_name, linked_user_id, visibile_esterno, attivo, creato_il, cognome, avatar_path
      )
      SELECT
        id, anagrafica_id, nome, ruolo, telefono, email, note,
        google_resource_name, linked_user_id, COALESCE(visibile_esterno, 0),
        COALESCE(attivo, 1), COALESCE(creato_il, datetime('now')), cognome, avatar_path
      FROM anagrafiche_contatti;
      DROP TABLE anagrafiche_contatti;
      ALTER TABLE anagrafiche_contatti_new RENAME TO anagrafiche_contatti;
    `);
    db.exec('PRAGMA foreign_keys = ON');
  }
} catch {}

try { db.exec(`ALTER TABLE anagrafiche_contatti ADD COLUMN google_resource_name TEXT`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche_contatti ADD COLUMN linked_user_id INTEGER`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche_contatti ADD COLUMN visibile_esterno INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche_contatti ADD COLUMN attivo INTEGER DEFAULT 1`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche_contatti ADD COLUMN creato_il TEXT DEFAULT (datetime('now'))`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche_contatti ADD COLUMN cognome TEXT`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche_contatti ADD COLUMN avatar_path TEXT`); } catch {}

function s(v) { return (v === undefined || v === '' || v === null) ? null : v; }
function i(v) { const p = parseInt(v); return isNaN(p) ? null : p; }

const storageContatti = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/contatti';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `contatto-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const uploadContatto = multer({ storage: storageContatti });

router.get('/', requirePermesso('clienti', 'read'), (req, res) => {
  const { q } = req.query;
  let sql = `
    SELECT c.*, a.ragione_sociale AS anagrafica_nome, a.ragione_sociale AS organizzazione, u.nome AS linked_user_nome
    FROM anagrafiche_contatti c
    LEFT JOIN anagrafiche a ON a.id = c.anagrafica_id
    LEFT JOIN utenti u ON u.id = c.linked_user_id
    WHERE COALESCE(c.attivo, 1) = 1
  `;
  const params = [];
  if (q) {
    sql += ` AND (
      c.nome LIKE ? OR
      c.cognome LIKE ? OR
      c.email LIKE ? OR
      c.telefono LIKE ? OR
      c.ruolo LIKE ? OR
      a.ragione_sociale LIKE ?
    )`;
    const term = `%${q}%`;
    params.push(term, term, term, term, term, term);
  }
  sql += " ORDER BY COALESCE(c.cognome, ''), c.nome, c.id";
  res.json(db.prepare(sql).all(...params));
});

router.get('/meta', requirePermesso('clienti', 'read'), (req, res) => {
  const anagrafiche = db.prepare(`
    SELECT id, ragione_sociale, tipo
    FROM anagrafiche
    WHERE attivo = 1
    ORDER BY ragione_sociale
  `).all();
  const utenti = db.prepare(`
    SELECT id, nome, email
    FROM utenti
    WHERE attivo = 1
    ORDER BY nome
  `).all();
  res.json({ anagrafiche, utenti });
});

router.get('/:id', requirePermesso('clienti', 'read'), (req, res) => {
  const row = db.prepare(`
    SELECT c.*, a.ragione_sociale AS anagrafica_nome, a.ragione_sociale AS organizzazione, u.nome AS linked_user_nome
    FROM anagrafiche_contatti c
    LEFT JOIN anagrafiche a ON a.id = c.anagrafica_id
    LEFT JOIN utenti u ON u.id = c.linked_user_id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Contatto non trovato' });
  res.json(row);
});

router.post('/', requirePermesso('clienti', 'edit'), (req, res) => {
  const b = req.body || {};
  const r = db.prepare(`
    INSERT INTO anagrafiche_contatti
    (anagrafica_id, nome, cognome, ruolo, telefono, email, note, linked_user_id, visibile_esterno, attivo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    i(b.anagrafica_id),
    s(b.nome),
    s(b.cognome),
    s(b.ruolo),
    s(b.telefono),
    s(b.email),
    s(b.note),
    i(b.linked_user_id),
    b.visibile_esterno ? 1 : 0
  );
  res.json({ id: r.lastInsertRowid });
});

router.put('/:id', requirePermesso('clienti', 'edit'), (req, res) => {
  const b = req.body || {};
  db.prepare(`
    UPDATE anagrafiche_contatti
    SET anagrafica_id = ?, nome = ?, cognome = ?, ruolo = ?, telefono = ?, email = ?, note = ?,
        linked_user_id = ?, visibile_esterno = ?, attivo = COALESCE(?, attivo)
    WHERE id = ?
  `).run(
    i(b.anagrafica_id),
    s(b.nome),
    s(b.cognome),
    s(b.ruolo),
    s(b.telefono),
    s(b.email),
    s(b.note),
    i(b.linked_user_id),
    b.visibile_esterno ? 1 : 0,
    b.attivo === undefined ? null : (b.attivo ? 1 : 0),
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/:id', requirePermesso('clienti', 'delete'), (req, res) => {
  db.prepare('UPDATE anagrafiche_contatti SET attivo = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/:id/avatar', requirePermesso('clienti', 'edit'), uploadContatto.single('avatar'), (req, res) => {
  const row = db.prepare('SELECT avatar_path FROM anagrafiche_contatti WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Contatto non trovato' });
  if (!req.file) return res.status(400).json({ error: 'Nessun file caricato' });
  if (row.avatar_path) {
    const full = '.' + row.avatar_path;
    if (fs.existsSync(full)) {
      try { fs.unlinkSync(full); } catch {}
    }
  }
  const avatarPath = `/uploads/contatti/${req.file.filename}`;
  db.prepare('UPDATE anagrafiche_contatti SET avatar_path = ? WHERE id = ?').run(avatarPath, req.params.id);
  res.json({ ok: true, avatar_path: avatarPath });
});

router.post('/:id/sync-google', requirePermesso('clienti', 'edit'), async (req, res) => {
  try {
    const result = await syncSingleContactToGoogle(req.user.id, req.params.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
