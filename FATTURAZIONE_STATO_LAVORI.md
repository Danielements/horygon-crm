# Fatturazione: stato dei lavori

Ultimo aggiornamento: 2026-08-13.

Documento di lavoro sul ciclo commerciale e sulla fattura. Per il canale SdI
resta `SDI_INTEGRATION_OVERVIEW.md`; per il backfill e la firma,
`SDI_SESSION_HANDOFF.md`.

Branch `codex/sdi-diagnostics`, **258 test verdi** (`npm test`).
Ultimo commit locale `0db82d8`. **Il VPS va riallineato**: `git pull &&
docker compose up -d --build`.

## 0. Il punto in una riga

**Non e' ancora stata trasmessa nessuna fattura.** In produzione:
`fatture_sdi_flussi` e `fatture_sdi_notifiche` vuote. La fattura 6 per
l'Aeronautica ora si **genera** in XML (validata contro `Schema_VFPR12`), ma
prima della firma vanno completati i dati PA (§3.1): manca ancora il passaggio
`sdi.mode = production` e la firma qualificata.

## 1. Fatto

### 13 agosto — correzioni sul tracciato FPA12, provate su dati reali

Da una revisione dell'XML dell'Aeronautica (`IT03365990591_H0001.xml`), tutte
verificate contro `Schema_VFPR12_v1.2.3.xsd` e riproducendo la fattura vera:

| Difetto | Correzione |
|---|---|
| `PrezzoTotale` con l'IVA inclusa | e' il **netto** di riga (imponibile). I dati veri hanno `totale_riga` lordo: 439,20 = 360 x 1,22. Scattavano 00423 su ogni riga e 00422 sul riepilogo. I test usavano righe con `totale_riga` gia' netto e non lo vedevano |
| Split payment: `ImportoPagamento` lordo | sotto esigibilita' `S` la PA non versa l'IVA al fornitore: `ImportoPagamento` e' il **netto** (totale meno imposta), `ImportoTotaleDocumento` resta il lordo |
| `CapitaleSociale 0.00` | un capitale a zero e' un'informazione falsa: il campo si **omette** quando non configurato (facoltativo in IscrizioneREA). Configurare `sdi.company.share_capital` |
| scadenza inventata | senza scadenza il pagamento ripiegava sulla data fattura ("dovuto oggi"): `DataScadenzaPagamento` si **omette** quando non c'e' |
| CIG mancante su PA | **warning** (non blocco: le esclusioni esistono), mostrato come toast alla generazione. Senza CIG obbligatorio la PA non liquida |
| `IdDocumento` = codice interno CRM | e' il **numero dell'ordinativo PA** (es. "077"), non `ORD-PREV-...`. Campi nuovi `riferimento_ordine_pa` / `_data` su ordini e fatture, piu' `capitolo_spesa` e `protocollo_pa` (solo memoria interna, fuori dal tracciato). Copiati da ordine a fattura, editabili nel riquadro PA di entrambi i modali |
| ordine consegnato non fatturabile | `convert-to-fattura` accetta da `confermato` a `consegnato`; il pulsante "Crea fattura" compare sugli stessi stati (era solo `confermato`) |
| pulsante Elimina fattura muto | `onclick` generato con `JSON.stringify` (doppi apici in attributo a doppi apici): allineato agli apici singoli |
| `sdi_id` = Codice Univoco Ufficio | il campo "Identificativo SdI" conteneva `AKGVPD` e la fattura risultava trasmessa: il campo ora spiega che e' numerico e lo assegna SdI, e un valore non numerico chiede conferma |

**Ingresso del ciclo di firma aperto.** Aggiunta `POST /api/sdi/fatture/:id/genera`
(genera nella modalita' del canale, **non trasmette**) e il pulsante nel modale:
prima "Firma / Invio" compariva solo con `stato_sdi` gia' valorizzato, che si
valorizza generando — un cerchio chiuso. Tolti i pulsanti "Genera XML TEST" e
"Invia a SdI TEST".

**Dove cambiare `RiferimentoNormativo`** (es. "Scissione dei pagamenti -
art. 17-ter DPR 633/1972"): nel campo *Riferimento* della riga del **Riepilogo
IVA** della singola fattura, non nella regola globale (quella e' il riferimento
dell'aliquota, e cambierebbe tutte le fatture a quell'aliquota). E' facoltativo:
lo split e' gia' comunicato da `EsigibilitaIVA = S`.

**Accesso al CRUD IVA**: pulsante "Trattamenti IVA" nell'header Prodotti,
accanto a Categorie (prima si apriva solo da dentro un articolo).

### Modello IVA: come e' assegnata (riepilogo)

- **Default per articolo** (scheda prodotto, campo Trattamento IVA).
- **Snapshot per riga**: all'inserimento in preventivo/ordine/fattura il
  trattamento e' copiato sulla riga, e li' e' modificabile con un **dropdown**
  (codice + descrizione dal CRUD) senza toccare l'articolo.
- **Nessuna IVA globale di documento**, di proposito: la stessa fattura porta
  righe ad aliquote/nature diverse. L'unica proprieta' IVA a livello documento
  e' l'**esigibilita'** (I/D/S), che dipende dal cliente.

### Incidente del 12 agosto: sessanta mail vere da una corsa di test

`tests/iva.test.js` gira sulle rotte vere e sul database vero, che in sviluppo
e' una copia della produzione con i token Google buoni. Provare la catena
preventivo → ordine → fattura porta l'ordine a `confermato`, e quel cambio di
stato notificava via mail **tutti gli utenti attivi**.

Due rimedi, indipendenti:

- `src/services/outbound.js`: la guardia sta al **punto di uscita**, non nei
  test. Riconosce la corsa da `NODE_TEST_CONTEXT`; si disinnesca solo con
  `HORYGON_ALLOW_OUTBOUND=1`. Applicata a `sendMail` (google.js) e
  `sendPushToUserIds` (push.js). Un invio bloccato non conta come inviato e non
  marca la notifica come tentata.
- **Le notifiche interne vanno a una casella sola**,
  `notifications.internal_email`, che vale `info@horygon.com` e accetta piu'
  indirizzi separati da virgola. Non esiste piu' un valore che significhi
  "tutti": chi riceve va nominato. La notifica **in app** resta per tutti.

`notifications.recipient_mode` era seminato e mai letto da nessuno: ecco come
`all_active_users` poteva essere il comportamento senza essere una decisione.

### Gestione IVA centralizzata

`regole_iva`, tabella globale senza `tenant_id` (sono norme nazionali). Seed
idempotente da `src/iva_rules_crm_import.csv`, upsert su `codice`, mai delete.
**28 codici** presenti in produzione: IVA22/10/5/4, N1, N2.1-2.2, N3.1-3.6, N4,
N5, N6.1-6.9, N7, ESIG_I/D/S.

**Lo snapshot sta sulla riga.** Articolo → riga preventivo → riga ordine → riga
fattura: a ogni passaggio il trattamento viene *copiato*. Modificare l'IVA di un
articolo non tocca nulla di gia' emesso. `regola_iva_id` resta solo come
tracciatura della provenienza.

Motore unico in `src/services/iva.js`: centesimi interi, riepilogo raggruppato
per **aliquota, Natura ed esigibilita'** (`0% N4` e `0% N3.1` non si sommano).
CRUD `/api/regole-iva` con audit; una regola usata non si elimina.

### Numerazione, PDF, elenco

- Numerazione fiscale per anno (`src/services/fattura-numerazione.js`), con
  **unicita' cercata dentro l'anno**: la 1 del 2026 e la 1 del 2027 convivono.
- **Copia di cortesia in PDF**: `GET /api/fatture/:id/pdf-cortesia`.
- Elenco fatture: colonne Imponibile, IVA, **Totale in fondo**.
- **Badge di stato SdI** letto da flussi e notifiche, non dalla sola colonna
  `stato_sdi`: Non inviata / Da firmare / Pronta non inviata / Inviata senza
  ricevuta / Consegnata / Scartata / Accettata / Rifiutata.

### Ciclo di firma: l'ingresso era murato

Il pulsante *Firma / Invio* compariva solo con `stato_sdi` valorizzato, che si
valorizza generando l'XML, che si poteva fare solo da "Genera XML TEST".
Aggiunta `POST /api/sdi/fatture/:id/genera` (genera nella modalita' del canale,
**non trasmette**) e il pulsante nel modale. Tolti i pulsanti TEST.

### Eliminazione, nota di credito, magazzino

- `DELETE /api/fatture/:id`: solo finche' SdI non ne sa niente. Rifiuta con il
  motivo, e se `sdi_id` non e' numerico dice che probabilmente e' il Codice
  Univoco Ufficio finito nel campo sbagliato.
- `POST /api/fatture/:id/nota-credito`: TD04 con importi positivi, numero della
  serie, collegamento in `fattura_riferimento_id` → `DatiFattureCollegate`.
  Lo snapshot fiscale e' **copiato, non ricalcolato**.
- Si fattura da un ordine **da `confermato` a `consegnato`** (prima solo
  `confermato`).
- **Un ordine oltre la conferma non tocca piu' il magazzino**: modificarne il
  CIG falliva con "Giacenza insufficiente" per merce gia' uscita col DDT.
- **Il preventivo guarda la giacenza** e risponde con le righe scoperte, senza
  bloccare e senza impegnare.
- **Annullare un ordine libera la merce** che aveva impegnato.

### Difetti trovati e chiusi

| Difetto | Come si manifestava |
|---|---|
| `convert-to-fattura` rotta | `SELECT p.aliquota_iva FROM prodotti`: colonna inesistente, la rotta falliva sempre |
| `ordini_righe` senza dati fiscali | nemmeno gli importi; l'IVA della fattura veniva riletta dall'articolo |
| preventivo → ordine perdeva IVA e descrizione | |
| imposta del riepilogo | sommava imposte di riga arrotondate: 300 righe da 0,10 al 22% davano 6,00 invece di 6,60, contro il controllo **00421** |
| PA riconosciuta solo da `tipo` | una scheda creata da *Clienti* ha `tipo='cliente'`: l'Aeronautica avrebbe avuto una FPR12 |
| apostrofo tipografico | `Via dell’Aeroporto` **rifiutato dall'XSD** (i tipi Latin arrivano a U+00FF) |
| service worker | `app.js` cache-first sulla stessa URL `?v=`: markup nuovo e script vecchio |
| numerazione | la fattura da ordine prendeva il codice ordine troncato |
| PDF | colonne oltre il bordo, tabella sull'intestazione a pagina 2, riquadro Riferimenti che sborda |
| modifica fattura | azzerava `ordine_id` (non e' un campo del modale) |
| pulsante Elimina fattura muto | `onclick` generato con `JSON.stringify` (virgolette doppie dentro un attributo a doppie): l'HTML si spezzava. Allineato agli apici singoli col apostrofo protetto, come il resto del file |
| ordine annullato | teneva la merce impegnata per sempre |

### Cosa NON era rotto (verificato, non ripetere)

- **Il passaggio ordine → DDT.** `convert-to-ddt` cancella i movimenti
  dell'ordine e crea quelli del DDT: la merce esce **una volta sola**. Un DDT
  creato a mano scarica per conto suo.
- **Non ci sono giacenze negative.** La query con cui le avevo cercate
  escludeva i movimenti di `rettifica`. Tutti e tre i moduli che calcolano la
  giacenza li contano.

## 2. Come si verifica il PDF

Il disegno e' separato dalla lettura: `renderFatturaPdf({row, righe,
riepilogo})` si chiama su dati finti senza toccare il database. Due test in
`tests/iva.test.js` intercettano ogni `doc.text` e controllano che niente
superi il margine destro, scenda sotto il piede o cominci dentro
l'intestazione. Per **vedere** l'impaginazione c'e' la mappa a caratteri in
`scratchpad/mappa.js`: e' cosi' che e' saltato fuori il riquadro Riferimenti
che sbordava, mentre i controlli numerici passavano.

## 3. Aperto

### 3.1 La fattura PA all'Aeronautica — dati da completare

Il tracciato ora e' corretto (validato contro `Schema_VFPR12`). Restano i **dati
reali** da inserire, tutti dal foglio d'ordine della PA:

```text
CIG                      BC733E0240
N. ordinativo PA         077              -> DatiOrdineAcquisto/IdDocumento
Data ordinativo PA       2026-07-20       -> DatiOrdineAcquisto/Data
Capitolo di spesa        4516/02          (solo interno)
Protocollo PA            M_D ALT001 REG2026 0006592   (solo interno)
Codice Univoco Ufficio   AKGVPD
Pagamento                60 giorni
Split payment            si
```

Da fare nel modale ordine/fattura (sezione PA) prima di rigenerare:

1. **CIG e N. ordinativo PA sull'ordine** (o sulla fattura): con i campi nuovi
   il CIG non si perde piu' alla conversione, e `IdDocumento` prende `077`, non
   il codice interno.
2. **Togliere "escludi split payment"** sull'anagrafica → esigibilita' `S`,
   `ImportoPagamento` netto 2089,46.
3. **Scadenza a 60 giorni** sulla fattura.
4. Se serve, `RiferimentoNormativo` split nel campo Riferimento del Riepilogo
   IVA (vedi §1).

Attenzione: `sdi_id` conteneva `AKGVPD` (Codice Univoco Ufficio nel campo
sbagliato): finche' resta, la fattura risulta trasmessa e non si elimina. Se si
ricrea da zero il problema non si ripresenta.

Poi: *Firma / Invio → Genera XML → **fermarsi a guardarlo*** (atteso:
`IdDocumento 077`, `Data 2026-07-20`, `EsigibilitaIVA S`, `ImportoPagamento
2089.46`, CIG nel blocco, nessun `CapitaleSociale`) → `sdi.mode = production`
(**decisione del proprietario**) → **rigenerare** (il flusso test non e'
trasmissibile in produzione) → firma con FirmaOK → ricarica il `.p7m` → invia
con conferma.

La numerazione fiscale genera `6` (5 fatture emesse da inizio attivita').
`sdi.mode` e' `test`: per questo canale un ambiente di prova non esiste piu'.

### 3.2 Campi di testata e piede della fattura

Il riferimento e' la maschera del gestionale del commercialista. Manca il
**piede**:

| Blocco | Blocco FatturaPA | Nota |
|---|---|---|
| Pagamento (modalita' MP01-23, condizioni TP01-03, IBAN, rate) | `DatiPagamento` | esce dalle impostazioni globali `sdi.payment.*` piu' la scadenza della fattura; l'importo e' gia' corretto sotto split. **Non ancora modificabile per fattura** (modalita', IBAN, rate): primo da fare |
| Trasporto (vettore, incoterms, colli, peso, aspetto beni, data/ora) | `DatiTrasporto` | manca |
| Causale | `Causale` | il builder lo rende gia', va solo alimentato |
| Bollo | `DatiBollo` | manca |
| Spese accessorie, arrotondamento | in `DatiRiepilogo` | manca |
| Allegati | `Allegati` | manca |
| Riferimenti DDT | `DatiDDT` | manca |

Ordine degli elementi vincolante: `DatiBollo` sta in `DatiGeneraliDocumento`
dopo `DatiRitenuta`; `DatiTrasporto` in `DatiGenerali` dopo `DatiDDT`. Da
verificare contro `Schema_VFPR12_v1.2.3.xsd`, non contro le tabelle del PDF.

### 3.3 Visibilita' degli ordini — decisione del proprietario

`GET /api/ordini` restituisce tutto a chiunque abbia `ordini.read`. Il
proprietario vuole che il superadmin veda tutto e gli altri solo il proprio.

Fatti verificati in produzione: **5 utenti attivi su 7 sono `ruolo_id 4`**, e
`requirePermesso` esce subito su quel ruolo — qualunque regola non filtra nulla
per 5 persone su 7. Questo viene **prima** della scelta sullo schema. I dati
sono minuscoli (3 ordini, 5 preventivi, 23 anagrafiche): non e' un problema di
paginazione. Tutti gli ordini e i preventivi hanno `created_by_user_id` NULL,
ma la POST lo scrive gia': da qui in avanti il dato esiste.

**Domanda aperta:** «di mia competenza» significa *l'ordine che ho inserito io*
oppure *il cliente assegnato a me*? Nella seconda lettura serve
`anagrafiche.owner_user_id`. Il tenant vero (`tenant_id` su utenti e ordini) e'
sconsigliato: oggi i tenant esistono solo per le fatture SdI.

Si puo' partire senza decidere: filtri lato server su `GET /api/ordini` (stato,
tipo, anagrafica, date, ricerca) e i controlli sulla pagina, che non ha filtri.

### 3.4 Altro

- **La guardia sugli invii non copre** WhatsApp/Telegram (`src/routes/parts.js`)
  e la trasmissione SdI. Prima di metterla sul percorso SdI, leggere come sono
  fatti `tests/sdi*.test.js`: alcuni si chiamano "produzione".
- **L'ordine nato da preventivo non impegna la merce** (`convert-to-order` non
  crea movimenti), mentre uno creato a mano si'. Due ordini identici prenotano
  o no a seconda di come sono nati. Allinearli e' una riga, ma cambia il
  significato: **decisione del proprietario**.
- Gli esiti committente sulle fatture ricevute usano ancora
  `esito-committente-test`, e la conferma lo dice.
- Il **DDT 3** ha `ordine_id` nullo pur venendo dall'ordine 3.
- Le 34 fatture dello storico non sono agganciate a un'anagrafica.
- Utente fittizio `tmp-route-...@example.com` ancora attivo nel DB locale.
- `src/{db,routes,services,middleware}`: cartella nata da una brace expansion
  sbagliata, dentro solo `desktop.ini`.

## 4. Regole imparate, da non ripetere

- **Validare contro lo schema, non a occhio.** Gli XSD impongono l'ordine degli
  elementi, e una prova costa nulla mentre una firma qualificata persa no.
- **Il PDF si misura, non si guarda.** I controlli numerici passavano mentre il
  testo stava fuori dal suo riquadro.
- **Ogni rilascio che tocca il frontend cambia il nome della cache** in
  `service-worker.js`. Ora `/js/` e `/css/` sono network-first.
- **Ogni scrittura da `docker compose exec` finisce con**
  `PRAGMA wal_checkpoint(TRUNCATE)` nello stesso processo.
- **Non si inventa un'aliquota.** Dove il dato non c'e', il campo resta vuoto.
- **Le letture in produzione si fanno con** `new DatabaseSync(path, { readOnly:
  true })`, e non si scrive senza chiedere.
- **`npm test` non e' innocuo per definizione**: gira sul database vero. Oggi la
  guardia lo rende sicuro, ma non lanciarlo mai sul VPS.
