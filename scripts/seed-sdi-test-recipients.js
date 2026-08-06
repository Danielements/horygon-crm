const db = require('../src/db/database');

const TEST_ENDPOINT = 'https://sdi.horygon.it/api/sdi/ws/inbound';

const RECIPIENTS = [
  {
    tipo: 'pa',
    ragione_sociale: 'PA TEST SDI ESOJKL',
    piva: 'IT90000000001',
    cf: '90000000001',
    codice_destinatario: 'ESOJKL',
    codice_ipa: 'ESOJKL',
    note: 'Anagrafica TEST SdI PA per interoperabilita. Endpoint: ' + TEST_ENDPOINT
  },
  {
    tipo: 'pa',
    ragione_sociale: 'PA TEST SDI VRRMFL',
    piva: 'IT90000000002',
    cf: '90000000002',
    codice_destinatario: 'VRRMFL',
    codice_ipa: 'VRRMFL',
    note: 'Anagrafica TEST SdI PA per interoperabilita. Endpoint: ' + TEST_ENDPOINT
  },
  {
    tipo: 'pa',
    ragione_sociale: 'PA TEST SDI ESOWLS',
    piva: 'IT90000000003',
    cf: '90000000003',
    codice_destinatario: 'ESOWLS',
    codice_ipa: 'ESOWLS',
    note: 'Anagrafica TEST SdI PA per interoperabilita. Endpoint: ' + TEST_ENDPOINT
  },
  {
    tipo: 'cliente',
    ragione_sociale: 'CLIENTE TEST SDI UMZGLCP',
    piva: 'IT01043931003',
    cf: '01043931003',
    codice_destinatario: 'UMZGLCP',
    note: 'Anagrafica TEST SdI B2B per interoperabilita. Endpoint: ' + TEST_ENDPOINT
  },
  {
    tipo: 'cliente',
    ragione_sociale: 'CLIENTE TEST SDI TLYFKZO',
    piva: 'IT01043931004',
    cf: '01043931004',
    codice_destinatario: 'TLYFKZO',
    note: 'Anagrafica TEST SdI B2B per interoperabilita. Endpoint: ' + TEST_ENDPOINT
  },
  {
    tipo: 'cliente',
    ragione_sociale: 'CLIENTE TEST SDI SKXEJYN',
    piva: 'IT01043931005',
    cf: '01043931005',
    codice_destinatario: 'SKXEJYN',
    note: 'Anagrafica TEST SdI B2B per interoperabilita. Endpoint: ' + TEST_ENDPOINT
  }
];

const ADDRESS = {
  indirizzo: 'Via Test SdI 1',
  cap: '00100',
  citta: 'Roma',
  provincia: 'RM',
  paese: 'IT',
  email: 'test-sdi@example.com',
  pec: ''
};

ensureColumns();

let created = 0;
let updated = 0;

try {
  db.exec('BEGIN');
  for (const recipient of RECIPIENTS) {
    const result = upsertRecipient(recipient);
    if (result.created) created += 1;
    else updated += 1;
  }
  db.exec('COMMIT');
} catch (error) {
  try { db.exec('ROLLBACK'); } catch {}
  throw error;
}

console.log(`Anagrafiche TEST SDI create: ${created}`);
console.log(`Anagrafiche TEST SDI aggiornate: ${updated}`);
RECIPIENTS.forEach((recipient) => {
  console.log(`${recipient.codice_destinatario} - ${recipient.ragione_sociale}`);
});

function upsertRecipient(recipient) {
  const existing = db.prepare(`
    SELECT id
    FROM anagrafiche
    WHERE codice_destinatario = ?
       OR ragione_sociale = ?
       OR piva IN (?, ?)
    ORDER BY id
    LIMIT 1
  `).get(
    recipient.codice_destinatario,
    recipient.ragione_sociale,
    recipient.piva,
    recipient.piva.replace(/^IT/, '')
  );

  const values = [
    recipient.tipo,
    recipient.ragione_sociale,
    recipient.piva,
    recipient.cf,
    ADDRESS.indirizzo,
    ADDRESS.cap,
    ADDRESS.citta,
    ADDRESS.provincia,
    ADDRESS.paese,
    ADDRESS.email,
    ADDRESS.pec,
    recipient.codice_destinatario,
    recipient.tipo === 'pa' ? 'pa' : 'privato',
    recipient.tipo === 'pa' ? 'pa' : 'privato',
    recipient.tipo === 'pa' ? 1 : 0,
    recipient.tipo === 'pa' ? 1 : 0,
    recipient.tipo === 'pa' ? 1 : 0,
    recipient.note,
    1
  ];

  let id;
  if (existing) {
    id = existing.id;
    db.prepare(`
      UPDATE anagrafiche
      SET tipo=?,
          ragione_sociale=?,
          piva=?,
          cf=?,
          indirizzo=?,
          cap=?,
          citta=?,
          provincia=?,
          paese=?,
          email=?,
          pec=?,
          codice_destinatario=?,
          canale_cliente=?,
          tipologia_cliente=?,
          pa_mepa=?,
          pa_sda=?,
          pa_rdo=?,
          note=?,
          attivo=?
      WHERE id=?
    `).run(...values, id);
  } else {
    const insert = db.prepare(`
      INSERT INTO anagrafiche (
        tipo, ragione_sociale, piva, cf, indirizzo, cap, citta, provincia, paese,
        email, pec, codice_destinatario, canale_cliente, tipologia_cliente, pa_mepa, pa_sda, pa_rdo, note, attivo
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(...values);
    id = insert.lastInsertRowid;
  }

  if (recipient.tipo === 'pa') {
    db.prepare(`
      INSERT INTO pa_dettagli (anagrafica_id, codice_ipa, codice_univoco_sdi, categoria_pa, cpv_abituali)
      VALUES (?,?,?,?,?)
      ON CONFLICT(anagrafica_id) DO UPDATE SET
        codice_ipa=excluded.codice_ipa,
        codice_univoco_sdi=excluded.codice_univoco_sdi,
        categoria_pa=excluded.categoria_pa,
        cpv_abituali=excluded.cpv_abituali
    `).run(id, recipient.codice_ipa, recipient.codice_destinatario, 'TEST SDI', 'TEST');
  }

  return { id, created: !existing };
}

function ensureColumns() {
  [
    "ALTER TABLE anagrafiche ADD COLUMN canale_cliente TEXT DEFAULT 'privato'",
    "ALTER TABLE anagrafiche ADD COLUMN tipologia_cliente TEXT DEFAULT 'privato'",
    "ALTER TABLE anagrafiche ADD COLUMN pa_mepa INTEGER DEFAULT 0",
    "ALTER TABLE anagrafiche ADD COLUMN pa_sda INTEGER DEFAULT 0",
    "ALTER TABLE anagrafiche ADD COLUMN pa_rdo INTEGER DEFAULT 0",
    "ALTER TABLE anagrafiche ADD COLUMN codice_destinatario TEXT"
  ].forEach((sql) => {
    try { db.exec(sql); } catch {}
  });
}
