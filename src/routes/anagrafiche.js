const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');

router.use(authMiddleware);

// Sanitizza un valore per SQLite DatabaseSync (no undefined, no NaN)
function s(v) { return (v === undefined || v === '' || v === null) ? null : v; }
function n(v) { const p = parseFloat(v); return isNaN(p) ? null : p; }
function i(v) { const p = parseInt(v); return isNaN(p) ? null : p; }

try { db.exec(`ALTER TABLE anagrafiche ADD COLUMN canale_cliente TEXT DEFAULT 'privato'`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche ADD COLUMN tipologia_cliente TEXT DEFAULT 'privato'`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche ADD COLUMN pa_mepa INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche ADD COLUMN pa_sda INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE anagrafiche ADD COLUMN pa_rdo INTEGER DEFAULT 0`); } catch {}

router.get('/', (req, res) => {
  const { tipo, q } = req.query;
  let sql = 'SELECT * FROM anagrafiche WHERE attivo = 1';
  const params = [];
  if (tipo) { sql += ' AND tipo = ?'; params.push(tipo); }
  if (q) { sql += ' AND ragione_sociale LIKE ?'; params.push(`%${q}%`); }
  res.json(db.prepare(sql + ' ORDER BY ragione_sociale').all(...params));
});

router.get('/pa/mappa', (req, res) => {
  res.json(db.prepare(`
    SELECT a.*, p.categoria_pa FROM anagrafiche a
    LEFT JOIN pa_dettagli p ON p.anagrafica_id = a.id
    WHERE a.tipo = 'pa' AND a.lat IS NOT NULL AND a.attivo = 1
  `).all());
});

router.get('/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM anagrafiche WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Non trovato' });
  a.contatti = db.prepare('SELECT * FROM anagrafiche_contatti WHERE anagrafica_id = ?').all(req.params.id);
  if (a.tipo === 'pa') a.pa_dettagli = db.prepare('SELECT * FROM pa_dettagli WHERE anagrafica_id = ?').get(req.params.id);
  res.json(a);
});

router.post('/', requirePermesso('clienti', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    const r = db.prepare(`
      INSERT INTO anagrafiche
      (tipo,ragione_sociale,piva,cf,indirizzo,cap,citta,provincia,paese,lat,lng,email,pec,telefono,sito_web,note,canale_cliente,tipologia_cliente,pa_mepa,pa_sda,pa_rdo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      s(b.tipo) || 'cliente',
      s(b.ragione_sociale),
      s(b.piva), s(b.cf),
      s(b.indirizzo), s(b.cap), s(b.citta), s(b.provincia),
      s(b.paese) || 'IT',
      n(b.lat), n(b.lng),
      s(b.email), s(b.pec), s(b.telefono), s(b.sito_web), s(b.note), s(b.canale_cliente) || 'privato',
      s(b.tipologia_cliente) || 'privato',
      b.pa_mepa ? 1 : 0,
      b.pa_sda ? 1 : 0,
      b.pa_rdo ? 1 : 0
    );
    const id = r.lastInsertRowid;
    if (b.tipo === 'pa' && b.pa_dettagli) {
      db.prepare(`INSERT OR IGNORE INTO pa_dettagli (anagrafica_id,codice_ipa,codice_univoco_sdi,categoria_pa,cpv_abituali) VALUES (?,?,?,?,?)`)
        .run(id, s(b.pa_dettagli.codice_ipa), s(b.pa_dettagli.codice_univoco_sdi), s(b.pa_dettagli.categoria_pa), s(b.pa_dettagli.cpv_abituali));
    }
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', requirePermesso('clienti', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    db.prepare(`
      UPDATE anagrafiche SET
        ragione_sociale=?,piva=?,cf=?,indirizzo=?,cap=?,citta=?,provincia=?,paese=?,
        lat=?,lng=?,email=?,pec=?,telefono=?,sito_web=?,note=?,canale_cliente=?,tipologia_cliente=?,pa_mepa=?,pa_sda=?,pa_rdo=?,attivo=?
      WHERE id=?
    `).run(
      s(b.ragione_sociale), s(b.piva), s(b.cf),
      s(b.indirizzo), s(b.cap), s(b.citta), s(b.provincia),
      s(b.paese) || 'IT',
      n(b.lat), n(b.lng),
      s(b.email), s(b.pec), s(b.telefono), s(b.sito_web), s(b.note), s(b.canale_cliente) || 'privato',
      s(b.tipologia_cliente) || 'privato',
      b.pa_mepa ? 1 : 0,
      b.pa_sda ? 1 : 0,
      b.pa_rdo ? 1 : 0,
      b.attivo !== undefined ? i(b.attivo) : 1,
      req.params.id
    );
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', requirePermesso('clienti', 'delete'), (req, res) => {
  db.prepare('UPDATE anagrafiche SET attivo = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
