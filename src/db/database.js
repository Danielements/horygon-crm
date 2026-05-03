const { DatabaseSync } = require('node:sqlite');
require('dotenv').config();

const db = new DatabaseSync(process.env.DB_PATH || './horygon.db');

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`

  -- RUOLI
  CREATE TABLE IF NOT EXISTS ruoli (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    descrizione TEXT
  );

  -- PERMESSI PER RUOLO E SEZIONE
  CREATE TABLE IF NOT EXISTS permessi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ruolo_id INTEGER NOT NULL,
    sezione TEXT NOT NULL,
    can_read INTEGER DEFAULT 1,
    can_edit INTEGER DEFAULT 0,
    can_delete INTEGER DEFAULT 0,
    can_admin INTEGER DEFAULT 0,
    UNIQUE(ruolo_id, sezione),
    FOREIGN KEY (ruolo_id) REFERENCES ruoli(id)
  );

  -- UTENTI
  CREATE TABLE IF NOT EXISTS utenti (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    ruolo_id INTEGER DEFAULT 1,
    tema TEXT DEFAULT 'dark',
    attivo INTEGER DEFAULT 1,
    force_password_change INTEGER DEFAULT 0,
    password_changed_il TEXT,
    credentials_sent_at TEXT,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (ruolo_id) REFERENCES ruoli(id)
  );

  -- ANAGRAFICHE
  CREATE TABLE IF NOT EXISTS anagrafiche (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL CHECK(tipo IN ('fornitore','cliente','pa','fornitore_cliente')),
    ragione_sociale TEXT NOT NULL,
    piva TEXT, cf TEXT,
    indirizzo TEXT, cap TEXT, citta TEXT, provincia TEXT, paese TEXT DEFAULT 'IT',
    lat REAL, lng REAL,
    email TEXT, pec TEXT, telefono TEXT, sito_web TEXT, note TEXT,
    google_contact_id TEXT,
    attivo INTEGER DEFAULT 1,
    creato_il TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS anagrafiche_contatti (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anagrafica_id INTEGER,
    nome TEXT NOT NULL, ruolo TEXT, telefono TEXT, email TEXT, note TEXT,
    FOREIGN KEY (anagrafica_id) REFERENCES anagrafiche(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pa_dettagli (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anagrafica_id INTEGER NOT NULL UNIQUE,
    codice_ipa TEXT, codice_univoco_sdi TEXT, categoria_pa TEXT, cpv_abituali TEXT,
    FOREIGN KEY (anagrafica_id) REFERENCES anagrafiche(id) ON DELETE CASCADE
  );

  -- CATEGORIE
  CREATE TABLE IF NOT EXISTS categorie (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE, descrizione TEXT
  );

  -- PRODOTTI
  CREATE TABLE IF NOT EXISTS prodotti (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codice_interno TEXT NOT NULL UNIQUE, barcode TEXT,
    nome TEXT NOT NULL, descrizione TEXT,
    categoria_id INTEGER, unita_misura TEXT DEFAULT 'pz',
    peso_kg REAL, attivo INTEGER DEFAULT 1,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (categoria_id) REFERENCES categorie(id)
  );

  CREATE TABLE IF NOT EXISTS prodotti_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prodotto_id INTEGER NOT NULL,
    tipo TEXT CHECK(tipo IN ('immagine','pdf','certificazione','scheda_tecnica')),
    nome_file TEXT NOT NULL, path TEXT,
    google_drive_id TEXT, drive_url TEXT,
    caricato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (prodotto_id) REFERENCES prodotti(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS prodotti_listini (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prodotto_id INTEGER NOT NULL,
    canale TEXT CHECK(canale IN ('mepa','diretto','entrambi')) DEFAULT 'mepa',
    prezzo REAL NOT NULL, cpv TEXT, valido_dal TEXT, valido_al TEXT,
    FOREIGN KEY (prodotto_id) REFERENCES prodotti(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS prodotti_fornitori (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prodotto_id INTEGER NOT NULL, fornitore_id INTEGER NOT NULL,
    fattura_id INTEGER,
    codice_fornitore TEXT, prezzo_acquisto REAL,
    valuta TEXT DEFAULT 'CNY', lead_time_giorni INTEGER, note TEXT,
    aggiornato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (prodotto_id) REFERENCES prodotti(id),
    FOREIGN KEY (fornitore_id) REFERENCES anagrafiche(id)
  );

  CREATE TABLE IF NOT EXISTS prezzi_storico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prodotto_fornitore_id INTEGER NOT NULL,
    prezzo REAL NOT NULL, valuta TEXT DEFAULT 'CNY',
    data TEXT DEFAULT (date('now')),
    FOREIGN KEY (prodotto_fornitore_id) REFERENCES prodotti_fornitori(id)
  );

  -- FATTURE
  CREATE TABLE IF NOT EXISTS fatture (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK(tipo IN ('emessa','ricevuta')),
    anagrafica_id INTEGER,
    ordine_id INTEGER,
    data TEXT, scadenza TEXT,
    imponibile REAL, iva REAL, totale REAL,
    sdi_id TEXT,
    xml_path TEXT, pdf_path TEXT,
    stato TEXT DEFAULT 'ricevuta' CHECK(stato IN ('ricevuta','pagata','scaduta','annullata')),
    note TEXT,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (anagrafica_id) REFERENCES anagrafiche(id)
  );

  CREATE TABLE IF NOT EXISTS fatture_righe (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fattura_id INTEGER NOT NULL,
    prodotto_id INTEGER,
    descrizione TEXT, quantita REAL, prezzo_unitario REAL, totale_riga REAL,
    FOREIGN KEY (fattura_id) REFERENCES fatture(id) ON DELETE CASCADE,
    FOREIGN KEY (prodotto_id) REFERENCES prodotti(id)
  );

  -- CONTAINER
  CREATE TABLE IF NOT EXISTS container (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fornitore_id INTEGER, numero_bl TEXT,
    porto_partenza TEXT DEFAULT 'Guangzhou', porto_arrivo TEXT DEFAULT 'Genova',
    data_partenza TEXT, data_arrivo_prevista TEXT, data_arrivo_effettiva TEXT,
    stato TEXT DEFAULT 'in_preparazione',
    costo_trasporto REAL, costo_dogana REAL, costo_altri REAL, note TEXT,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (fornitore_id) REFERENCES anagrafiche(id)
  );

  CREATE TABLE IF NOT EXISTS container_righe (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id INTEGER NOT NULL, prodotto_id INTEGER NOT NULL,
    quantita INTEGER NOT NULL, costo_unitario REAL, valuta TEXT DEFAULT 'CNY',
    FOREIGN KEY (container_id) REFERENCES container(id) ON DELETE CASCADE,
    FOREIGN KEY (prodotto_id) REFERENCES prodotti(id)
  );

  -- ORDINI
  CREATE TABLE IF NOT EXISTS ordini (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codice_ordine TEXT NOT NULL UNIQUE,
    tipo TEXT NOT NULL CHECK(tipo IN ('acquisto','vendita')),
    anagrafica_id INTEGER,
    canale TEXT CHECK(canale IN ('mepa','diretto')),
    stato TEXT DEFAULT 'ricevuto',
    data_ordine TEXT, data_consegna_prevista TEXT, data_consegna_effettiva TEXT,
    totale REAL, note TEXT,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (anagrafica_id) REFERENCES anagrafiche(id)
  );

  CREATE TABLE IF NOT EXISTS ordini_righe (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ordine_id INTEGER NOT NULL, prodotto_id INTEGER NOT NULL,
    quantita INTEGER NOT NULL, prezzo_unitario REAL, sconto REAL DEFAULT 0,
    FOREIGN KEY (ordine_id) REFERENCES ordini(id) ON DELETE CASCADE,
    FOREIGN KEY (prodotto_id) REFERENCES prodotti(id)
  );

  -- PREVENTIVI
  CREATE TABLE IF NOT EXISTS preventivi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codice_preventivo TEXT NOT NULL UNIQUE,
    anagrafica_id INTEGER,
    stato TEXT DEFAULT 'bozza' CHECK(stato IN ('bozza','inviato','accettato','rifiutato','scaduto')),
    data_preventivo TEXT,
    data_scadenza TEXT,
    totale REAL,
    note TEXT,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (anagrafica_id) REFERENCES anagrafiche(id)
  );

  CREATE TABLE IF NOT EXISTS preventivi_righe (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    preventivo_id INTEGER NOT NULL,
    prodotto_id INTEGER,
    descrizione TEXT,
    quantita REAL,
    prezzo_unitario REAL,
    totale_riga REAL,
    FOREIGN KEY (preventivo_id) REFERENCES preventivi(id) ON DELETE CASCADE,
    FOREIGN KEY (prodotto_id) REFERENCES prodotti(id)
  );

  -- DDT
  CREATE TABLE IF NOT EXISTS ddt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero_ddt TEXT NOT NULL UNIQUE, tipo TEXT CHECK(tipo IN ('entrata','uscita')),
    ordine_id INTEGER, data TEXT,
    mittente_id INTEGER, destinatario_id INTEGER,
    indirizzo_consegna TEXT, lat_consegna REAL, lng_consegna REAL,
    vettore TEXT, firmato INTEGER DEFAULT 0, note TEXT,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (ordine_id) REFERENCES ordini(id),
    FOREIGN KEY (mittente_id) REFERENCES anagrafiche(id),
    FOREIGN KEY (destinatario_id) REFERENCES anagrafiche(id)
  );

  CREATE TABLE IF NOT EXISTS ddt_righe (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ddt_id INTEGER NOT NULL, prodotto_id INTEGER NOT NULL,
    quantita INTEGER NOT NULL, lotto TEXT,
    FOREIGN KEY (ddt_id) REFERENCES ddt(id) ON DELETE CASCADE,
    FOREIGN KEY (prodotto_id) REFERENCES prodotti(id)
  );

  -- MAGAZZINO
  CREATE TABLE IF NOT EXISTS magazzino_movimenti (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prodotto_id INTEGER NOT NULL,
    tipo TEXT NOT NULL CHECK(tipo IN ('carico','scarico','rettifica','reso')),
    quantita INTEGER NOT NULL, riferimento_tipo TEXT, riferimento_id INTEGER,
    data TEXT DEFAULT (date('now')), note TEXT,
    FOREIGN KEY (prodotto_id) REFERENCES prodotti(id)
  );

  -- ATTIVITA CRM
  CREATE TABLE IF NOT EXISTS attivita (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL CHECK(tipo IN ('telefonata','appuntamento','email','visita','nota')),
    anagrafica_id INTEGER, ordine_id INTEGER, utente_id INTEGER,
    data_ora TEXT, durata_minuti INTEGER,
    oggetto TEXT, note TEXT, esito TEXT, promemoria_il TEXT,
    google_event_id TEXT, google_meet_link TEXT,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (anagrafica_id) REFERENCES anagrafiche(id),
    FOREIGN KEY (ordine_id) REFERENCES ordini(id),
    FOREIGN KEY (utente_id) REFERENCES utenti(id)
  );

  -- GOOGLE TOKENS
  CREATE TABLE IF NOT EXISTS google_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utente_id INTEGER NOT NULL UNIQUE,
    access_token TEXT, refresh_token TEXT, scadenza TEXT, scope TEXT,
    FOREIGN KEY (utente_id) REFERENCES utenti(id)
  );

  -- SYNC LOG
  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    servizio TEXT, direzione TEXT, entita TEXT, entita_id INTEGER,
    google_id TEXT, stato TEXT, errore TEXT,
    data TEXT DEFAULT (datetime('now'))
  );

  -- DATI INIZIALI
  INSERT OR IGNORE INTO categorie (nome) VALUES
    ('Pulizia'),('Cancelleria'),('Elettrico'),('Ufficio'),('Altro');

`);

try { db.exec(`ALTER TABLE utenti ADD COLUMN force_password_change INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE utenti ADD COLUMN password_changed_il TEXT`); } catch {}
try { db.exec(`ALTER TABLE utenti ADD COLUMN credentials_sent_at TEXT`); } catch {}

function ensureColumn(table, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch {}
}

[
  "tipo_documento TEXT DEFAULT 'fattura'",
  "direzione TEXT DEFAULT 'attiva'",
  "data_ricezione TEXT",
  "partita_iva TEXT",
  "codice_fiscale TEXT",
  "valuta TEXT DEFAULT 'EUR'",
  "stato_pagamento TEXT DEFAULT 'da_pagare'",
  "stato_sdi TEXT",
  "origine_importazione TEXT DEFAULT 'manuale'",
  "import_error TEXT",
  "hash_file TEXT",
  "hash_documento TEXT",
  "numero_documento TEXT",
  "tipo_esteso TEXT",
  "cliente_fornitore_label TEXT",
  "proforma_id INTEGER",
  "spedizione_id INTEGER",
  "ordine_fornitore_id INTEGER",
  "ordine_cliente_id INTEGER",
  "suggerimenti_collegamento TEXT",
  "alert_generato INTEGER DEFAULT 0",
  "documento_meta TEXT"
].forEach(col => ensureColumn('fatture', col));

[
  "sconto REAL DEFAULT 0",
  "imponibile REAL",
  "aliquota_iva REAL",
  "natura_iva TEXT",
  "importo_iva REAL"
].forEach(col => ensureColumn('fatture_righe', col));

[
  "imponibile REAL DEFAULT 0",
  "iva REAL DEFAULT 0",
  "valuta TEXT DEFAULT 'EUR'"
].forEach(col => ensureColumn('preventivi', col));

[
  "sconto REAL DEFAULT 0",
  "aliquota_iva REAL DEFAULT 22",
  "natura_iva TEXT",
  "imponibile REAL",
  "importo_iva REAL"
].forEach(col => ensureColumn('preventivi_righe', col));

[
  "preventivo_id INTEGER",
  "imponibile REAL DEFAULT 0",
  "iva REAL DEFAULT 0"
].forEach(col => ensureColumn('ordini', col));

[
  "cpv_mepa TEXT"
].forEach(col => ensureColumn('prodotti', col));

db.exec(`
  CREATE TABLE IF NOT EXISTS fatture_iva_riepilogo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fattura_id INTEGER NOT NULL,
    aliquota_iva REAL,
    natura_iva TEXT,
    imponibile REAL,
    imposta REAL,
    riferimento_normativo TEXT,
    FOREIGN KEY (fattura_id) REFERENCES fatture(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS proforme_invoice (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero_proforma TEXT NOT NULL UNIQUE,
    data TEXT,
    fornitore_id INTEGER,
    valuta TEXT DEFAULT 'USD',
    importo_merce REAL DEFAULT 0,
    importo_trasporto REAL DEFAULT 0,
    assicurazione REAL DEFAULT 0,
    altri_costi REAL DEFAULT 0,
    totale REAL DEFAULT 0,
    acconto_richiesto REAL DEFAULT 0,
    saldo_richiesto REAL DEFAULT 0,
    scadenza_acconto TEXT,
    scadenza_saldo TEXT,
    incoterm TEXT,
    porto_partenza TEXT,
    porto_arrivo TEXT,
    metodo_spedizione TEXT,
    stato TEXT DEFAULT 'ricevuta',
    pdf_path TEXT,
    excel_path TEXT,
    packing_list_path TEXT,
    ordine_cliente_id INTEGER,
    ordine_fornitore_id INTEGER,
    spedizione_id INTEGER,
    note TEXT,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (fornitore_id) REFERENCES anagrafiche(id)
  );

  CREATE TABLE IF NOT EXISTS proforme_righe (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proforma_id INTEGER NOT NULL,
    prodotto_id INTEGER,
    descrizione TEXT,
    quantita REAL,
    prezzo_unitario REAL,
    totale_riga REAL,
    FOREIGN KEY (proforma_id) REFERENCES proforme_invoice(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS proforme_alert (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proforma_id INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    messaggio TEXT NOT NULL,
    risolto INTEGER DEFAULT 0,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (proforma_id) REFERENCES proforme_invoice(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS spedizioni (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codice_spedizione TEXT NOT NULL UNIQUE,
    fornitore_id INTEGER,
    cliente_id INTEGER,
    ordine_cliente_id INTEGER,
    ordine_fornitore_id INTEGER,
    proforma_id INTEGER,
    fattura_id INTEGER,
    metodo_spedizione TEXT,
    incoterm TEXT,
    forwarder TEXT,
    referente_forwarder TEXT,
    partenza TEXT,
    arrivo TEXT,
    etd TEXT,
    eta TEXT,
    data_ritiro_merce TEXT,
    data_partenza_effettiva TEXT,
    data_arrivo_effettiva TEXT,
    tracking_number TEXT,
    container_number TEXT,
    seal_number TEXT,
    numero_bl_awb TEXT,
    numero_colli INTEGER,
    peso_lordo REAL,
    peso_netto REAL,
    volume_cbm REAL,
    valore_merce REAL DEFAULT 0,
    valuta TEXT DEFAULT 'USD',
    assicurazione REAL DEFAULT 0,
    stato_spedizione TEXT DEFAULT 'in_preparazione',
    landed_cost REAL DEFAULT 0,
    margine_previsto REAL DEFAULT 0,
    margine_reale REAL DEFAULT 0,
    note TEXT,
    creato_il TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS spedizioni_documenti (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spedizione_id INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    nome_file TEXT,
    path TEXT,
    note TEXT,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (spedizione_id) REFERENCES spedizioni(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS spedizioni_costi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spedizione_id INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    importo REAL DEFAULT 0,
    valuta TEXT DEFAULT 'EUR',
    note TEXT,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (spedizione_id) REFERENCES spedizioni(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS email_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chiave TEXT NOT NULL UNIQUE,
    nome TEXT NOT NULL,
    oggetto TEXT,
    corpo TEXT,
    attivo INTEGER DEFAULT 1,
    creato_il TEXT DEFAULT (datetime('now')),
    aggiornato_il TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ai_usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utente_id INTEGER,
    provider TEXT NOT NULL,
    modello TEXT,
    operazione TEXT,
    token_input INTEGER DEFAULT 0,
    token_output INTEGER DEFAULT 0,
    token_totali INTEGER DEFAULT 0,
    costo_stimato REAL DEFAULT 0,
    stato TEXT,
    errore TEXT,
    durata_ms INTEGER,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (utente_id) REFERENCES utenti(id)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utente_id INTEGER,
    azione TEXT NOT NULL,
    entita_tipo TEXT,
    entita_id INTEGER,
    dettagli TEXT,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (utente_id) REFERENCES utenti(id)
  );

  CREATE TABLE IF NOT EXISTS system_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    livello TEXT DEFAULT 'error',
    origine TEXT,
    route TEXT,
    metodo TEXT,
    status_code INTEGER,
    utente_id INTEGER,
    messaggio TEXT NOT NULL,
    stack TEXT,
    dettagli TEXT,
    creato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (utente_id) REFERENCES utenti(id)
  );

  CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utente_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    subscription_json TEXT NOT NULL,
    user_agent TEXT,
    enabled INTEGER DEFAULT 1,
    last_success_at TEXT,
    last_error_at TEXT,
    last_error TEXT,
    creato_il TEXT DEFAULT (datetime('now')),
    aggiornato_il TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (utente_id) REFERENCES utenti(id) ON DELETE CASCADE
  );
`);

const ROLE_DEFS = [
  { id: 1, nome: 'readonly', descrizione: 'Solo lettura' },
  { id: 2, nome: 'commerciale', descrizione: 'Vendite, clienti, preventivi, ordini e attivita' },
  { id: 3, nome: 'admin', descrizione: 'Gestione piattaforma e utenti' },
  { id: 4, nome: 'superadmin', descrizione: 'Accesso completo e governo totale' },
  { id: 5, nome: 'amministrazione', descrizione: 'Contabilita, documenti e controllo scadenze' },
  { id: 6, nome: 'logistica', descrizione: 'Magazzino, spedizioni, ddt e tracciamento operativo' },
  { id: 7, nome: 'commercialista_esterno', descrizione: 'Consultazione contabile e documentale' },
];

const APP_SECTIONS = [
  'clienti', 'fornitori', 'contatti', 'prodotti', 'magazzino', 'preventivi',
  'ordini', 'ddt', 'container', 'fatture', 'proforme', 'spedizioni',
  'attivita', 'documenti', 'mepa', 'cig', 'analytics', 'statistics',
  'settings', 'mappa', 'utenti', 'ai', 'system_log'
];

const upsertRole = db.prepare(`
  INSERT INTO ruoli (id, nome, descrizione)
  VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET nome = excluded.nome, descrizione = excluded.descrizione
`);

ROLE_DEFS.forEach(role => upsertRole.run(role.id, role.nome, role.descrizione));
try { db.prepare(`DELETE FROM ruoli WHERE nome = 'candelete' AND id NOT IN (1,2,3,4)`).run(); } catch {}

const upsertPerm = db.prepare(`
  INSERT INTO permessi (ruolo_id, sezione, can_read, can_edit, can_delete, can_admin)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(ruolo_id, sezione) DO UPDATE SET
    can_read = excluded.can_read,
    can_edit = excluded.can_edit,
    can_delete = excluded.can_delete,
    can_admin = excluded.can_admin
`);

APP_SECTIONS.forEach(section => {
  const readonlyRead = section === 'utenti' || section === 'settings' ? 0 : 1;
  upsertPerm.run(1, section, readonlyRead, 0, 0, 0);

  const commercialeEditable = ['clienti', 'fornitori', 'contatti', 'preventivi', 'ordini', 'attivita', 'documenti', 'mappa'].includes(section);
  const commercialeReadable = readonlyRead;
  upsertPerm.run(2, section, commercialeReadable, commercialeEditable ? 1 : 0, 0, 0);

  upsertPerm.run(3, section, 1, 1, section === 'settings' ? 0 : 1, section === 'utenti' || section === 'settings' ? 1 : 0);
  upsertPerm.run(4, section, 1, 1, 1, 1);

  const amministrazioneReadable = ['clienti', 'fornitori', 'contatti', 'fatture', 'ordini', 'preventivi', 'documenti', 'analytics', 'statistics', 'mappa'].includes(section);
  const amministrazioneEditable = ['fatture', 'documenti', 'analytics', 'statistics'].includes(section);
  upsertPerm.run(5, section, amministrazioneReadable ? 1 : 0, amministrazioneEditable ? 1 : 0, 0, 0);

  const logisticaReadable = ['clienti', 'fornitori', 'contatti', 'prodotti', 'magazzino', 'ordini', 'ddt', 'container', 'proforme', 'spedizioni', 'documenti', 'mappa', 'analytics'].includes(section);
  const logisticaEditable = ['magazzino', 'ordini', 'ddt', 'container', 'proforme', 'spedizioni', 'documenti'].includes(section);
  upsertPerm.run(6, section, logisticaReadable ? 1 : 0, logisticaEditable ? 1 : 0, 0, 0);

  const commercialistaReadable = ['fatture', 'documenti', 'analytics', 'statistics'].includes(section);
  upsertPerm.run(7, section, commercialistaReadable ? 1 : 0, 0, 0, 0);
});

module.exports = db;
