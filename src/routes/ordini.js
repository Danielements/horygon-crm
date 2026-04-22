const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const db = require('../db/database');
const { authMiddleware, requirePermesso } = require('../middleware/auth');

const s = (v) => (v === undefined || v === '' || v === null) ? null : v;
const n = (v) => { const p = parseFloat(v); return isNaN(p) ? null : p; };
const i = (v) => { const p = parseInt(v); return isNaN(p) ? null : p; };

// Upload allegati ordini
const storageOrdini = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/ordini';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).substring(2)}${ext}`);
  }
});
const uploadOrdine = multer({ storage: storageOrdini, limits: { fileSize: 20 * 1024 * 1024 } });

// Aggiorna schema ordini con campi tracking se non esistono
db.exec(`
  CREATE TABLE IF NOT EXISTS ordini_allegati (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ordine_id INTEGER NOT NULL,
    tipo TEXT DEFAULT 'foto',
    nome_file TEXT, path TEXT,
    caricato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (ordine_id) REFERENCES ordini(id) ON DELETE CASCADE
  );
`);

// Aggiungi colonne tracking se non esistono
try { db.exec(`ALTER TABLE ordini ADD COLUMN numero_spedizione TEXT`); } catch {}
try { db.exec(`ALTER TABLE ordini ADD COLUMN corriere TEXT`); } catch {}
try { db.exec(`ALTER TABLE ordini ADD COLUMN tracking_data TEXT`); } catch {}
try { db.exec(`ALTER TABLE ordini ADD COLUMN tracking_stato TEXT`); } catch {}
try { db.exec(`ALTER TABLE ordini ADD COLUMN tracking_aggiornato TEXT`); } catch {}

router.use(authMiddleware);

// Lista ordini
router.get('/', (req, res) => {
  const { tipo, stato, anagrafica_id } = req.query;
  let sql = `SELECT o.*, a.ragione_sociale FROM ordini o
    LEFT JOIN anagrafiche a ON a.id = o.anagrafica_id WHERE 1=1`;
  const params = [];
  if (tipo) { sql += ' AND o.tipo = ?'; params.push(tipo); }
  if (stato) { sql += ' AND o.stato = ?'; params.push(stato); }
  if (anagrafica_id) { sql += ' AND o.anagrafica_id = ?'; params.push(anagrafica_id); }
  res.json(db.prepare(sql + ' ORDER BY o.creato_il DESC').all(...params));
});

// Singolo ordine
router.get('/:id', (req, res) => {
  const o = db.prepare(`SELECT o.*, a.ragione_sociale FROM ordini o
    LEFT JOIN anagrafiche a ON a.id = o.anagrafica_id WHERE o.id = ?`).get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Non trovato' });
  o.righe = db.prepare(`SELECT r.*, p.nome, p.codice_interno FROM ordini_righe r
    JOIN prodotti p ON p.id = r.prodotto_id WHERE r.ordine_id = ?`).all(req.params.id);
  o.allegati = db.prepare('SELECT * FROM ordini_allegati WHERE ordine_id = ? ORDER BY caricato_il DESC').all(req.params.id);
  res.json(o);
});

// Crea ordine
router.post('/', requirePermesso('ordini', 'edit'), (req, res) => {
  const b = req.body || {};
  try {
    const r = db.prepare(`
      INSERT INTO ordini (codice_ordine,tipo,anagrafica_id,canale,data_ordine,data_consegna_prevista,totale,note,numero_spedizione,corriere)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(s(b.codice_ordine), s(b.tipo), i(b.anagrafica_id), s(b.canale),
           s(b.data_ordine), s(b.data_consegna_prevista), n(b.totale), s(b.note),
           s(b.numero_spedizione), s(b.corriere));
    const id = r.lastInsertRowid;
    if (b.righe?.length) {
      const ins = db.prepare('INSERT INTO ordini_righe (ordine_id,prodotto_id,quantita,prezzo_unitario,sconto) VALUES (?,?,?,?,?)');
      b.righe.forEach(riga => {
        ins.run(id, i(riga.prodotto_id), i(riga.quantita), n(riga.prezzo_unitario), n(riga.sconto) || 0);
        if (b.tipo === 'vendita') {
          db.prepare('INSERT INTO magazzino_movimenti (prodotto_id,tipo,quantita,riferimento_tipo,riferimento_id) VALUES (?,?,?,?,?)')
            .run(i(riga.prodotto_id), 'scarico', i(riga.quantita), 'ordine', id);
        }
      });
    }
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Aggiorna stato
router.patch('/:id/stato', requirePermesso('ordini', 'edit'), (req, res) => {
  db.prepare('UPDATE ordini SET stato=? WHERE id=?').run(s(req.body.stato), req.params.id);
  res.json({ ok: true });
});

// Aggiorna tracking
router.patch('/:id/tracking', requirePermesso('ordini', 'edit'), (req, res) => {
  const { numero_spedizione, corriere } = req.body || {};
  db.prepare('UPDATE ordini SET numero_spedizione=?, corriere=? WHERE id=?')
    .run(s(numero_spedizione), s(corriere), req.params.id);
  res.json({ ok: true });
});

// Upload foto/allegati ordine
router.post('/:id/allegati', requirePermesso('ordini', 'edit'), uploadOrdine.array('files', 10), (req, res) => {
  const tipo = req.body.tipo || 'foto';
  const results = [];
  for (const file of req.files || []) {
    const filePath = `/uploads/ordini/${file.filename}`;
    const r = db.prepare('INSERT INTO ordini_allegati (ordine_id,tipo,nome_file,path) VALUES (?,?,?,?)')
      .run(req.params.id, tipo, file.originalname, filePath);
    results.push({ id: r.lastInsertRowid, path: filePath, nome: file.originalname });
  }
  res.json({ ok: true, files: results });
});

// Elimina allegato
router.delete('/:id/allegati/:allegId', requirePermesso('ordini', 'edit'), (req, res) => {
  const all = db.prepare('SELECT * FROM ordini_allegati WHERE id = ?').get(req.params.allegId);
  if (all?.path) { const fp = '.' + all.path; if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  db.prepare('DELETE FROM ordini_allegati WHERE id = ?').run(req.params.allegId);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════
// TRACKING CORRIERI
// ═══════════════════════════════════════════════
router.get('/:id/tracking', async (req, res) => {
  const ordine = db.prepare('SELECT numero_spedizione, corriere, tracking_data, tracking_aggiornato FROM ordini WHERE id = ?').get(req.params.id);
  if (!ordine) return res.status(404).json({ error: 'Ordine non trovato' });
  if (!ordine.numero_spedizione) return res.json({ stato: 'Nessun numero spedizione', eventi: [] });

  // Cache tracking per 1 ora
  const now = Date.now();
  const ultimoAgg = ordine.tracking_aggiornato ? new Date(ordine.tracking_aggiornato).getTime() : 0;
  if (ordine.tracking_data && (now - ultimoAgg) < 3600000) {
    try { return res.json(JSON.parse(ordine.tracking_data)); } catch {}
  }

  // Chiama API corriere
  let trackingResult = null;
  const corriere = (ordine.corriere || '').toLowerCase();
  const numero = ordine.numero_spedizione;

  try {
    if (corriere.includes('gls')) {
      trackingResult = await trackGLS(numero);
    } else if (corriere.includes('brt') || corriere.includes('bartolini')) {
      trackingResult = await trackBRT(numero);
    } else if (corriere.includes('sda')) {
      trackingResult = await trackSDA(numero);
    } else if (corriere.includes('poste') || corriere.includes('italiane')) {
      trackingResult = await trackPoste(numero);
    } else if (corriere.includes('dhl')) {
      trackingResult = await trackDHL(numero);
    } else if (corriere.includes('fedex')) {
      trackingResult = await trackFedex(numero);
    } else {
      // Tenta con 17track (servizio aggregatore gratuito)
      trackingResult = await track17(numero, corriere);
    }
  } catch (e) {
    console.error('Tracking error:', e.message);
    trackingResult = { stato: 'Errore recupero tracking', errore: e.message, numero, corriere };
  }

  if (trackingResult) {
    db.prepare('UPDATE ordini SET tracking_data=?, tracking_stato=?, tracking_aggiornato=? WHERE id=?')
      .run(JSON.stringify(trackingResult), s(trackingResult.stato), new Date().toISOString(), req.params.id);
  }

  res.json(trackingResult || { stato: 'Nessun dato', eventi: [] });
});

// ── Funzioni tracking corrieri ──────────────────

async function track17(numero, corriere) {
  // 17track API (richiede API key gratuita su 17track.net/en/api)
  const apiKey = process.env.TRACK17_API_KEY;
  if (!apiKey) return { stato: 'API key 17track non configurata', info: 'Aggiungi TRACK17_API_KEY nel .env', numero };

  return new Promise((resolve) => {
    const body = JSON.stringify([{ number: numero, carrier: corriere || '' }]);
    const req = https.request({
      hostname: 'api.17track.net', path: '/track/v2/getnewupdates',
      method: 'POST',
      headers: { '17token': apiKey, 'Content-Type': 'application/json', 'Content-Length': body.length }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const track = json.data?.accepted?.[0];
          if (!track) { resolve({ stato: 'Tracking non trovato', numero }); return; }
          const eventi = (track.track?.z || []).map(e => ({
            data: e.a,
            descrizione: e.z || e.d || '',
            luogo: e.c || '',
          }));
          resolve({
            numero,
            corriere: track.carrier_code || corriere,
            stato: track.track?.e?.name || 'In transito',
            eventi: eventi.reverse(),
          });
        } catch { resolve({ stato: 'Errore parsing', numero }); }
      });
    });
    req.on('error', () => resolve({ stato: 'Errore connessione', numero }));
    req.write(body); req.end();
  });
}

async function trackGLS(numero) {
  // GLS tracking pubblico
  return new Promise((resolve) => {
    const url = `https://gls-group.eu/track/${numero}`;
    resolve({ stato: 'Vedi sito GLS', link: url, numero, suggerimento: 'GLS non ha API pubblica. Visualizza su sito.' });
  });
}

async function trackBRT(numero) {
  return { stato: 'Vedi sito BRT/Bartolini', link: `https://www.brt.it/it/search.html?parcelId=${numero}`, numero };
}

async function trackSDA(numero) {
  return { stato: 'Vedi sito SDA', link: `https://www.sda.it/wps/portal/Servizi_online/Cerca-spedizione?codicespedizione=${numero}`, numero };
}

async function trackPoste(numero) {
  return { stato: 'Vedi Poste Italiane', link: `https://www.poste.it/online/dovequando/tracking.do?ID=${numero}`, numero };
}

async function trackDHL(numero) {
  const url = `https://api-eu.dhl.com/track/shipments?trackingNumber=${numero}`;
  return { stato: 'DHL', link: `https://www.dhl.com/it-it/home/tracking.html?tracking-id=${numero}`, numero, nota: 'Configura DHL_API_KEY nel .env per tracking live' };
}

async function trackFedex(numero) {
  return { stato: 'FedEx', link: `https://www.fedex.com/apps/fedextrack/?tracknumbers=${numero}`, numero };
}

module.exports = router;
