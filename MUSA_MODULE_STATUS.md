# Modulo MUSA — stato e handoff

Aggiornato: 2026-10-05 · Branch `codex/sdi-diagnostics`.

MUSA è una **società separata** da HORYGON (Daniele ne ha l'8% e cura la
fatturazione). Il modulo è **isolato** dentro il CRM: sezione/permesso `musa`
(solo admin/superadmin), chiavi Stripe proprie, nessun dato nel ciclo fiscale di
Horygon. In MUSA **l'editore È il cliente**; anagrafica fiscale e ISBN si
popolano **solo dal portale** (niente inserimento a mano). Stripe = incassi +
documenti commerciali; la fattura elettronica SdI è un pezzo ancora da fare (via
Aruba).

## Modello di abbonamento (confermato con Daniele)
- Fasce sul numero di **ISBN presenti** in piattaforma, **tariffa a giorni**
  (prezzo mese ÷ giorni del mese), **fatturazione trimestrale** = somma giorni.
- Fasce seed (modificabili da UI → "Fasce"): BASIC 1–8 €4,90 · PRO 9–24 €12,90 ·
  PREMIUM 25–100 €24,90 · ENTERPRISE 101–400 €42,90 · **MUSA UNLIMITED** oltre 400
  **gratis se ≥20% approvati**, altrimenti resta ENTERPRISE finché non raggiunge il 20%.
- Salita di fascia → paga i giorni alla fascia più alta. Discesa → **credito**
  scalato dalle fatture future (mai rimborsato, senza scadenza).
- Prezzi **netti**: IVA 22% applicata da Stripe (tax rate esclusivo).
- Esempio validato: BASIC con 8 ISBN, 9° inserito il 1 marzo → trimestre
  4,90+4,90+12,90 = **22,70**.

## Architettura
**DB (`src/db/database.js`)**
- `musa_abbonamenti_fasce` — fasce (min/max ISBN, prezzo_mese, gratis, min_approvati_perc). Seed idempotente.
- `musa_editori` — editore=cliente: nome, piva, codice_fiscale, pec, email, indirizzo, codice_destinatario, iban, stripe_customer_id, external_id.
- `musa_editori_isbn` — timeline ISBN: isbn, inserito_il, rimosso_il, approvato, approvato_il, richiesta_cancellazione, visibile_editore. UNIQUE(editore_id,isbn).
- `musa_abbonamenti_trimestri`, `musa_editori_credito` — trimestri e credito.
- `musa_abbonamenti_eventi` — governance (diff ad ogni sync).
- `musa_stripe_events` — audit/idempotenza webhook Stripe.

**Service**
- `musa-abbonamenti-service.js` — MOTORE PURO: `countsOnDay`, `pickFascia` (regola gratis/fallback), `dailyRate`, `computePeriodo`, `quarterRange`; CRUD fasce; `upsertIsbn`; `calcolaTrimestre` (con credito). Portale: `fetchPortale` (fetch iniettabile), `pullDalPortale`, `syncPortale` (crea/aggiorna editori per external_id, upsert ISBN, cross-check riepiloghi, calcola e persiste **eventi**), `listEventi`.
- `stripe-client.js` — client REST Stripe senza dipendenze (fetch+crypto): form-encoding stile Stripe, verifica firma webhook, prodotti/prezzi/clienti/fatture/invoiceitems/payment_links/refunds/tax_rates.
- `musa-service.js` — dashboard, mapper in EURO, createCustomer/createInvoice (con `default_tax_rates` da ENV)/payment link/refund/pay/void, listProdotti/createProdotto.

**Route (`src/routes/musa.js`, mount `/api/musa`)** — tutte auth + permesso `musa`.
- Stato/Stripe: `GET /stato`, `GET /dashboard`, `GET|POST /prodotti`, `GET|POST /clienti`, `GET /fatture|/pagamenti`, `POST /fatture` + `/:id/invia|paga|annulla`, `POST /payment-link`, `POST /rimborsi`, `POST /iva/setup`.
- Abbonamenti/editori: `GET|POST|PUT|DELETE /abbonamenti/fasce`, `GET /editori`, `GET /editori/:id/isbn`, `GET /editori/:id/trimestre`, `GET /abbonamenti/eventi`.
- Portale: `POST /portale/pull` (scarica da ENV URL), `POST /portale/sync` (payload incollato). Entrambi inviano la **mail di notifica** se ci sono eventi.
- Webhook: `POST /api/musa/stripe/webhook` (montato in `src/index.js` PRIMA di express.json, body raw, no auth, firma verificata).

**Frontend (`public/js/app.js`, `public/index.html`)**
Gruppo menu "MUSA (Stripe)" → pagina a tab: Dashboard, Fatture, Pagamenti,
Clienti, Articoli, Editori. Tab **Editori**: selettore anno/trimestre, totale,
pulsanti Fasce / Registro / "⟳ Sincronizza dal portale" (se configurato) /
"Sync (incolla)". Per editore: Dettaglio (trimestre a giorni), Anagrafica (dati
fiscali read-only), ISBN (read-only). Niente più inserimento manuale di editori/ISBN.

## Portale MUSA
- Endpoint reale: `https://europe-west1-gsf-monitoraggio.cloudfunctions.net/exportEditori?key=danielemipiaci` (14 editori). La URL+chiave va in ENV `MUSA_PORTALE_URL` (mai nel codice).
- Payload: `{ generato_il, editori:[{ external_id, ragione_sociale, partita_iva, codice_fiscale, indirizzo, codice_destinatario, iban, email, pec, isbn:[{isbn,titolo,autore,inserito_il,rimosso_il,approvato,approvato_il,stato,richiesta_cancellazione,richiesta_cancellazione_il,visibile_editore}], riepilogo:{isbn_presenti,isbn_approvati} }] }`.
- Quirk gestiti: `email` a volte oggetto `{email,autore_dice}` → normalizzata; ISBN duplicati (Royal Books `9791280463074`) → dedup + warning; ISBN non valido (Edizioni Effetto `9788832195`, 10 cifre) → warning; `approvato_il` sempre null (ininfluente ora); 2 editori senza ragione sociale (shell vuote). Cross-check `presenti` calcolati vs `riepilogo` del portale.
- Da chiedere a MUSA: P.IVA mancante per molti (3 già presenti: Arbor, Connessioni, Panda); deduplicare gli ISBN; ISBN a 13 cifre; email come stringa.

## Governance + notifiche
Ad ogni sync: diff pre/post per editore → eventi `editore_nuovo / fascia_su /
fascia_giu / isbn_aggiunto / isbn_rimosso / richiesta_cancellazione /
piva_arrivata` in `musa_abbonamenti_eventi` (UI "Registro"). Se ci sono eventi,
mail di riepilogo via Gmail del CRM a `MUSA_NOTIFY_EMAIL` (o email dell'utente).
Scelta: notifiche **solo a Daniele, ogni cambiamento**.

## IVA 22%
Prezzi fasce netti. `POST /musa/iva/setup` crea il tax rate 22% esclusivo →
metti l'id in `MUSA_STRIPE_TAX_RATE_ID`. Le fatture nascono con quell'aliquota.

## Variabili ENV (in `.env`, passate al container via `docker-compose.yml`)
```
MUSA_STRIPE_SECRET_KEY=sk_test_...      # chiave Stripe di Musa (test per ora)
MUSA_STRIPE_WEBHOOK_SECRET=whsec_...    # per il webhook
MUSA_STRIPE_ENABLED=1
MUSA_STRIPE_TAX_RATE_ID=txr_...         # IVA 22% (da /musa/iva/setup)
MUSA_PORTALE_URL=https://.../exportEditori?key=...
MUSA_NOTIFY_EMAIL=                      # vuoto = email dell'utente
```

## FATTO
Modulo Stripe isolato · motore abbonamenti a giorni + fatturazione trimestrale
(calcolo) · fasce editabili · portale pull/sync + cross-check · editore=cliente
auto-popolato (anagrafica+ISBN read-only) · governance eventi + notifiche email ·
IVA 22% · articoli/prodotti · webhook Stripe. **~30 test in `tests/musa*.test.js`.**

## DA FARE (prossimo contesto)
1. **Fatturazione trimestrale su Stripe** con IVA + consumo/accredito del credito (il motore e la struttura ci sono; manca il "Fattura trimestre" che genera la fattura Stripe e scrive `musa_abbonamenti_trimestri` + ledger credito).
2. **Aruba Fatturazione (e-fattura SdI dopo il pagamento)** — Daniele "da capire insieme": serve sapere il prodotto/accesso API Aruba. Flusso previsto: webhook pagamento Stripe → genera FatturaPA XML (builder SdI di Horygon riusabile) → invio via API Aruba, oppure generazione XML + handoff manuale al portale Aruba. Serve P.IVA emittente di MUSA.
3. **Abbonamenti che HORYGON vende** ai propri clienti — workstream separato lato Horygon (account/chiavi Stripe proprie, catalogo ricorrente, aggancio a contabilità/SdI di Horygon).
4. **Sync notturno automatico** dal portale (cron gated da ENV, come la riconciliazione SdI giornaliera).

## Commit principali (su `codex/sdi-diagnostics`)
`0c89e22` modulo Stripe · `0f2ea49` tab editori (bozza flat) · `f9e8939` motore
abbonamenti a giorni · `9b82e53` IVA 22% · `f6c6c7e` sync portale · `ea5cbbf`
pull automatico + anagrafica arricchita · `6870a68` governance + notifiche ·
`830298a` editore=cliente (anagrafica/ISBN solo dal portale).

## Nota
Deploy VPS: `bash redeploy.sh` (pull + pulizia spazio + rebuild) poi hard refresh.
Test SdI `sdi-backfill` fallisce per una data fissa 2026-09-15 scaduta (pre-esistente, non legato a MUSA).
Vedi anche la memoria `musa-modulo-stripe.md` e `contabilita-gestionale-fasi.md`.
