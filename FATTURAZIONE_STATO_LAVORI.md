# Fatturazione: stato dei lavori

Ultimo aggiornamento: 2026-08-12.

Documento di lavoro sul ciclo commerciale e sulla fattura. Per il canale SdI
resta `SDI_INTEGRATION_OVERVIEW.md`; per il backfill e la firma,
`SDI_SESSION_HANDOFF.md`.

Branch `codex/sdi-diagnostics`. **229 test verdi** (`npm test`).

## 1. Fatto e verificato

### Gestione IVA centralizzata

`regole_iva`, tabella globale senza `tenant_id`: sono norme nazionali, e
duplicarle per tenant significa vederle divergere. Seed idempotente da
`src/iva_rules_crm_import.csv`, upsert su `codice`, mai delete. 28 codici:
IVA22/10/5/4, N1, N2.1-2.2, N3.1-3.6, N4, N5, N6.1-6.9, N7, ESIG_I/D/S.

**Lo snapshot sta sulla riga.** Articolo → riga preventivo → riga ordine →
riga fattura: a ogni passaggio il trattamento viene *copiato*, non riletto.
Modificare l'IVA di un articolo non tocca nulla di gia' emesso.
`regola_iva_id` resta solo come tracciatura della provenienza.

Motore unico in `src/services/iva.js`: `calcolaRiga`,
`calcolaTotaliDocumento`, `buildSnapshotIva`. Conta in centesimi interi.
Raggruppa il riepilogo per **aliquota, Natura ed esigibilita'**: `0% N4` e
`0% N3.1` sono operazioni diverse e non si sommano.

CRUD `/api/regole-iva` con filtri, `?selezionabili=true` per le tendine,
audit con prima/dopo per campo. Una regola usata non si elimina (409 con il
conteggio degli utilizzi); cambiarne aliquota o Natura chiede conferma
esplicita. Scrittura su permesso `settings`, lettura a chiunque sia
autenticato: un commerciale deve poter scegliere il trattamento su una riga.

Interfaccia: tendina IVA su ogni riga di preventivo, ordine e fattura, con
codice e descrizione; modale **Trattamenti IVA** dal pulsante *Gestisci*
accanto al campo dell'articolo; trattamento predefinito sull'anagrafica
articolo.

### Difetti trovati e chiusi

| Difetto | Come si manifestava |
|---|---|
| `convert-to-fattura` rotta | `SELECT p.aliquota_iva FROM prodotti` — colonna inesistente. Il pulsante "Crea fattura" da ordine falliva sempre, anche in produzione |
| `ordini_righe` senza dati fiscali | nemmeno gli importi. L'IVA della fattura veniva riletta dall'articolo al momento della conversione |
| preventivo → ordine perdeva l'IVA | e con essa la descrizione della riga |
| imposta del riepilogo | sommava le imposte di riga gia' arrotondate: 300 righe da 0,10 al 22% davano 6,00 invece di 6,60, contro il controllo SdI **00421** (tolleranza un centesimo) |
| PA riconosciuta solo da `tipo` | una scheda creata da *Clienti* ha `tipo = 'cliente'` e la PA in `tipologia_cliente`: l'Aeronautica avrebbe ricevuto una FPR12 |
| apostrofo tipografico | `Via dell'Aeroporto` con `’` viene **rifiutato dall'XSD** (i tipi Latin ammettono solo fino a U+00FF). Verificato contro `Schema_VFPR12_v1.2.3.xsd` |
| service worker | `index.html` network-first e `app.js` cache-first sulla stessa URL `?v=`: markup nuovo e script vecchio, e il picker del cliente non si apriva |
| numerazione fattura | la fattura da ordine prendeva il codice dell'ordine troncato: `FAT-2026-RD-PREV-20260625-354` |

### Numerazione fiscale

`src/services/fattura-numerazione.js`. Progressivo per anno, letto dal massimo
della serie esistente, **unicita' cercata dentro l'anno**: la numerazione
riparte a ogni esercizio, quindi la 1 del 2026 e la 1 del 2027 convivono.
Formato configurabile con `fatture.numerazione.formato` (`{numero}`, `{anno}`);
il default e' il solo numero, come le fatture gia' a sistema (1-5 nel 2026).

`GET /api/fatture/numerazione/prossimo` restituisce il prossimo libero.

### Copia di cortesia in PDF

`GET /api/fatture/:id/pdf-cortesia`, pulsante **PDF** sulla riga della fattura.
Porta intestazioni cedente/cessionario nel verso giusto a seconda che la
fattura sia emessa o ricevuta, righe con imponibile e trattamento (Natura al
posto della percentuale dove serve), **riepilogo IVA per trattamento**, totali
e i riferimenti (ordine, CIG, CUP). In fondo dichiara che il documento fiscale
resta l'XML.

### Elenco fatture

Colonne riordinate in ordine di lettura: Imponibile, IVA, **Totale in fondo**,
in grassetto. L'intestazione veniva completata a runtime e non corrispondeva
piu' alle celle.

### Iter completo, provato sulle rotte vere

Preventivo (IVA 10% sulla riga) → Ordine (IVA e descrizione conservate) →
Fattura (riepilogo `10%: imp 200 imposta 20`, testata 200/20/220) → DDT.
Piu' la fattura creata da zero con cliente scelto dal picker.

### Migrazione dello storico

Riempie solo cio' che e' vuoto, **non riscrive nessun importo**. Le righe
ordine prendono l'aliquota dalla testata quando l'ordine e' a aliquota unica,
e restano vuote quando il rapporto darebbe una media che non appartiene a
nessuna riga. Gli ordini che non quadrano finiscono in `system_log`.

Esito in produzione: **0 ordini fuori quadratura**, 1 riga senza aliquota
deducibile (ordine 1 MUSA TECH, vedi sotto). L'ordine 3 AERONAUTICA ha preso
22% su tutte e 13 le righe, e la somma torna al centesimo con la testata
(2089,46 / 459,68).

## 2. Aperto, in ordine di urgenza

### 2.1 Campi di testata e piede della fattura — DA FARE

E' la richiesta aperta piu' grossa, e il riferimento e' la maschera del
gestionale del commercialista. Manca tutto il **piede**:

| Blocco | Campi | Blocco FatturaPA |
|---|---|---|
| Pagamento | modalita' (MP01-MP23), condizioni (TP01-TP03), IBAN, istituto, rate | `DatiPagamento` / `DettaglioPagamento` |
| Trasporto | vettore, incoterms, colli, peso, aspetto esteriore beni, data e ora inizio trasporto, indirizzo di resa | `DatiTrasporto` |
| Causale | testo libero | `Causale` (il builder lo rende gia', va solo alimentato) |
| Bollo | virtuale, importo | `DatiBollo` |
| Spese accessorie | spese, arrotondamento | `SpeseAccessorie`, `Arrotondamento` in `DatiRiepilogo` |
| Allegati | file allegato al documento | `Allegati` |
| Riferimenti DDT | numero e data DDT | `DatiDDT` |

Oggi `DatiPagamento` esce dalle sole impostazioni globali `sdi.payment.*` piu'
la scadenza della fattura: **non e' modificabile per singola fattura**, ed e'
il primo pezzo da fare.

Attenzione all'ordine degli elementi, che negli XSD e' vincolante:
`DatiBollo` sta in `DatiGeneraliDocumento` dopo `DatiRitenuta`;
`DatiTrasporto` sta in `DatiGenerali` dopo `DatiDDT`. Da verificare contro
`Schema_VFPR12_v1.2.3.xsd` prima di scrivere, non contro la tabella del PDF.

Data di emissione e note esistono gia' e sono editabili (`Data documento` e
`Note` sul modale fattura).

### 2.2 Fattura PA all'Aeronautica — bloccata sui dati

Ordine 3, `confermato`, 13 righe, 2549,14 EUR, nessuna fattura collegata.

Tre cose da sistemare prima di generarla:

1. **Confermare di che ufficio si tratta.** La scheda a sistema e'
   "AERONAUTICA MILITARE" (id 9), il piano parla del **70 STORMO**. Il codice
   univoco ufficio e' per ufficio, non per ente.
2. **Anagrafica incompleta**: `piva` e `cf` entrambi nulli, nessun record in
   `pa_dettagli`, niente PEC. Servono CF `80007090592`, ufficio `AKGVPD`, PEC
   `aerostormo70@postacert.difesa.it` — da confermare col punto 1.
3. **CIG mancante sull'ordine.** Senza, l'XML e' valido e SdI lo accetta, ma
   la PA non liquida.

Poi: genera XML → **fermarsi e guardarlo** (formato FPA12, codice
destinatario, `DatiOrdineAcquisto` con il CIG, `EsigibilitaIVA = S`) → scarica
→ firma con FirmaOK → ricarica il `.p7m` → invia.

`sdi.mode` e' `test`, ma per questo canale un ambiente di prova non esiste
piu': o l'invio non prova niente, o e' gia' un documento fiscale.

### 2.3 Riga ordine senza aliquota

Ordine 1 MUSA TECH, riga "CCIT tablet", 8 x 75 = 600. La testata ha
`imponibile = 0` e `iva = 0` ma `totale = 732`, e 732/600 = 1,22: era al 22%.
La migrazione non lo deduce perche' guarda `imponibile` e `iva`. Da
completare a mano dopo conferma.

### 2.4 Minori

- La fattura `FAT-2026-RD-PREV-20260625-354` creata in produzione prima della
  correzione va rinumerata o eliminata: non appartiene a nessuna serie.
- Le 34 fatture dello storico non sono agganciate a un'anagrafica: la
  controparte vive solo in `cliente_fornitore_label`.
- In `cliente_fornitore_label` restano entita' XML non decodificate (`&amp;`).
- `src/{db,routes,services,middleware}` e' una cartella nata da una brace
  expansion sbagliata: dentro c'e' solo `desktop.ini`.

## 3. Regole imparate, da non ripetere

- **Validare contro lo schema, non a occhio.** Gli XSD impongono l'ordine
  degli elementi, e una prova costa nulla mentre una firma qualificata persa
  non si recupera.
- **Ogni rilascio che tocca il frontend cambia il nome della cache** in
  `service-worker.js`. Ora `/js/` e `/css/` sono network-first, quindi la
  trappola e' disinnescata, ma la regola resta.
- **Ogni scrittura da `docker compose exec` finisce con**
  `PRAGMA wal_checkpoint(TRUNCATE)` nello stesso processo.
- **Non si inventa un'aliquota.** Dove il dato non c'e', il campo resta vuoto
  e lo si vede: meglio una riga da completare che un 22% messo d'ufficio.
