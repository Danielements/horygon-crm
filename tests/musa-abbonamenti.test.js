const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDb = path.join(os.tmpdir(), `horygon-musaabb-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const abb = require('../src/services/musa-abbonamenti-service');
const db = require('../src/db/database');

test.after(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch {} } });

const FASCE = [
  { id: 1, nome: 'MUSA BASIC', min_isbn: 1, max_isbn: 8, prezzo_mese: 4.90, gratis: 0, attiva: 1 },
  { id: 2, nome: 'MUSA PRO', min_isbn: 9, max_isbn: 24, prezzo_mese: 12.90, gratis: 0, attiva: 1 },
  { id: 3, nome: 'MUSA PREMIUM', min_isbn: 25, max_isbn: 100, prezzo_mese: 24.90, gratis: 0, attiva: 1 },
  { id: 4, nome: 'MUSA ENTERPRISE', min_isbn: 101, max_isbn: 400, prezzo_mese: 42.90, gratis: 0, attiva: 1 },
  { id: 5, nome: 'MUSA UNLIMITED', min_isbn: 401, max_isbn: null, prezzo_mese: 0, gratis: 1, min_approvati_perc: 20, attiva: 1 }
];

// --- puri ------------------------------------------------------------------

test('pickFascia: estremi di fascia inclusi', () => {
  assert.equal(abb.pickFascia(0, 0, FASCE), null);
  assert.equal(abb.pickFascia(8, 0, FASCE).nome, 'MUSA BASIC');
  assert.equal(abb.pickFascia(9, 0, FASCE).nome, 'MUSA PRO');
  assert.equal(abb.pickFascia(24, 0, FASCE).nome, 'MUSA PRO');
  assert.equal(abb.pickFascia(25, 0, FASCE).nome, 'MUSA PREMIUM');
  assert.equal(abb.pickFascia(100, 0, FASCE).nome, 'MUSA PREMIUM');
  assert.equal(abb.pickFascia(101, 0, FASCE).nome, 'MUSA ENTERPRISE');
  assert.equal(abb.pickFascia(400, 0, FASCE).nome, 'MUSA ENTERPRISE');
});

test('pickFascia: oltre 400 gratis solo con >=20% approvati, altrimenti ENTERPRISE', () => {
  const gratis = abb.pickFascia(420, 25, FASCE);
  assert.equal(gratis.gratis, true);
  assert.equal(gratis.prezzo_mese, 0);
  assert.equal(gratis.qualificata_gratis, true);

  const nonQualificato = abb.pickFascia(420, 10, FASCE);
  assert.equal(nonQualificato.gratis, false);
  assert.equal(nonQualificato.prezzo_mese, 42.90);     // fallback ENTERPRISE
  assert.equal(nonQualificato.fallback, true);
});

test('daysInMonth', () => {
  assert.equal(abb.daysInMonth('2026-02-10'), 28);
  assert.equal(abb.daysInMonth('2026-03-01'), 31);
  assert.equal(abb.daysInMonth('2024-02-01'), 29);     // bisestile
});

test('countsOnDay: presenza e approvati rispettano le date', () => {
  const rec = [
    { isbn: 'a', inserito_il: '2026-01-10', rimosso_il: null, approvato: 1, approvato_il: '2026-01-20' },
    { isbn: 'b', inserito_il: '2026-02-01', rimosso_il: '2026-02-15', approvato: 0 }
  ];
  assert.deepEqual(abb.countsOnDay(rec, '2026-01-09'), { present: 0, approved: 0 });
  assert.deepEqual(abb.countsOnDay(rec, '2026-01-15'), { present: 1, approved: 0 }); // non ancora approvato
  assert.deepEqual(abb.countsOnDay(rec, '2026-01-20'), { present: 1, approved: 1 });
  assert.deepEqual(abb.countsOnDay(rec, '2026-02-10'), { present: 2, approved: 1 });
  assert.deepEqual(abb.countsOnDay(rec, '2026-02-15'), { present: 1, approved: 1 }); // 'b' rimosso dal giorno stesso
});

test('ESEMPIO: BASIC 8 ISBN, 9o inserito il 1 marzo -> trimestre = 4,90+4,90+12,90 = 22,70', () => {
  const rec = [];
  for (let i = 0; i < 8; i++) rec.push({ isbn: `base${i}`, inserito_il: '2025-12-01', rimosso_il: null, approvato: 0 });
  rec.push({ isbn: 'nono', inserito_il: '2026-03-01', rimosso_il: null, approvato: 0 });
  const r = abb.computePeriodo(rec, '2026-01-01', '2026-03-31', FASCE);
  assert.equal(r.dovuto, 22.70);
  assert.equal(r.giorni_per_fascia['MUSA BASIC'].giorni, 59);  // gen 31 + feb 28
  assert.equal(r.giorni_per_fascia['MUSA PRO'].giorni, 31);    // marzo
  // gli importi per fascia devono sommare al dovuto (niente deriva di arrotondamento)
  assert.equal(r.giorni_per_fascia['MUSA BASIC'].importo, 9.80);
  assert.equal(r.giorni_per_fascia['MUSA PRO'].importo, 12.90);
  const somma = abb.round2(Object.values(r.giorni_per_fascia).reduce((s, x) => s + x.importo, 0));
  assert.equal(somma, r.dovuto);
});

test('ESEMPIO discesa: 9o rimosso a meta marzo torna a BASIC per i giorni restanti', () => {
  const rec = [];
  for (let i = 0; i < 8; i++) rec.push({ isbn: `base${i}`, inserito_il: '2025-12-01', rimosso_il: null, approvato: 0 });
  rec.push({ isbn: 'nono', inserito_il: '2026-03-01', rimosso_il: '2026-03-16', approvato: 0 });
  const r = abb.computePeriodo(rec, '2026-01-01', '2026-03-31', FASCE);
  // gen+feb BASIC = 9,80; mar: 15gg PRO (1-15) + 16gg BASIC (16-31)
  const atteso = abb.round2(4.90 + 4.90 + 15 * 12.90 / 31 + 16 * 4.90 / 31);
  assert.equal(r.dovuto, atteso);
  assert.ok(r.dovuto > 9.80 && r.dovuto < 22.70);
});

// --- integrazione (fasce auto-seedate su DB fresco) ------------------------

test('syncPortale: normalizza email-oggetto, segnala duplicati/invalidi/mismatch', () => {
  const payload = {
    generato_il: '2026-10-04T15:00:00+02:00',
    editori: [{
      external_id: 'SYNC-1',
      ragione_sociale: 'PAV edizioni',
      partita_iva: null,
      email: { email: 'direzione@pavedizioni.it', autore_dice: '' },   // email come oggetto
      isbn: [
        { isbn: '9791281497344', titolo: 'A', inserito_il: '2026-01-10T10:00:00+01:00', rimosso_il: null, approvato: true, approvato_il: null },
        { isbn: '9791281497344', titolo: 'A dup', inserito_il: '2026-01-10T10:00:00+01:00', approvato: true },   // duplicato
        { isbn: '123', titolo: 'rotto', inserito_il: '2026-02-01T10:00:00+01:00', approvato: false }               // ISBN non valido
      ],
      riepilogo: { isbn_presenti: 3, isbn_approvati: 2 }
    }]
  };
  const r = abb.syncPortale(payload, '2026-10-04');
  assert.equal(r.editori, 1);
  const d = r.dettaglio[0];
  assert.equal(d.presenti, 2);                 // duplicato contato una volta
  assert.equal(d.portale_presenti, 3);
  assert.equal(d.match, false);                // 2 != 3
  // email normalizzata da oggetto a stringa
  const ed = db.prepare("SELECT email FROM musa_editori WHERE external_id='SYNC-1'").get();
  assert.equal(ed.email, 'direzione@pavedizioni.it');
  // avvisi presenti
  const testo = r.warnings.join(' | ');
  assert.match(testo, /duplicati/);
  assert.match(testo, /non validi/);
  assert.match(testo, /partita IVA assente/);
});

test('pullDalPortale: scarica (fetchFn iniettato) + mappa indirizzo/cod.dest/iban', async () => {
  const payload = {
    generato_il: '2026-10-05T14:00:00+02:00',
    editori: [{
      external_id: 'PULL-1', ragione_sociale: 'Arbor Libri', partita_iva: '07938880726',
      indirizzo: 'Via dei Libri 1, Bari', codice_destinatario: 'BA6ET11', iban: null, email: null,
      isbn: [
        { isbn: '9791281497344', inserito_il: '2026-05-14T17:52:47+02:00', approvato: true, approvato_il: null },
        { isbn: '9791281497085', inserito_il: '2026-01-27T17:30:59+01:00', approvato: true }
      ],
      riepilogo: { isbn_presenti: 2, isbn_approvati: 2 }
    }]
  };
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => payload });
  const r = await abb.pullDalPortale({ url: 'https://esempio/export?key=x', fetchFn: fakeFetch, oggi: '2026-10-05' });
  assert.equal(r.editori, 1);
  assert.equal(r.dettaglio[0].presenti, 2);
  const ed = db.prepare("SELECT piva, indirizzo, codice_destinatario FROM musa_editori WHERE external_id='PULL-1'").get();
  assert.equal(ed.piva, '07938880726');
  assert.equal(ed.indirizzo, 'Via dei Libri 1, Bari');
  assert.equal(ed.codice_destinatario, 'BA6ET11');
});

test('governance: il sync rileva eventi (nuovo editore, cambio fascia, P.IVA)', () => {
  const mk = (n, extra = {}) => { const isbn = []; for (let i = 0; i < n; i++) isbn.push({ isbn: String(9790000000000 + i), inserito_il: '2026-01-01', approvato: true }); return { external_id: 'EV1', ragione_sociale: 'Governance Ed', isbn, riepilogo: { isbn_presenti: n, isbn_approvati: n }, ...extra }; };
  // Sync 1: nuovo editore con 2 ISBN -> BASIC
  const r1 = abb.syncPortale({ editori: [mk(2)] }, '2026-10-05');
  const t1 = r1.eventi.map(e => e.tipo);
  assert.ok(t1.includes('editore_nuovo'));
  assert.ok(t1.includes('isbn_aggiunto'));
  // Sync 2: sale a 10 ISBN (PRO) e arriva la P.IVA
  const r2 = abb.syncPortale({ editori: [mk(10, { partita_iva: '01234567890' })] }, '2026-10-05');
  const t2 = r2.eventi.map(e => e.tipo);
  assert.ok(t2.includes('fascia_su'), 'atteso fascia_su BASIC->PRO');
  assert.ok(t2.includes('piva_arrivata'));
  const salita = r2.eventi.find(e => e.tipo === 'fascia_su');
  assert.equal(salita.fascia_a, 'MUSA PRO');
  // il registro contiene gli eventi
  assert.ok(abb.listEventi(50).length >= 4);
});

test('fetchPortale: errore chiaro senza URL', async () => {
  const prev = process.env.MUSA_PORTALE_URL; delete process.env.MUSA_PORTALE_URL;
  await assert.rejects(() => abb.fetchPortale(), /MUSA_PORTALE_URL non configurato/);
  if (prev) process.env.MUSA_PORTALE_URL = prev;
});

test('fasce seedate all\'avvio e calcolaTrimestre legge dal DB', () => {
  const fasce = abb.listFasce();
  assert.equal(fasce.length, 5);
  assert.equal(fasce[0].nome, 'MUSA BASIC');

  const e = Number(db.prepare("INSERT INTO musa_editori (nome) VALUES ('Editore X')").run().lastInsertRowid);
  for (let i = 0; i < 8; i++) abb.upsertIsbn(e, { isbn: `x${i}`, inserito_il: '2025-12-01' });
  abb.upsertIsbn(e, { isbn: 'x-nono', inserito_il: '2026-03-01' });
  const calc = abb.calcolaTrimestre(e, 2026, 1);
  assert.equal(calc.dovuto, 22.70);
  assert.equal(calc.credito_disponibile, 0);
  assert.equal(calc.importo_netto, 22.70);
});
