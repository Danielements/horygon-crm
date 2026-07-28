# Horygon CRM - Documento di contesto per Claude

Questo file serve come onboarding tecnico e funzionale del progetto. L'obiettivo e' permettere a Claude di capire rapidamente:

- cosa fa il CRM;
- come e' organizzato il codice;
- quali moduli sono presenti;
- come e' progettato il database SQLite;
- quali relazioni sono realmente vincolate con `FOREIGN KEY`;
- quali collegamenti sono solo logici/applicativi;
- quali integrazioni esterne esistono.

Le fonti principali di verita' sono:

- `src/index.js`
- `src/db/database.js`
- `src/routes/*.js`
- `src/services/*.js`
- `public/index.html`
- `public/js/app.js`

## 1. Visione generale

Horygon CRM e' un gestionale web full-stack per:

- CRM clienti/fornitori/PA;
- catalogo prodotti e kit;
- preventivi, ordini, DDT, fatture;
- logistica import/export, container, proforme, spedizioni;
- attivita' commerciali e operative;
- integrazione Google Calendar, Drive, Gmail e Contatti;
- analisi MEPA, RdO, CIG e analytics incrociate;
- modulo ricambi con intake conversazionale via WhatsApp/Telegram;
- AI settings, AI usage logging, audit log, system log;
- PWA con notifiche push.

L'applicazione e' pensata come SPA frontend servita direttamente dal backend Express, con database SQLite locale.

## 2. Stack tecnico

### Backend

- Node.js
- Express 5
- SQLite via `node:sqlite`
- JWT per autenticazione API
- `express-session` per sessioni web/OAuth
- `multer` per upload file
- `pdfkit` per generazione documenti PDF
- `googleapis` per Calendar, Drive, Gmail, Contacts
- `web-push` per notifiche push PWA
- `xlsx` e `csv-parse` per import strutturati

### Frontend

- HTML/CSS/JS vanilla
- SPA servita da `public/`
- token JWT salvato in `localStorage`
- PWA con `manifest.webmanifest` e `service-worker.js`

### Storage

- Database principale: `horygon.db`
- Upload locali: cartella `uploads/`
- Asset statici: cartella `public/`

## 3. Architettura applicativa

### Entry point

Il server parte da `src/index.js`.

Responsabilita' principali:

- caricamento variabili ambiente;
- inizializzazione Express;
- CORS con allowlist;
- header di sicurezza;
- rate limiting;
- parser JSON;
- serving file statici;
- mounting delle route API;
- gestione errori centralizzata;
- logging di `unhandledRejection` e `uncaughtException`.

### Configurazione ambiente

`src/config/load-env.js` carica:

1. `.env`
2. `.env.<NODE_ENV>`
3. `.env.local` se non in produzione

### Database

`src/db/database.js`:

- apre SQLite;
- abilita `PRAGMA journal_mode = WAL`;
- abilita `PRAGMA foreign_keys = ON`;
- crea tabelle;
- applica migrazioni additive tramite `ALTER TABLE ... ADD COLUMN`;
- semina ruoli e permessi di default.

### Organizzazione codice

- `src/routes/`: API HTTP per dominio funzionale
- `src/services/`: logica riusabile, parsing, integrazioni, PDF, log
- `src/middleware/`: auth e permessi
- `public/`: SPA frontend
- `scripts/`: utility di diagnostica e reimport

## 4. Sicurezza, auth e permessi

### Autenticazione

Sistema ibrido:

- login classico con email/password;
- OAuth Google;
- JWT usato sulle API tramite header `Authorization: Bearer ...`;
- sessione Express usata per supporto flussi web/OAuth.

### Permessi

Modello RBAC con:

- `ruoli`
- `permessi`
- `utenti.ruolo_id`

Controllo applicato con `requirePermesso(sezione, azione)` in `src/middleware/auth.js`.

Azioni supportate:

- `read`
- `edit`
- `delete`
- `admin`

Ruoli seedati:

- `readonly`
- `commerciale`
- `admin`
- `superadmin`
- `amministrazione`
- `logistica`
- `commercialista_esterno`

Sezioni applicative governate a permessi:

- `clienti`
- `fornitori`
- `contatti`
- `prodotti`
- `magazzino`
- `preventivi`
- `ordini`
- `ddt`
- `container`
- `fatture`
- `proforme`
- `spedizioni`
- `attivita`
- `documenti`
- `mepa`
- `cig`
- `analytics`
- `statistics`
- `ricambi`
- `settings`
- `mappa`
- `utenti`
- `ai`
- `system_log`

## 5. Frontend e UX

La SPA definita in `public/index.html` e `public/js/app.js` espone le aree:

- Dashboard
- Attivita' CRM
- Notifiche
- Automazioni
- Ricambi
- Clienti
- Fornitori
- Contatti
- Prodotti
- Kit
- Magazzino
- Preventivi
- Ordini
- DDT
- Container CN
- Fatture attive
- Fatture passive
- Fuori campo IVA
- Stagionalita' CIG
- Abilitazioni CPV MEPA
- RdO
- Analisi incrociata
- Documenti
- Statistics
- Mappa PA
- Utenti

Capacita' frontend importanti:

- login e primo setup;
- dashboard KPI;
- calendario Google integrato;
- quick actions mobile;
- notifiche app;
- supporto PWA;
- supporto push subscription;
- vista chat e richieste per modulo ricambi;
- schede e tabelle CRUD per tutti i moduli principali.

## 6. Moduli funzionali del CRM

### 6.1 Anagrafiche

Gestisce:

- clienti;
- fornitori;
- pubbliche amministrazioni;
- anagrafiche miste `fornitore_cliente`.

Funzioni:

- CRUD anagrafiche;
- geolocalizzazione lat/lng;
- mappa CRM;
- mappa PA;
- dati amministrativi e di contatto;
- campi specifici canale/tipologia cliente;
- flag PA per MEPA, SDA, RdO;
- dettaglio PA tramite tabella dedicata.

Route principali:

- `GET /api/anagrafiche`
- `GET /api/anagrafiche/:id`
- `POST /api/anagrafiche`
- `PUT /api/anagrafiche/:id`
- `DELETE /api/anagrafiche/:id`
- `GET /api/anagrafiche/pa/mappa`
- `GET /api/anagrafiche/mappa/crm`

### 6.2 Contatti

Gestisce contatti collegati alle anagrafiche.

Funzioni:

- CRUD contatti;
- avatar upload;
- sync con Google Contacts;
- collegamento opzionale a utente interno;
- visibilita' esterna.

Route:

- `GET /api/contatti`
- `GET /api/contatti/meta`
- `GET /api/contatti/:id`
- `POST /api/contatti`
- `PUT /api/contatti/:id`
- `DELETE /api/contatti/:id`
- `POST /api/contatti/:id/avatar`
- `POST /api/contatti/:id/sync-google`

### 6.3 Prodotti

Gestisce il catalogo articoli.

Funzioni:

- categorie prodotto;
- CRUD prodotti;
- barcode/codice interno;
- CPV MEPA e tag;
- media allegati;
- listini per canale;
- associazione fornitori;
- QR code prodotto;
- giacenza aggregata da movimenti magazzino;
- scheda pubblica prodotto.

Route:

- `GET /api/prodotti/categorie`
- `POST /api/prodotti/categorie`
- `PUT /api/prodotti/categorie/:id`
- `DELETE /api/prodotti/categorie/:id`
- `GET /api/prodotti`
- `GET /api/prodotti/:id`
- `POST /api/prodotti`
- `PUT /api/prodotti/:id`
- `DELETE /api/prodotti/:id`
- `POST /api/prodotti/:id/media`
- `DELETE /api/prodotti/:id/media/:mediaId`
- `POST /api/prodotti/:id/listino`
- `POST /api/prodotti/:id/fornitore`
- `GET /api/prodotti/magazzino/giacenze`
- `GET /api/prodotti/:id/qr`

### 6.4 Kit

Gestisce kit composti da piu' prodotti.

Funzioni:

- CRUD kit;
- lista componenti;
- quantita' per componente;
- prezzo vendita kit;
- categoria kit.

Route:

- `GET /api/kits`
- `GET /api/kits/:id`
- `POST /api/kits`
- `PUT /api/kits/:id`
- `DELETE /api/kits/:id`

### 6.5 Preventivi

Gestisce il ciclo preventivazione.

Funzioni:

- testata preventivo;
- righe preventivo;
- imponibile/IVA/totale;
- PDF preventivo;
- token pubblico per accesso PDF esterno;
- conversione preventivo -> ordine;
- stati bozza/inviato/accettato/rifiutato/scaduto.

Route:

- `GET /api/preventivi`
- `GET /api/preventivi/:id`
- `GET /api/preventivi/:id/pdf`
- `POST /api/preventivi`
- `PUT /api/preventivi/:id`
- `PATCH /api/preventivi/:id/stato`
- `DELETE /api/preventivi/:id`
- `POST /api/preventivi/:id/convert-to-order`

Pubblico:

- `GET /api/public/preventivi/:token/pdf`

### 6.6 Ordini

Gestisce ordini vendita e acquisto.

Funzioni:

- testata ordine;
- righe ordine;
- link logico al preventivo di origine;
- tracking spedizione;
- allegati ordine;
- PDF ordine;
- aggiornamento stato;
- gestione corriere e tracking.

Route:

- `GET /api/ordini`
- `GET /api/ordini/:id`
- `GET /api/ordini/:id/pdf`
- `POST /api/ordini`
- `PUT /api/ordini/:id`
- `PATCH /api/ordini/:id/stato`
- `PATCH /api/ordini/:id/tracking`
- `POST /api/ordini/:id/allegati`
- `DELETE /api/ordini/:id/allegati/:allegId`
- `DELETE /api/ordini/:id`
- `GET /api/ordini/:id/tracking`

### 6.7 DDT, magazzino e operativo

Modulo operativo gestito in `src/routes/operativo.js`.

Funzioni DDT:

- CRUD DDT;
- conversione ordine -> DDT;
- PDF DDT;
- collegamento logico a fattura;
- dati spedizione, colli, porto, resa, causale.

Funzioni magazzino:

- registrazione movimenti;
- giacenza derivata da somma movimenti;
- tipologie: carico, scarico, rettifica, reso.

Funzioni attivita':

- appuntamenti;
- email;
- telefonate;
- visite;
- note;
- assegnazione;
- stato;
- sync Google Calendar/Meet.

Route principali:

- `GET /api/ddt`
- `GET /api/ddt/:id`
- `POST /api/ddt`
- `PUT /api/ddt/:id`
- `DELETE /api/ddt/:id`
- `POST /api/ordini/:id/convert-to-ddt`
- `GET /api/ddt/:id/pdf`
- `POST /api/magazzino`
- `GET /api/attivita`
- `GET /api/attivita/meta`
- `POST /api/attivita`
- `PUT /api/attivita/:id`
- `POST /api/attivita/:id/google-sync`
- `DELETE /api/attivita/:id`

Extra:

- `GET /api/etichetta/:prodotto_id/qr`
- `GET /api/etichetta/:prodotto_id/pdf`

### 6.8 Fatture

Gestisce fatture attive/passive e import documentale.

Funzioni:

- CRUD fatture;
- righe fattura;
- riepilogo IVA;
- import XML;
- import spreadsheet;
- upload PDF fattura;
- stato pagamento;
- metadati SDI;
- campi di collegamento logico con ordini, proforme e spedizioni.

Route:

- `GET /api/fatture`
- `GET /api/fatture/:id`
- `POST /api/fatture`
- `PUT /api/fatture/:id`
- `POST /api/fatture/:id/pdf`
- `POST /api/fatture/import/xml`
- `POST /api/fatture/import/spreadsheet`
- `PATCH /api/fatture/:id/stato`

### 6.9 Proforme

Gestisce proforma invoice lato import/export.

Funzioni:

- CRUD proforma;
- righe proforma;
- alert proforma;
- dati economici e scadenze;
- collegamenti logici a ordini cliente, ordini fornitore e spedizione.

Route:

- `GET /api/proforme`
- `GET /api/proforme/:id`
- `POST /api/proforme`
- `PUT /api/proforme/:id`
- `PATCH /api/proforme/:id/stato`

### 6.10 Spedizioni

Gestisce flusso logistico avanzato.

Funzioni:

- CRUD spedizioni;
- stato spedizione;
- documenti spedizione;
- costi spedizione;
- tracking, BL/AWB, container number, seal number;
- landed cost e margini;
- collegamenti logici a fornitore, cliente, ordini, proforma, fattura.

Route:

- `GET /api/spedizioni`
- `GET /api/spedizioni/:id`
- `POST /api/spedizioni`
- `PUT /api/spedizioni/:id`
- `PATCH /api/spedizioni/:id/stato`

### 6.11 Container

Gestisce import container.

Funzioni:

- CRUD container;
- stato avanzamento;
- prodotto per container;
- costi trasporto/dogana/altri;
- tracking temporale partenza/ETA/arrivo effettivo.

Route:

- `GET /api/container`
- `GET /api/container/:id`
- `POST /api/container`
- `PATCH /api/container/:id/stato`

### 6.12 Documenti

Modulo focalizzato su invio documenti.

Funzioni:

- lookup destinatari per documento;
- log invii;
- invio documenti.

Route:

- `GET /api/documenti/:kind/:id/recipients`
- `GET /api/documenti/:kind/:id/log`
- `POST /api/documenti/send`

### 6.13 Google workspace

Modulo in `src/routes/google.js` + `src/services/google.js`.

Funzioni:

- Google OAuth;
- Calendar eventi;
- Drive file list/upload/delete;
- sync Gmail MEPA;
- notifiche applicative;
- impostazioni app;
- push status e subscription;
- contatti Google e sync.

Route:

- `GET /api/google/calendar/events`
- `POST /api/google/calendar/events`
- `PUT /api/google/calendar/events/:eventId`
- `DELETE /api/google/calendar/events/:eventId`
- `GET /api/google/drive/files`
- `POST /api/google/drive/upload`
- `DELETE /api/google/drive/files/:fileId`
- `POST /api/google/gmail/mepa/sync`
- `GET /api/google/gmail/mepa/messages`
- `PATCH /api/google/gmail/mepa/messages/:id`
- `GET /api/google/notifications`
- `PATCH /api/google/notifications/:id`
- `GET /api/google/settings`
- `PUT /api/google/settings`
- `GET /api/google/push/status`
- `POST /api/google/push/subscription`
- `DELETE /api/google/push/subscription`
- `POST /api/google/push/test`
- `GET /api/google/contacts`
- `POST /api/google/contacts/sync`

### 6.14 AI

Modulo in `src/routes/ai.js` + `src/services/ai-settings.js`.

Funzioni:

- lettura/salvataggio impostazioni AI;
- cifratura secret API key in `app_settings`;
- test connessione provider;
- usage log;
- endpoint assist;
- stato configurazione provider.

Provider previsti nel modello:

- `openai`
- `claude`
- `runtime`

Route:

- `GET /api/ai/settings`
- `PUT /api/ai/settings`
- `GET /api/ai/usage-log`
- `POST /api/ai/test`
- `GET /api/ai/status`
- `POST /api/ai/assist`

### 6.15 Modulo ricambi/chat

E' il modulo piu' evoluto lato automazione conversazionale.

Canali:

- WhatsApp webhook;
- Telegram webhook.

Capacita':

- intake progressivo richiesta ricambio;
- raccolta targa, VIN, codice OE, testo ricambio;
- lookup tecnico;
- RTWS per cristalli;
- gestione varianti OE;
- salvataggio conversazione e messaggi;
- note operative interne;
- assegnazione richiesta a utente;
- creazione automatica prodotto;
- creazione automatica preventivo;
- generazione e invio PDF preventivo;
- AI vision su immagini ricevute;
- metriche giornaliere.

Route:

- `GET /api/webhook/whatsapp`
- `POST /api/webhook/whatsapp`
- `POST /api/webhook/telegram`
- `POST /api/parts/resolve`
- `GET /api/parts/dashboard`
- `GET /api/parts/requests`
- `GET /api/parts/requests/:id`
- `POST /api/parts/requests`
- `PATCH /api/parts/requests/:id/status`
- `POST /api/parts/requests/:id/notes`
- `POST /api/parts/requests/:id/create-quote`
- `GET /api/parts/conversations`
- `GET /api/parts/conversations/:id/messages`
- `GET /api/parts/messages/:id/media`
- `POST /api/parts/conversations/:id/messages`
- `GET /api/parts/stats`

### 6.16 MEPA, RdO, CIG, Analytics

Moduli intelligence/commerciali specializzati.

MEPA:

- stato import;
- analytics;
- opportunita' non attive;
- catalogo CPV;
- categorie abilitate;
- import/preview/upload;
- lookup CPV operativo.

RdO:

- upload file;
- matching righe RdO.

CIG:

- stato scanner;
- analytics;
- upload/scansione file CIG;
- stagionalita' per CPV.

Analytics:

- analisi incrociata;
- storico CPV;
- API locali/remoti per MEPA.

## 7. Progettazione del database

### Principi

Il DB e' progettato come un unico SQLite applicativo, con:

- tabelle core CRM;
- tabelle documentali;
- tabelle logistica;
- tabelle integrazioni;
- tabelle analytics;
- tabelle conversazionali ricambi.

La strategia di evoluzione schema e' incrementale:

- `CREATE TABLE IF NOT EXISTS`
- `ALTER TABLE ... ADD COLUMN` racchiusi in `try/catch`

Questo significa che:

- non esiste un sistema di migration versionate formale;
- la compatibilita' viene mantenuta in bootstrap;
- alcune relazioni sono state aggiunte solo a livello applicativo, non come FK SQL.

### Convenzioni rilevanti

- date spesso in testo ISO
- booleani come `INTEGER` 0/1
- metadati complessi in JSON serializzato testo
- molte entita' hanno `creato_il`, `created_at` o `updated_at`
- documenti e media salvano `path` locale e talvolta ID/URL Drive

## 8. Tabelle principali per dominio

### Sicurezza e configurazione

- `ruoli`: ruoli utente
- `permessi`: permessi per ruolo e sezione
- `utenti`: utenti applicativi
- `app_settings`: configurazioni runtime, Google, notifiche, AI
- `google_tokens`: token OAuth Google per utente

### CRM base

- `anagrafiche`: clienti, fornitori, PA, misti
- `anagrafiche_contatti`: contatti per anagrafica
- `pa_dettagli`: metadati specifici PA
- `attivita`: attivita' CRM e operative

### Catalogo e acquisti

- `categorie`
- `prodotti`
- `prodotti_media`
- `prodotti_listini`
- `prodotti_fornitori`
- `prezzi_storico`
- `kit`
- `kit_componenti`

### Commerciale e documentale

- `preventivi`
- `preventivi_righe`
- `ordini`
- `ordini_righe`
- `ordini_allegati`
- `ddt`
- `ddt_righe`
- `fatture`
- `fatture_righe`
- `fatture_iva_riepilogo`

### Logistica e import/export

- `container`
- `container_righe`
- `proforme_invoice`
- `proforme_righe`
- `proforme_alert`
- `spedizioni`
- `spedizioni_documenti`
- `spedizioni_costi`

### Integrazioni, notifiche e logging

- `sync_log`
- `mepa_mail_alerts`
- `notifiche_app`
- `email_templates`
- `ai_usage_log`
- `audit_log`
- `system_log`
- `web_push_subscriptions`

### Intelligence

- `mepa_ordini`
- `mepa_import_log`
- `mepa_categorie_abilitate`
- `mepa_cpv_catalog`
- `rdo_imports`
- `rdo_rows`
- `cig_stats`
- `cig_import_log`
- `cpv_stats`
- `gare_dettaglio`
- `anac_sync_log`

### Ricambi/chat

- `parts_requests`
- `parts_request_vehicle_data`
- `parts_request_oe_results`
- `parts_request_equivalents`
- `parts_request_events`
- `parts_request_notes`
- `parts_request_intake_state`
- `whatsapp_conversations`
- `whatsapp_messages`
- `parts_request_metrics_daily`

## 9. Relazioni DB reali con FOREIGN KEY

Questa sezione elenca le relazioni effettivamente presenti nel database.

### Sicurezza e configurazione

- `permessi.ruolo_id -> ruoli.id`
- `utenti.ruolo_id -> ruoli.id`
- `google_tokens.utente_id -> utenti.id`
- `ai_usage_log.utente_id -> utenti.id`
- `audit_log.utente_id -> utenti.id`
- `system_log.utente_id -> utenti.id`
- `web_push_subscriptions.utente_id -> utenti.id` con `ON DELETE CASCADE`
- `notifiche_app.utente_id -> utenti.id`

### CRM base

- `anagrafiche_contatti.anagrafica_id -> anagrafiche.id` con `ON DELETE CASCADE`
- `pa_dettagli.anagrafica_id -> anagrafiche.id` con `ON DELETE CASCADE`
- `attivita.anagrafica_id -> anagrafiche.id`
- `attivita.ordine_id -> ordini.id`
- `attivita.utente_id -> utenti.id`

### Catalogo prodotti e kit

- `prodotti.categoria_id -> categorie.id`
- `prodotti_media.prodotto_id -> prodotti.id` con `ON DELETE CASCADE`
- `prodotti_listini.prodotto_id -> prodotti.id` con `ON DELETE CASCADE`
- `prodotti_fornitori.prodotto_id -> prodotti.id`
- `prodotti_fornitori.fornitore_id -> anagrafiche.id`
- `prezzi_storico.prodotto_fornitore_id -> prodotti_fornitori.id`
- `kit.categoria_id -> categorie.id`
- `kit_componenti.kit_id -> kit.id` con `ON DELETE CASCADE`
- `kit_componenti.prodotto_id -> prodotti.id`

### Commerciale e documentale

- `preventivi.anagrafica_id -> anagrafiche.id`
- `preventivi_righe.preventivo_id -> preventivi.id` con `ON DELETE CASCADE`
- `preventivi_righe.prodotto_id -> prodotti.id`
- `ordini.anagrafica_id -> anagrafiche.id`
- `ordini_righe.ordine_id -> ordini.id` con `ON DELETE CASCADE`
- `ordini_righe.prodotto_id -> prodotti.id`
- `ordini_allegati.ordine_id -> ordini.id` con `ON DELETE CASCADE`
- `ddt.ordine_id -> ordini.id`
- `ddt.mittente_id -> anagrafiche.id`
- `ddt.destinatario_id -> anagrafiche.id`
- `ddt_righe.ddt_id -> ddt.id` con `ON DELETE CASCADE`
- `ddt_righe.prodotto_id -> prodotti.id`
- `fatture.anagrafica_id -> anagrafiche.id`
- `fatture_righe.fattura_id -> fatture.id` con `ON DELETE CASCADE`
- `fatture_righe.prodotto_id -> prodotti.id`
- `fatture_iva_riepilogo.fattura_id -> fatture.id` con `ON DELETE CASCADE`

### Logistica

- `container.fornitore_id -> anagrafiche.id`
- `container_righe.container_id -> container.id` con `ON DELETE CASCADE`
- `container_righe.prodotto_id -> prodotti.id`
- `magazzino_movimenti.prodotto_id -> prodotti.id`
- `proforme_invoice.fornitore_id -> anagrafiche.id`
- `proforme_righe.proforma_id -> proforme_invoice.id` con `ON DELETE CASCADE`
- `proforme_alert.proforma_id -> proforme_invoice.id` con `ON DELETE CASCADE`
- `spedizioni_documenti.spedizione_id -> spedizioni.id` con `ON DELETE CASCADE`
- `spedizioni_costi.spedizione_id -> spedizioni.id` con `ON DELETE CASCADE`

### Intelligence

- `rdo_rows.import_id -> rdo_imports.id` con `ON DELETE CASCADE`

### Ricambi/chat

- `parts_requests.customer_id -> anagrafiche.id`
- `parts_requests.assigned_to_user_id -> utenti.id`
- `parts_request_vehicle_data.parts_request_id -> parts_requests.id` con `ON DELETE CASCADE`
- `parts_request_oe_results.parts_request_id -> parts_requests.id` con `ON DELETE CASCADE`
- `parts_request_equivalents.parts_request_id -> parts_requests.id` con `ON DELETE CASCADE`
- `parts_request_equivalents.oe_result_id -> parts_request_oe_results.id` con `ON DELETE SET NULL`
- `parts_request_events.parts_request_id -> parts_requests.id` con `ON DELETE CASCADE`
- `parts_request_notes.parts_request_id -> parts_requests.id` con `ON DELETE CASCADE`
- `parts_request_notes.author_user_id -> utenti.id` con `ON DELETE SET NULL`
- `parts_request_intake_state.parts_request_id -> parts_requests.id` con `ON DELETE CASCADE`
- `whatsapp_conversations.customer_id -> anagrafiche.id`
- `whatsapp_conversations.parts_request_id -> parts_requests.id` con `ON DELETE SET NULL`
- `whatsapp_conversations.assigned_to_user_id -> utenti.id` con `ON DELETE SET NULL`
- `whatsapp_messages.conversation_id -> whatsapp_conversations.id` con `ON DELETE CASCADE`

## 10. Relazioni logiche importanti senza vincolo FK

Queste relazioni esistono a livello di business o schema, ma non sono enforce-ate da SQLite.

### Commerciale

- `ordini.preventivo_id -> preventivi.id`
- `fatture.ordine_id -> ordini.id`
- `fatture.proforma_id -> proforme_invoice.id`
- `fatture.spedizione_id -> spedizioni.id`
- `fatture.ordine_fornitore_id -> ordini.id`
- `fatture.ordine_cliente_id -> ordini.id`
- `ddt.fattura_id -> fatture.id`

### Logistica

- `proforme_invoice.ordine_cliente_id -> ordini.id`
- `proforme_invoice.ordine_fornitore_id -> ordini.id`
- `proforme_invoice.spedizione_id -> spedizioni.id`
- `spedizioni.fornitore_id -> anagrafiche.id`
- `spedizioni.cliente_id -> anagrafiche.id`
- `spedizioni.ordine_cliente_id -> ordini.id`
- `spedizioni.ordine_fornitore_id -> ordini.id`
- `spedizioni.proforma_id -> proforme_invoice.id`
- `spedizioni.fattura_id -> fatture.id`

### Ricambi

- `parts_requests.linked_product_id -> prodotti.id`
- `parts_requests.linked_preventivo_id -> preventivi.id`

### Integrazioni Google/MEPA

- `mepa_mail_alerts.utente_id` e' concettualmente collegato a `utenti.id`, ma non ha FK SQL
- `mepa_mail_alerts.attivita_id -> attivita.id` solo logico
- `mepa_mail_alerts.anagrafica_id -> anagrafiche.id` solo logico

### Operational metadata

- `attivita.assegnato_a -> utenti.id` e' una colonna aggiunta, ma non vincolata con FK
- `attivita.origine_id` dipende dal valore di `stato_origine`, quindi e' polymorphic/logico

## 11. Flussi business principali

### Lead/commerciale

1. creazione anagrafica cliente o PA;
2. eventuale creazione contatti;
3. attivita' commerciali collegate;
4. creazione preventivo;
5. conversione a ordine;
6. emissione DDT;
7. eventuale fattura.

### Acquisti/import

1. anagrafica fornitore;
2. associazione prodotto-fornitore;
3. ordine acquisto;
4. proforma invoice;
5. container o spedizione;
6. DDT entrata / movimenti magazzino;
7. fattura ricevuta.

### Ricambi conversazionali

1. messaggio inbound WhatsApp/Telegram;
2. creazione/riuso `parts_request`;
3. aggiornamento `whatsapp_conversations` e `whatsapp_messages`;
4. intake progressivo dati veicolo/ricambio;
5. eventuale AI vision su immagini;
6. lookup OE / equivalenti;
7. creazione prodotto e/o preventivo;
8. invio PDF preventivo al cliente;
9. tracciamento note, eventi e metriche.

### Calendario e notifiche

1. utente collega Google;
2. token salvato in `google_tokens`;
3. eventi attivita' sincronizzati con Calendar;
4. notifiche salvate in `notifiche_app`;
5. eventuale push web via `web_push_subscriptions`.

## 12. Generazione documentale

`src/services/document-pdf.js` genera PDF per:

- preventivi;
- ordini;
- DDT.

Pattern di progettazione:

- header aziendale comune;
- tema colore per tipo documento;
- tabelle righe dinamiche;
- box informativi;
- numerazione pagine;
- per i preventivi, link pubblico alla scheda prodotto.

## 13. Integrazioni esterne

### Google

- OAuth2
- Calendar
- Drive
- Gmail
- Contacts

### AI

- provider OpenAI
- provider Claude
- salvataggio configurazioni in `app_settings`
- cifratura secret con AES-256-GCM

### Messaging

- WhatsApp webhook/API
- Telegram webhook

### Ricambi/aftermarket

- RTWS per lookup tecnici

### Procurement/analytics

- MEPA
- RdO
- CIG
- ANAC/CPV analytics

## 14. Logging e osservabilita'

Livelli di logging applicativo:

- `audit_log`: traccia azioni business/utente
- `system_log`: errori tecnici e diagnostica
- `ai_usage_log`: costi e token AI
- `sync_log`: sincronizzazioni generiche
- `parts_request_events`: eventi puntuali del modulo ricambi
- `mepa_import_log`, `cig_import_log`, `anac_sync_log`: log di import/sync specializzati

`src/index.js` registra anche errori globali di processo.

## 15. Considerazioni progettuali importanti

### Punti forti

- dominio coperto in modo ampio in un unico applicativo;
- schema SQLite ricco ma leggibile;
- buona separazione route/service;
- RBAC semplice ed efficace;
- moduli documentali e logistici gia' integrati;
- modulo ricambi molto avanzato;
- PWA e push gia' presenti.

### Debiti tecnici / aspetti da ricordare

- assenza di migration framework versionato;
- varie relazioni solo logiche e non FK;
- naming non completamente uniforme tra `creato_il` e `created_at`;
- parte schema inizializzata in file diversi, non solo in `database.js`;
- frontend in JavaScript vanilla molto grande, con logica concentrata in `public/js/app.js`;
- il modulo `parts.js` e' molto esteso e richiede cautela nelle modifiche.

### Implicazioni pratiche per Claude

- prima di aggiungere colonne o tabelle, verificare sia `src/db/database.js` sia eventuali bootstrap in `routes` e `services`;
- distinguere sempre tra relazione SQL reale e relazione solo applicativa;
- nei refactor del frontend evitare assunzioni da framework moderni: e' una SPA vanilla;
- nelle modifiche a permessi verificare `APP_SECTIONS`, `ruoli`, `permessi` e uso di `requirePermesso`;
- nei flussi documentali considerare sia file locali sia possibili ID Google Drive;
- nei flussi ricambi verificare impatto su webhook, stato intake, preventivi e messaggistica.

## 16. Checklist rapida di orientamento

Se Claude deve lavorare sul progetto, i primi file da leggere sono:

1. `src/index.js`
2. `src/db/database.js`
3. `src/middleware/auth.js`
4. `public/index.html`
5. `public/js/app.js`
6. il route file del dominio interessato
7. l'eventuale service collegato

## 17. Sintesi finale

Horygon CRM non e' solo un CRM classico: e' un gestionale operativo/commerciale con componenti di:

- CRM;
- procurement pubblico;
- documentale;
- logistica import/export;
- workflow ricambi conversazionali;
- integrazioni Google;
- AI e notifiche.

Il cuore della progettazione e' un monolite Node.js + Express + SQLite, con SPA frontend vanilla e una forte modellazione dati centrata su anagrafiche, prodotti, documenti commerciali, logistica e conversazioni ricambi.

---

## 18. Integrazione RTWS ricambi — stato lavori (aggiornato 2026-07-08)

Progetto in corso: dalla **targa/foto** al **ricambio con OE + prezzo** via web services RTWS di Editoriale Domus (Infocar RT / QuattroRuote). Branch `codex/ricambi-area`.

### 18.1 Vincoli infrastruttura
- **Host VPS** `/opt/horygon-crm` gira **Node 12**: gli script CLI in `scripts/` devono essere self-contained (niente `dotenv`, niente `??`/`?.`/`matchAll`), leggono il `.env` da soli.
- **App in Docker Node 24** (`node:sqlite` / `DatabaseSync`; transazioni con `db.exec('BEGIN')`, non `.transaction()`).
- Deploy: `docker compose up -d --build` (ricostruisce l'immagine, necessario dopo modifiche a `scripts/` o schema). `./deploy.sh` fa `down` + rebuild ma si blocca se la worktree ha file non tracciati.
- **WAL fix**: solo `horygon.db` e' montato (non i sidecar `-wal`/`-shm`), quindi le scritture nel WAL si perdevano al recreate del container. Risolto: handler SIGTERM in `index.js` fa `PRAGMA wal_checkpoint(TRUNCATE)`; l'import fa checkpoint a fine run. Montata anche `./data:/app/data`.
- WhatsApp: firma webhook verificata via `WHATSAPP_APP_SECRET` (fix gia' live).

### 18.2 Prodotti RTWS attivi (contratto BDRTws-dan772724)
- `RTWS_BDRT` (illimitato) — catalogo ricambi. `RTWS_LISTINI` (illimitato) — listini/equivalenti/cristalli. `RTWS_TARGATELAIO` (**50 crediti**, scad. 31/08/2026) — identificazione veicolo da targa.
- NON attivi: IDENTIFICAZIONE, EQUIVALENTI, DATI-TECNICI, TEMPI-MECH.
- WSDL: `https://www.infocar.org/rtwebservices/rtservice.asmx?wsdl`, namespace `http://tempuri.org/`, SOAP 1.2. Login con `<productName>` (grafia giusta `RTWS_TARGATELAIO`, senza underscore; la guida PDF con `RTWS_TARGA_TELAIO` e XML semplificato e' inaffidabile — fidarsi del WSDL).

### 18.3 Flusso ricambi validato (funziona)
1. **Targa -> veicolo**: `GetRTCompletoDaTargaMin` (TARGATELAIO, 1 credito/targa) -> Allestimenti con `IdMar/IdMod/IdVer` interi BDRT. Cachato in `rtws_targa_cache` (1 credito per targa, poi gratis).
2. **idpar -> originali**: `GetRicambiDBRT(sessionId, context{Marca,Modello,Versione,CodLingua,Idpars:[<Idpar>N</Idpar>]})` (BDRT) -> `DBRT_Part.VariantiListino{Dspar,Parno=OE,Przli=prezzo}`. Validato: Clio(19,85,2) idpar 4916 -> Filtro olio OE 152082327R 26,78€ + 152095084R 20,10€.
3. **OE -> compatibili**: `GetListiniEquivalenti` (LISTINI). ⚠️ nei test torna 0 equivalenti per il filtro — DA VERIFICARE (forse `sanitizeOeCode` rovina il suffisso "R", o non ci sono equivalenti).
- **Enumerazione bloccata**: `GetIdParBDRTCompleto` torna vuoto, `GetIdParBDRT` da AccessError. Non serve: usiamo il **dizionario idpar** costruito da noi.

### 18.4 Dizionario idpar (codice QuattroRuote -> descrizione)
- Universale (idpar 4916 = "Filtro olio" per ogni veicolo). Domus non fornisce l'export: lo costruiamo scansionando `GetRicambiDBRT` a blocchi (`scripts/rtws-dictionary-scan.js` -> `data/rtws-idpar-dictionary.json`, BDRT illimitato). Import nel container: `scripts/import-idpar-dictionary.js` -> tabella `rtws_idpar_dizionario` (560 voci dalla Clio). Arricchibile con altri veicoli (diesel/SUV per FAP/turbina/ecc.).

### 18.5 Fase 1 FATTA (additiva, flusso WhatsApp intatto)
Tutto in `src/routes/parts.js` + tabelle in `src/db/database.js`:
- Tabelle `rtws_idpar_dizionario`, `rtws_targa_cache`.
- `rtwsGetVehicleCompletoByPlate` (con cache), `rtwsGetRicambiDbrt`, `parseRtwsAllestimentiCompleto`, `parseRtwsDbrtVariants`.
- `lookupIdparByText` con espansione sinonimi (anteriore->ant, dx/sx, faro->proiettore...).
- Rotta test `POST /api/parts/rtws-lookup` `{plate, partText?, idpar?}` -> veicolo + candidati idpar + varianti originali/compatibili etichettate. **Validata via API** (Clio + filtro olio OK).

### 18.5-bis Fase 2 — mattoni FATTI (additivi, testati singolarmente)
- **Preventivo multi-riga**: `getOrCreateOpenQuoteForRequest`, `addVariantLineToQuote`, `recomputeQuoteTotals`, `getQuoteSummary` (accumula varianti in una bozza per conversazione).
- **Varianti**: `getVariantsForIdpar` (originali GetRicambiDBRT + compatibili GetListiniEquivalenti, dedup, gestisce vuoto) + presentazione `formatVariantLine`/`buildVariantPage` (etichette Originale/Compatibile · OE · prezzo, paginazione 10, flag prossimi/precedenti).
- **Foto→idpar**: `aiPickIdparFromCandidates` (AI sceglie l'idpar dai candidati guardando la foto, vincolato alla lista), `resolveIdparFromMedia` (vision→candidati dizionario→verifica AI); `analyzeInboundMediaWithOpenAI` ora espone `imageDataUrl`.
- **Compatibili**: decisione presa (opzione 1) — mostriamo originali + equivalenti-quando-ci-sono, con gestione vuoto. L'aftermarket vero (Bosch/Mann via TecDoc) richiede prodotto `RTWS_EQUIVALENTI` NON attivo — valutare con Domus se serve. La sonda `rtws-equivalenti-probe.js` ha mostrato che per il filtro Clio non ci sono equivalenti (dato reale, non bug).
- Rotta test `POST /api/parts/rtws-lookup` aggiornata: usa `getVariantsForIdpar`, ritorna `chat_preview` + `has_next_page`.

### 18.5-ter Dati validati end-to-end via API (rotta /api/parts/rtws-lookup)
Targa FP781GE + "filtro olio" → veicolo Clio (cache), chosen_idpar 4916, 2 varianti originali (OE 152082327R 26,78€ / 152095084R 20,10€), `chat_preview` = testo pronto per il bot. Compatibili 0 (dato reale per quel filtro). Logging inbound+eccezioni su system_log attivo.

### 18.6 Fase 2 — ULTIMO PASSO: wiring bot — ARCHITETTURA DECISA, DA IMPLEMENTARE
**Tutto nell'orchestratore `processInboundPartsMessage`** (ha request/crediti/invio/stato); il resolver `resolvePartsMessageV2` resta INTATTO (solo identificazione targa+pezzo). Dietro flag env **`PARTS_ENABLE_MECC_FLOW`** (kill-switch: off = comportamento attuale invariato). Cristalli invariati (categoria 'cristalli' → salta il ramo meccanici).
Flusso: load intakeState → se stage mecc (`mecc_variant_selection`/`mecc_another_part`) gestisci input (numero→addVariantLineToQuote, Prossimi10/Precedenti10/Vedi tutti, Altro pezzo/Chiudi) e RETURN; altrimenti resolver normale, poi se identificato targa + pezzo non-vetro → entra nel ramo: `rtwsGetVehicleCompletoByPlate` (cache) → `lookupIdparByText`/`resolveIdparFromMedia` (foto) → `getVariantsForIdpar` → `buildVariantPage` → invia lista + set stage. Aggiungere i casi stage mecc a `buildTelegram/WhatsAppReplyOptionsForResolved`. Preventivo: `getOrCreateOpenQuoteForRequest`+`addVariantLineToQuote`. Chiudi = fine sessione, no PDF. Log ogni passo (logPartEvent + writeSystemLog). Daniele testa su Telegram/WhatsApp e riporta intoppi coi log.
Il flusso Telegram/WhatsApp NON usa ancora il nuovo percorso. Il resolver e' `resolvePartsMessageV2` (~1800 righe, delicato). Menu/tasti gia' esistono (root menu, categorie, slot posizione/lato/asse, conferma preventivo SI/NO, azioni sessione). Decisioni prese: **originali+compatibili in un'unica lista etichettata**; **cristalli invariati** (solo aggiungere i loro idpar al dizionario).

Flusso target proposto: targa/foto -> veicolo -> "che ricambio?" -> match idpar -> mostra varianti etichettate -> scegli -> "aggiungi al preventivo" -> "altro pezzo?" (cicla, preventivo multi-riga) / "chiudi" -> PDF. Il preventivo oggi e' **riga singola** (`createDraftQuoteFromRequest`): va evoluto a **multi-riga accumulato** per conversazione.

**Domande aperte per Daniele (attese domani):**
1. Modifiche specifiche ai menu/tasti (punti 1-2 del flusso)?
2. Varianti numerose: lista completa o primi N + "vedi altri"?
3. Preventivo legato ad anagrafica cliente (dal numero) o anonimo con sola targa?
4. A "chiudi": mando il PDF al cliente in chat o solo riepilogo + PDF interno?

Inoltre: verificare compatibili (GetListiniEquivalenti), decidere modello AI per classificazione foto (Sonnet 5 alta-risoluzione per libretto vs gpt-4o-mini attuale), aggiungere idpar cristalli al dizionario.

### 18.7 Script diagnostici (in `scripts/`, tutti Node 12, no crediti se solo BDRT)
`rtws-products-check` (prodotti attivi), `rtws-flow-test <targa> [testo]` (1 credito, catena completa), `rtws-bdrt-probe <M M V>`, `rtws-ricambi-probe <M M V> [idpar]`, `rtws-dictionary-scan <M M V> [max] [batch]`, `import-idpar-dictionary` (nel container).
