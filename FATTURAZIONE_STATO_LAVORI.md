# Fatturazione: stato dei lavori

Ultimo aggiornamento: 2026-08-12, sera.

Documento di lavoro sul ciclo commerciale e sulla fattura. Per il canale SdI
resta `SDI_INTEGRATION_OVERVIEW.md`; per il backfill e la firma,
`SDI_SESSION_HANDOFF.md`.

Branch `codex/sdi-diagnostics`, **248 test verdi** (`npm test`).
Locale e VPS sono allineati a `7f0e65d`: non c'e' niente da deployare.

## 0. Il punto in una riga

**Non e' ancora stata trasmessa nessuna fattura.** In produzione:
`fatture_sdi_flussi` e' vuota, `fatture_sdi_notifiche` e' vuota. La fattura 6
per l'Aeronautica esiste ma non e' mai stata generata in XML, e tre dati
mancanti la bloccano (§3.1).

## 1. Fatto in questa sessione

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

### 3.1 La fattura PA all'Aeronautica — tre dati la bloccano

Stato in produzione, letto il 12.08 sera:

```text
fattura 6   : sdi_id='AKGVPD'  ordine_id=NULL  cig='BC733E0240'  totale 2549.14
ordine 3    : ORD-PREV-20260625-354  stato=consegnato  cig=NULL
anagrafica 9: AERONAUTICA MILITARE 70° STORMO  tipo=cliente  tipologia_cliente=pa
              cf=80007090592  codice_destinatario=AKGVPD  escludi_split_payment=1
```

1. **`sdi_id` contiene `AKGVPD`**, il Codice Univoco Ufficio finito nel campo
   Identificativo SdI. Finche' resta, la fattura risulta trasmessa e non si
   elimina. Va svuotato dalla scheda fattura.
2. **`escludi_split_payment = 1`** → l'esigibilita' esce `I`, non `S`. Per
   un'amministrazione dello Stato la scissione di norma si applica. **Decisione
   del proprietario**, non toccare da soli.
3. **L'ordine 3 non ha CIG** (sta sulla fattura). Se si cancella e si ricrea la
   fattura dall'ordine, il CIG si perde: va messo prima sull'ordine.

Nota: `ORD-PREV-20260625-354` e' di **21 caratteri**, `IdDocumento` ne ammette
20. Verra' troncato. Se quel riferimento serve alla PA, accorciare il codice.

Sequenza concordata: svuota `sdi_id` → metti il CIG sull'ordine → elimina la
fattura 6 → *Crea fattura* dall'ordine 3 → *Firma / Invio* → **Genera XML e
fermarsi a guardarlo** → firma con FirmaOK → ricarica il `.p7m` → invia.

`sdi.mode` e' `test`, ma per questo canale un ambiente di prova non esiste
piu': o l'invio non prova niente, o e' gia' un documento fiscale.

### 3.2 Campi di testata e piede della fattura

Il riferimento e' la maschera del gestionale del commercialista. Manca il
**piede**:

| Blocco | Blocco FatturaPA | Nota |
|---|---|---|
| Pagamento (modalita' MP01-23, condizioni TP01-03, IBAN, rate) | `DatiPagamento` | oggi esce dalle sole impostazioni globali `sdi.payment.*`: **non modificabile per fattura**. E' il primo da fare |
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
