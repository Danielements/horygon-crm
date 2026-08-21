# Contabilità — documento di design (pre-implementazione)

Data: 2026-08-13. Branch `codex/sdi-diagnostics`.

Questo documento risponde ai punti 1 e 48 della specifica: **prima l'analisi, poi
l'implementazione per fasi**. Non contiene codice applicativo. È la base da
approvare prima di partire con la Fase A.

## Stato avanzamento

- **Fase A — Fondamenta: FATTA** (2026-08-21, commit `1ab4160`). Consegnato:
  tabelle `cont_categorie`/`cont_centri_costo`/`cont_commesse`/
  `cont_classificazioni`/`cont_pagamenti`/`cont_pagamenti_fatture`; sezione
  `contabilita` in `APP_SECTIONS` con RBAC (admin/superadmin pieno,
  amministrazione read+edit, commercialista read); `contabilita-service.js`
  (paymentStatus derivato + cache in `fatture.stato_pagamento`, split
  classificazione, pagamenti M:N, dashboard); route `/api/contabilita`; menu +
  sezione a tab nella SPA; `tests/contabilita.test.js` (suite verde).
- **Fase B — Banca & riconciliazione: FATTA** (2026-08-21, commit `668d051`).
  Consegnato: tabelle `cont_conti`/`cont_banca_template`/`cont_banca_import`/
  `cont_movimenti_bancari` (fingerprint UNIQUE); `bank-service.js` (parsing
  importi IT/US e date, mapping colonne, import idempotente, matchScore,
  riconciliazione parziale e uno-a-molti che riusa i pagamenti Fase A);
  route conti/template/banca(preview+import)/movimenti/riconciliazione; tab
  Banca (wizard import con template) e Riconciliazione; `tests/bank.test.js`.
- **Fase C — Flussi gestionali: FATTA** (2026-08-21, commit `2567f2b`).
  Consegnato: `cont_nota_manuale`; `gestione-service.js` (scadenzario a bucket,
  prima nota come vista cronologica con saldo, cash flow mensile, anomalie);
  route `/scadenze`, `/prima-nota` (+ export CSV), `/cashflow`, `/anomalie`,
  `/nota-manuale`; tab Scadenze/Prima nota/Cash flow/Anomalie;
  `tests/gestione.test.js`.
- **Fase D (core) — Spese documentate e manuali: FATTA** (2026-08-21, commit
  `655a991`). Scelta operativa: **niente estrazione AI**, inserimento manuale
  (Daniele inserisce i costi a mano; l'allegato foto/PDF e' opzionale).
  Consegnato: `cont_documenti` (sha256, originale intoccabile) + `cont_spese`;
  `spese-service.js` (validazione, magic bytes, CRUD); spese in prima nota +
  KPI dashboard; route `/spese` (+ download documento); tab Spese;
  `tests/spese.test.js`. **Estrazione AI (OCR) rinviata**: l'adapter e i campi
  con confidence restano da fare se e quando servira'.
- Fasi E–F: da fare. E (anticipi/rimborsi/budget/report), F (commercialista:
  checklist mese + export ZIP/XLSX).

Principi fissati dalla specifica, che vincolano tutto il resto:

- **Pre-contabilità e controllo di gestione**, non contabilità fiscale. Un report
  gestionale non è un "bilancio"; una stima IVA non è una "liquidazione".
- **Uso interno di HORYGON S.R.L.** Non è un prodotto SaaS, non introduco
  multi-tenant nuovo (i `tenants` esistono già solo per SdI; le nuove entità
  restano mono-tenant come il resto del CRM).
- **Non duplicare**: le fatture sono quelle SdI già presenti, i clienti/fornitori
  sono le `anagrafiche`, gli utenti/permessi sono quelli esistenti.
- **File originali intoccabili**: XML/P7M/estratti conto non si modificano né si
  cancellano. Solo `archiviato`/`annullato`/`sostituito` con audit.
- **AI mai fonte fiscale**: l'estrazione è un suggerimento, sempre validato lato
  server; la chiave OpenAI sta solo server-side.

---

## 1. Architettura attuale rilevante

Stack: Node/Express 5, SQLite (`node:sqlite`), SPA vanilla (`public/index.html` +
`public/js/app.js`), PWA con `manifest.webmanifest` e `service-worker.js`, upload
locali in `uploads/` via `multer`. RBAC con `ruoli`/`permessi`/`utenti` e
`requirePermesso(sezione, azione)`. Sezioni in `APP_SECTIONS`
(`src/db/database.js:1084`). Migrazioni additive (`CREATE TABLE IF NOT EXISTS` +
`ALTER TABLE ... ADD COLUMN` in try/catch). Audit in `audit_log`, errori tecnici
in `system_log`, costi AI in `ai_usage_log`.

Sistema fatture/SdI (fonte primaria, da riusare **integralmente**):

- `fatture` — emesse e ricevute, con `direzione` (attiva/passiva), `tipo`
  (emessa/ricevuta), `tipo_documento` (fattura/nota_credito), `anagrafica_id`,
  `ordine_id`, `data`, `scadenza`, `imponibile`, `iva`, `totale`, `stato`,
  **`stato_pagamento`** (oggi solo `da_pagare`, di fatto inutilizzato),
  `stato_sdi`, `sdi_id`, `xml_path`, `hash_*`, `cig`, `cup`, `esigibilita_iva`,
  `fattura_riferimento_id` (note di credito), `tenant_id`, `source`,
  `origine_importazione`.
- `fatture_righe`, `fatture_iva_riepilogo`, `fatture_allegati_xml`,
  `fatture_documenti_correlati`.
- `fatture_sdi_flussi` (trasmissioni + stato consegna), `fatture_sdi_notifiche`
  (ricevute SdI), `sdi_progressivi`, `sdi_historical_sync_*` (backfill SMTS, 34
  documenti già importati), `sdi_reconciliation_*` (quadratura flussi SdI — NON è
  riconciliazione bancaria).
- `regole_iva` (28 trattamenti IVA), motore in `src/services/iva.js`.

CRM base: `anagrafiche` (clienti/fornitori/PA/misti, con `tipo` e
`tipologia_cliente`), `anagrafiche_contatti`, `pa_dettagli`, `ordini`
(+`ordini_righe`, `ordini_allegati`), `ddt`, `preventivi`, `prodotti`,
`categorie` (categorie **prodotto**, non gestionali).

Config/AI: `app_settings` (chiave/valore), `src/services/ai-settings.js` cifra le
API key (AES-256-GCM) per provider `openai`/`claude`/`runtime`; `ai_usage_log`
per il logging costi. **Non** esiste già una chiamata vision su questo branch.

## 2. Entità riutilizzabili (NON si duplicano)

| Concetto Contabilità | Entità esistente da riusare |
|---|---|
| Fatture emesse/ricevute/note credito | `fatture` (+ righe, iva_riepilogo, sdi_flussi, sdi_notifiche) |
| Cliente / Fornitore | `anagrafiche` (`tipo`/`tipologia_cliente`) |
| Documenti collegati a fattura | `fatture_allegati_xml`, `fatture_documenti_correlati`, `xml_path` |
| Utenti, ruoli, permessi | `utenti`, `ruoli`, `permessi`, `requirePermesso` |
| Config e secret | `app_settings`, `ai-settings.js` (cifratura), ENV |
| Log AI / audit / errori | `ai_usage_log`, `audit_log`, `system_log` |
| Storage file | `uploads/` + `multer` (già fuori dalla web root `public/`) |
| Mobile + fotocamera | PWA esistente + `<input accept="image/*" capture>` |
| Numerazione/hash/dedup | pattern già usati in `fattura-import` e SdI |

## 3. Nuove entità necessarie (schema DB proposto)

Tutte nuove (nessuna esiste). Naming coerente col resto (`creato_il`,
`INTEGER` 0/1, JSON in testo). FK reali dove il ciclo di vita lo giustifica,
logiche altrove (come già nel progetto).

**Classificazione**
- `cont_categorie` — categorie gestionali costo/ricavo. Campi: `id`, `nome`,
  `tipo` (`COST`/`REVENUE`/`NEUTRAL`), `parent_id` (gerarchia), `attiva`,
  `ordine`, `colore`. Modificabili da UI, **non hardcodate**.
- `cont_centri_costo` — gerarchici. `id`, `nome`, `parent_id`, `attivo`,
  `codice`, `note`. **Non hardcodati** (la struttura d'esempio è solo un seed
  opzionale).
- `cont_commesse` — progetti. `id`, `nome`, `anagrafica_id` (cliente),
  `valore_previsto`, `budget`, `data_inizio`, `data_fine`, `stato`
  (`aperta`/`chiusa`/`sospesa`), `note`. Distinta dal centro di costo.
- `cont_classificazioni` — allocazione polimorfica di un documento a
  categoria/centro/commessa, **con split percentuale**. `id`, `entita_tipo`
  (`fattura`/`spesa`/`movimento`/`pagamento`), `entita_id`, `categoria_id`,
  `centro_costo_id`, `commessa_id`, `percentuale` (somma = 100 per entità),
  `importo` (derivato). Una riga per quota dello split.

**Pagamenti / incassi**
- `cont_pagamenti` — incasso o pagamento. `id`, `verso` (`incasso`/`pagamento`),
  `data`, `importo`, `metodo`, `movimento_bancario_id` (logico),
  `anagrafica_id`, `note`, `stato`, `creato_da`.
- `cont_pagamenti_fatture` — ponte molti-a-molti: un pagamento su più fatture e
  più pagamenti su una fattura (§13). `pagamento_id`, `fattura_id`,
  `importo_quota`. Il **paymentStatus** della fattura è derivato da qui.

**Banca**
- `cont_conti` — conti correnti/carte. `id`, `nome`, `iban`, `intestatario`,
  `valuta`, `saldo_iniziale`, `attivo`.
- `cont_movimenti_bancari` — `id`, `conto_id`, `data_operazione`, `data_valuta`,
  `importo`, `segno`, `descrizione`, `controparte`, `iban_controparte`, `trn`,
  `cro`, `transaction_id`, `raw_data` (JSON), `fingerprint` (UNIQUE, per
  idempotenza), `file_origine_id`, `stato_riconciliazione`
  (`da_riconciliare`/`riconciliato`/`ignorato`/`parziale`).
- `cont_banca_template` — mapping colonne per banca. `id`, `nome`
  (Poste/Intesa/UniCredit/BPER/Custom), `mapping` (JSON colonna→campo),
  `formato_data`, `separatore`, `decimale`.
- `cont_banca_import` — batch di import. `id`, `conto_id`, `template_id`,
  `file_id`, `righe_totali`, `righe_importate`, `righe_duplicate`, `creato_il`.

**Ricevute / spese / documenti**
- `cont_documenti` — file archiviati (ricevute/scontrini/PDF). `id`, `path`
  (originale), `preview_path`, `sha256`, `mime`, `dimensione`, `original_filename`
  (sanitizzato), `caricato_da`, `creato_il`. **Originale mai distrutto.**
- `cont_spese` — spesa/ricevuta gestionale. `id`, `documento_id`, `data`,
  `fornitore_nome`, `fornitore_piva`, `numero_documento`, `imponibile`, `iva`,
  `totale`, `valuta`, `metodo_pagamento`, `categoria_id`, `centro_costo_id`,
  `commessa_id`, `pagata_con` (`azienda`/`anticipo_personale`), `utente_anticipo`,
  `rimborso_dovuto`, `rimborso_id`, `movimento_bancario_id` (match), `stato`
  (`bozza`/`confermata`/`archiviata`), `fonte` (`manuale`/`ocr`).
- `cont_estrazioni` — risultato AI/OCR con confidence per campo. `id`,
  `documento_id`, `provider`, `modello`, `payload` (JSON `{campo:{value,
  confidence}}`), `confidence_media`, `esito`, `latency_ms`, `token`, `costo`,
  `errore`, `creato_il`. Ogni correzione umana viene auditata.
- `cont_rimborsi` — nota spese. `id`, `utente_id`, `periodo`, `totale`, `stato`
  (`DRAFT`/`TO_REVIEW`/`APPROVED`/`PAID`), `approvato_da`, `pagato_il`. Le
  `cont_spese` con `anticipo_personale` vi si agganciano.

**Controllo / automazione**
- `cont_budget` — `id`, `periodo` (mese/anno), `categoria_id`/`centro_costo_id`/
  `commessa_id` (uno), `importo_budget`.
- `cont_regole` — regole automatiche di classificazione. `id`, `match_tipo`
  (`descrizione`/`piva`/`controparte`), `match_valore`, `categoria_id`,
  `centro_costo_id`, `commessa_id`, `attiva`, `priorita`. Create **solo su
  conferma** dopo N correzioni uguali.
- `cont_export_log` — export commercialista. `id`, `periodo`, `zip_path`,
  `riepilogo` (JSON conteggi), `creato_da`, `creato_il`.
- `cont_nota_manuale` — voci di prima nota inserite a mano (non derivabili dalle
  fonti). La **prima nota** completa è una *vista* che unisce fatture, pagamenti,
  movimenti banca, spese e queste voci manuali.

**paymentStatus** (§5): NON è una colonna nuova hardcodata ma un valore
**derivato** da `cont_pagamenti_fatture`: `UNPAID` / `PARTIALLY_PAID` / `PAID` /
`OVERPAID`, tenuto separato da `stato_sdi`. Aggiorno `fatture.stato_pagamento`
come cache denormalizzata (ricalcolata a ogni pagamento), così le liste restano
veloci.

## 4. Migrazioni DB

Stesso schema evolutivo del progetto: in `src/db/database.js`, blocco
`CREATE TABLE IF NOT EXISTS cont_*` idempotente, più `ensureColumn` per le poche
aggiunte su tabelle esistenti (nessuna serve subito: `fatture.stato_pagamento`
c'è già). Nessuna FK distruttiva; `ON DELETE` solo dove il figlio non ha senso
senza il padre (`cont_pagamenti_fatture`, `cont_classificazioni`,
`cont_spese`→`cont_documenti`). Seed **opzionale e disattivabile** per categorie e
centri di costo d'esempio (l'utente li modifica). Le tabelle nascono per fase
(vedi roadmap), non tutte insieme.

## 5. API (per dominio, sotto `/api/contabilita`)

- Classificazione: CRUD `/categorie`, `/centri-costo`, `/commesse`;
  `POST /classifica` (assegna/split categoria+centro+commessa a un documento).
- Fatture (vista contabile, **riusa** le fatture esistenti, non le duplica):
  `GET /contabilita/fatture` con filtri (direzione, stato pagamento, scadenza,
  categoria, centro, commessa, periodo); `POST /fatture/:id/pagamenti`.
- Pagamenti: CRUD `/pagamenti`, con abbinamento a una o più fatture.
- Banca: `POST /banca/upload` → `POST /banca/preview` (mapping) →
  `POST /banca/import` (idempotente); CRUD `/conti`, `/banca/template`;
  `GET /movimenti`.
- Riconciliazione: `GET /riconciliazione/proposte` (matchScore),
  `POST /riconciliazione/abbina|dividi|ignora|crea-movimento`.
- Scadenze: `GET /scadenze` (da incassare/da pagare, bucket 7/30/60/90, scaduto).
- Spese/ricevute: `POST /spese` (multipart, foto/PDF), `POST /spese/:id/analizza`
  (AI, server-side), CRUD `/spese`, `GET /spese/:id/match-banca`.
- Rimborsi: CRUD `/rimborsi`, transizioni stato.
- Prima nota: `GET /prima-nota` (+ export XLSX/CSV), CRUD `/nota-manuale`.
- Cash flow / Budget / Controllo gestione: `GET /cashflow`, CRUD `/budget`,
  `GET /report/gestionale`.
- Commercialista: `GET /commercialista/stato`, `POST /commercialista/controllo`,
  `POST /commercialista/export` (ZIP).
- Anomalie: `GET /anomalie`.

Tutte sotto `requirePermesso('contabilita', ...)`. Aggiungo `contabilita` ad
`APP_SECTIONS`; valuto sotto-permessi (`contabilita_banca`,
`contabilita_export`) se serve granularità per ruolo.

## 6. UI — menu e schermate

Nuova voce di menu **CONTABILITÀ** con: Dashboard, Fatture, Banca,
Riconciliazione, Scadenze, Spese e ricevute, Centri di costo, Commesse, Prima
nota, Cash flow, Budget, Commercialista, Impostazioni. Coerente con la SPA
esistente (sezioni in `index.html`, routing in `app.js`).

**Desktop**: tabelle dense con filtri (periodo, categoria, centro, commessa,
stato pagamento), pannelli di dettaglio, dashboard a card + grafici semplici.

**Smartphone**: le tabelle diventano **card/lista** (non tabelle rimpicciolite);
azioni frequenti col pollice; **bottom action `[ + Spesa ]`** che apre subito
fotocamera / galleria / PDF. La sezione Spese è **mobile-first** dichiarato.

## 7. Flusso foto ricevuta (mobile-first)

`Contabilità → Spese → [+]` → `<input accept="image/*" capture="environment">`
(Scatta foto / Scegli foto / Carica PDF; JPG/PNG/PDF, HEIC se il browser lo
converte) → preview → `[Analizza documento]` → estrazione AI server-side →
campi precompilati con **confidence colorata** (verde/giallo/rosso) → l'utente
controlla/corregge → `[Salva]`. Pochissimi tocchi. L'originale + SHA-256 +
metadati si salvano **prima** dell'analisi; la preview è un file separato.

## 8. Architettura OpenAI (§17-20, 40-41)

- Adapter `DocumentExtractionProvider` (interfaccia) con
  `OpenAiDocumentExtractionProvider` (sostituibile). **Solo server-side.**
- Chiave da **ENV `OPENAI_API_KEY`** (mai frontend/localStorage/DB in chiaro/Git).
  In alternativa la si può leggere dal `ai-settings.js` cifrato già esistente, ma
  di default seguo la specifica: ENV.
- Output **strutturato** (JSON schema §18) con `value`+`confidence` per campo;
  `null` se non leggibile — **mai inventare** (niente aliquote dedotte senza
  regola). Validazione **sempre** lato server.
- Kill-switch `AI_DOCUMENT_EXTRACTION_ENABLED`: se off o OpenAI irraggiungibile,
  la ricevuta si compila **a mano** (upload mai bloccato).
- Logging in `ai_usage_log` + `cont_estrazioni`: modello, token/costo, latency,
  esito, tipo documento. Privacy: si manda al modello solo il necessario
  (l'immagine del documento), con audit delle elaborazioni.

## 9. Flusso banca (§10-11)

`Upload (CSV/XLSX) → Preview → Mapping colonne → Salva template → Import`. Nessuna
banca hardcodata: template per Poste/Intesa/UniCredit/BPER/Custom in
`cont_banca_template`. Import **idempotente** via `fingerprint` UNIQUE
(hash di data+importo+descrizione+trn/cro+conto): ricaricare lo stesso estratto
non crea duplicati. `raw_data` conserva la riga originale.

## 10. Riconciliazione (§12)

`BankReconciliationService`: per ogni movimento propone i candidati
(fattura/nota/spesa/pagamento/movimento manuale) con **matchScore** pesato su
importo, data, ragione sociale, IBAN, numero fattura, TRN/CRO, descrizione,
scadenza. UI con azioni **Abbina / Dividi / Ignora / Crea movimento**. Supporta
pagamenti parziali e un pagamento su più fatture (via `cont_pagamenti_fatture`).
Auto-match ricevuta↔banca dopo l'estrazione (fornitore+data+totale).

## 11. Integrazione fatture SdI (§4)

Le fatture restano quelle esistenti: **fonte primaria, mai duplicate**. La vista
Contabilità legge da `fatture` filtrando `direzione` (EMESSE/RICEVUTE) e
`tipo_documento` (NOTE DI CREDITO). Verifico e, se serve, completo il **sync
delle passive** (§4 e limite noto: le passive `.p7m` dal realtime sono archiviate
ma non sempre importate). Mostro per ogni fattura: numero, data,
cliente/fornitore, imponibile, IVA, totale, **stato SdI** e **stato pagamento**
(separati), scadenza, categoria, centro di costo, commessa, documenti collegati.
XML/P7M **mai modificati**.

## 12. Sicurezza, storage, delete, audit

- File: validazione MIME + estensione + **magic bytes** + dimensione (limite
  configurabile), filename sanitizzato, storage in `uploads/` (fuori da
  `public/`). Originale + SHA-256 + metadati sempre conservati; preview separata.
- **Nessuna cancellazione fisica** di fatture/XML/P7M/movimenti/documenti
  collegati: `archiviato`/`annullato`/`sostituito` con audit.
- Audit (§42) su: classificazione, cambio centro/commessa, riconciliazione e sua
  rimozione, upload ricevuta, OCR eseguito, dato OCR corretto, spesa approvata,
  mese controllato, export creato.

## 13. Roadmap A–F (deliverable + test per fase)

Ogni fase è un rilascio a sé (niente "modifica enorme unica"). Ogni fase chiude
con `npm test` verde e verifica UI desktop+mobile.

- **Fase A — Fondamenta**: sezione+menu Contabilità, permessi, dashboard base,
  `cont_categorie`/`cont_centri_costo`/`cont_commesse` + CRUD, collegamento
  fatture SdI (vista EMESSE/RICEVUTE/NOTE), modello **paymentStatus** derivato +
  `cont_pagamenti`/`cont_pagamenti_fatture`. *Test*: fattura emessa/ricevuta/nota,
  pagata/non pagata/parziale, split centri costo.
- **Fase B — Banca & riconciliazione**: `cont_conti`/`cont_movimenti_bancari`/
  `cont_banca_template`, import CSV/XLSX con mapping e dedup, riconciliazione,
  pagamenti parziali e 1-a-molti. *Test*: CSV, XLSX, duplicato, match 1:1,
  parziale, un pagamento→più fatture, più pagamenti→una fattura.
- **Fase C — Flussi gestionali**: scadenziario, prima nota (+export), cash flow,
  anomalie (`AccountingAnomalyService`).
- **Fase D — Spese mobile + AI**: upload foto/PDF mobile-first, fotocamera,
  `DocumentExtractionProvider`/OpenAI, estrazione+confidence, match banca. *Test*:
  JPG desktop/mobile, capture, PNG, PDF, file non valido, file troppo grande, OCR
  corretto/parziale/errore, OpenAI offline, key mancante, dato null.
- **Fase E — Anticipi, rimborsi, budget, controllo gestione**: anticipi
  personali, rimborsi (DRAFT→PAID), budget, report gestionale.
- **Fase F — Commercialista**: pagina stato mese, controllo mensile (checklist),
  export ZIP/XLSX con XML/P7M originali.

## 14. Cosa NON farò (guardrail §46)

Niente Parts AI qui; niente multi-tenant nuovo; niente duplicazione fatture SdI;
niente contabilità fiscale completa; non chiamo "bilancio" un report gestionale
né "liquidazione IVA" una stima; `OPENAI_API_KEY` mai nel frontend; niente
OpenAI dal browser; AI sempre validata e mai obbligatoria per inserire una spesa;
originale mai perso; nessuna banca/CSV hardcodati; nessun documento fiscale
cancellato; nessuna UI desktop inusabile da telefono.

## 15. Prossimo passo

Se approvi questo impianto (in particolare: schema `cont_*`, paymentStatus
derivato, ENV per la chiave OpenAI, roadmap A–F), parto dalla **Fase A** in un
rilascio contenuto e testato, e ti mostro il risultato prima di procedere alla
Fase B. Dimmi anche se vuoi ritocchi allo schema o alla priorità delle fasi.
