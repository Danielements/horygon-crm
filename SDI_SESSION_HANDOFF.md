# Passaggio di consegne — integrazione SdI

Ultimo aggiornamento: 2026-08-09, fine sessione.

Questo file serve a riprendere il lavoro in una sessione nuova senza rileggere
tutto. Il riferimento completo resta `SDI_INTEGRATION_OVERVIEW.md`: qui c'e' solo
cio' che non e' deducibile dal repository.

## Da leggere per primi

1. `SDI_INTEGRATION_OVERVIEW.md` — stato reale, blocchi, sequenza di go-live,
   trappole dell'ambiente (§8). E' la fonte di verita'.
2. Questo file, per lo stato del deploy e i lavori aperti.

## Stato del codice

Branch `codex/sdi-diagnostics`. **198 test, tutti verdi** (`npm test`).

Fatto il 09.08.2026, seconda parte: **backfill dello storico dai Servizi
Massivi**. Nuovi `sdi-massive-esito.js` (lettura del file di esito, dove stanno
gli `IdFile`) e `sdi-backfill.js` (orchestratore), ramo di firma esterna in
`sdi-massive-request.js`, rotte in `src/routes/sdi-storico.js`, script
`scripts/sdi-fiscal-config.js`.

Il censimento del canale per le forniture massive **e' attivo**: provider
HORYGON S.R.L., `03365990591`, WebService, Scarico Fatture.

**Il 10.08.2026 la prima richiesta massiva reale e' stata accettata**:
`inoltroRichiesta` sul job 1 (passive, 01.03-31.05) ha restituito
`IdRichiesta 359870495`. Quindi sono confermati sul campo, oltre alle fixture:
mTLS verso `servizi.fatturapa.it`, la SOAPAction come stringa nuda, l'involucro
`RichiestaServiziMassivi` e la firma CAdES di FirmaOK.

## Stato del backfill all'11.08.2026, sera

**Il ciclo SMTS funziona end-to-end contro il servizio reale.** Due job passive
inoltrati, elaborati, archivi scaricati e import simulato:

| Job | Periodo | IdRichiesta | Archivio | Documenti |
|---|---|---|---|---|
| 1 | 01.03-31.05 | `360566686` | `360566686_FATT_03365990591.zip` | 10 fatture |
| 2 | 01.06-10.08 | `360612883` | `360612883_FATT_03365990591.zip` | 19 fatture |

Entrambi in `IMPORTING` con `dry_run = 1`: **niente e' ancora stato scritto**.
Archivi disponibili fino al **10.09.2026**.

Mancano le due finestre delle **attive** (`OUTGOING`), da pianificare.

### Risolto l'11.08.2026, dopo il primo dry-run

Il dry-run ha trovato due difetti prima che si scrivesse qualcosa. Entrambi
diagnosticati sui file veri, non per ipotesi, ed entrambi coperti da fixture in
`tests/fixtures/smts/`.

**Il file di metadati e' una lista nome/valore**, namespace
`urn:xml.fatturazione.sogei.it`: `idfile` e' il contenuto di un `<nome>`, non un
tag. Cercare un elemento `<idfile>` non trovava niente, e ogni metadato veniva
lavorato come documento. Porta molto piu' del previsto: `nomefile` della fattura
a cui appartiene (abbinamento esplicito, non dedotto), `hashfile`, e cedente e
cessionario **dichiarati da SdI**, che sono un riscontro indipendente sulla
controparte.

**Alcuni `.p7m` sono in base-64**, non in DER binario: erano i tre che finivano
`STORED_NON_XML`. Nello stesso ZIP convivono le due forme. L'originale
conservato resta il file come e' arrivato, base-64 compreso, perche' e' quello
su cui SdI ha calcolato l'hash nei metadati.

### Cosa resta prima dell'import vero

1. Rilanciare il **dry-run** dopo il deploy: `metadati` non deve piu' essere 0,
   i tre `STORED_NON_XML` devono sparire, e ogni riga deve mostrare direzione e
   controparte.
2. Verificare le **controparti**: su queste passive devono essere i fornitori,
   e ora si possono confrontare con `cedentedenominazione` dei metadati.
3. Solo allora `importa` con `{"dryRun": false}`.

### Lezioni pagate care, in questa sessione

Quattro errori, tutti con la stessa radice: **letterali e strutture copiati
dalle tabelle del PDF senza mai vederli in una risposta reale**, con test
scritti sulla stessa lettura, quindi verdi mentre il documento era sbagliato.

- involucro `RichiestaServiziMassivi` mancante -> `00200`, una firma persa;
- namespace di default sull'involucro, che invece e' `unqualified` -> `00200`,
  seconda firma persa;
- `TipoElementi` confrontato con `Fatt` mentre arriva `FATT` -> l'unico archivio
  prodotto scartato in silenzio;
- allegati MTOM non gestiti -> esito vuoto senza errore.

Da qui: validazione XSD prima della firma, e la prima risposta reale salvata in
`tests/fixtures/smts/`.

Fatto il 09.08.2026: **interfaccia del ciclo di firma esterna** (punto 1 dei
lavori aperti). Badge di stato SdI sulla riga della fattura, pulsante
**Firma / Invio**, scarico dell'XML, caricamento del `.p7m`, esito della verifica
con firmatario ed emittente, invio.

Nel farla e' emerso un problema strutturale che rendeva il ciclo inutilizzabile:
`transmitInvoiceToSdi` rigenera **sempre** l'XML, quindi con firma esterna ogni
invio creava un flusso nuovo in `firma_richiesta`, consumava un progressivo e
non trasmetteva mai il file firmato. Risolto con
`POST /api/sdi/flussi/:id/invia`, che trasmette un flusso gia' generato senza
rigenerarlo, con gli stessi guardrail di produzione dell'altra rotta.

Moduli SdI aggiunti nella sessione precedente:

| File | |
|---|---|
| `sdi-cades.js` | encoder CAdES-BES e lettore CMS, in JS puro, senza shell su openssl |
| `sdi-signature.js` | politiche di firma: `disabled`, `local`, `external` |
| `sdi-firma-esterna.js` | ciclo scarica, firma fuori, ricarica, verifica |
| `sdi-fiscal-checks.js` | pre-controlli SdI con le tolleranze dell'Elenco 2.0 |
| `sdi-progressivo.js` | sequenza persistente dei progressivi |
| `safe-zip-reader.js` | lettura ZIP difensiva su yauzl |
| `sdi-massive-client.js` | adapter `sm-scarico-file` |
| `sdi-massive-request.js` | richiesta SMTS conforme a `InputMassivo_v1.5.xsd` |
| `sdi-massive-transport.js` | trasporto mTLS per SMTS |
| `sdi-historical-sync.js` | finestre temporali e ciclo di vita dei job |
| `sdi-import-pipeline.js` | import documentale con deduplicazione a 5 livelli |
| `sdi-document-classifier.js` | tipo, direzione, P7M, lotti |

Contratti ufficiali versionati in `resources/sdi/smts/`, scaricati da
fatturapa.gov.it. Undici messaggi SdI reali come fixture in
`tests/fixtures/sdi-messaggi/`: hanno trovato bug che i test sintetici non
vedevano, quindi **vanno usati come riferimento quando si tocca il parsing**.

## Stato del deploy

**Il VPS e' fermo al commit `11ebf49`.** Manca tutto il ciclo di firma esterna,
backend e interfaccia:

```bash
cd /opt/horygon-crm && git pull && docker compose up -d --build
```

Gia' attivo sul VPS: canale in produzione, Servizi Massivi abilitati, mTLS su
entrambi gli strati (`ssl_verify_client on` piu' `client_cert_policy = enforce`),
porta del container su `127.0.0.1:8443`, indice univoco sui nomi file.

`sdi.mode` e' ancora `test`: nessun invio reale e' possibile finche' non viene
cambiato di proposito.

## Scarico dello storico marzo-oggi

Il censimento provider e' fatto. Resta la configurazione fiscale del tenant,
che oggi **non esiste** e senza la quale ogni job si ferma alla prima chiamata:
e' l'unico passo di preparazione rimasto.

```bash
docker compose exec horygon-crm node scripts/sdi-fiscal-config.js --set --piva=03365990591 --cf=03365990591 --massivi --provider --confirm
```

Lo script gira in dry-run senza `--confirm` e chiude con
`PRAGMA wal_checkpoint(TRUNCATE)`, quindi la scrittura sopravvive al rebuild.
Poi `sdi.massive.signature.mode = external`.

Il periodo si copre con **due finestre da tre mesi per direzione**: il tracciato
non ne ammette di piu' larghe (controllo 00201), e finestre mensili
moltiplicherebbero per tre le firme da fare a mano.

| Direzione | Finestre | Firme |
|---|---|---|
| `INCOMING` (ricevute, per data di ricezione) | 01.03-31.05, 01.06-oggi | 2 |
| `OUTGOING` (emesse, per data di emissione) | 01.03-31.05, 01.06-oggi | 2 |

Quattro firme qualificate in tutto. `AVAILABLE_TO_RECIPIENT` **non va incluso**
senza deciderlo: scaricare fatture messe a disposizione vale come presa visione
fiscale, e la rotta lo rifiuta senza una conferma esplicita.

**Azzerare i dati di test prima di importare**, non dopo: `reset-sdi-invoice-data.js`
cancella tutte le fatture, e importando per primi la deduplicazione
arricchirebbe le righe di test invece di inserire quelle vere. Mai
`--reset-progressivo`: quei nomi file sono gia' arrivati a SdI.

Si fa tutto dalla sezione **Storico SdI**, sotto Contabilita: pianificazione,
stato dei job, e per ogni riga il passo successivo. Le rotte restano
disponibili per chi preferisce la riga di comando.

L'unico passo che richiede una persona e' la **firma della richiesta**: scarica,
firma con FirmaOK, ricarica il `.p7m`. Tutto il resto - inoltro, esito, scarico,
import - lo fa il pilota automatico, che si accende con `sdi.massive.auto = 1`
e gira ogni `sdi.massive.auto.interval_minutes` (15 di default). Il pulsante
**Avanza ora** fa la stessa passata subito.

Il pilota non tocca mai: la firma, le fatture messe a disposizione (presa
visione fiscale) e la finestra di manutenzione 00:00-00:59 italiana. Le dieci
interrogazioni di esito le spalma con un intervallo minimo di 30 minuti
(`sdi.massive.esito.min_interval_minutes`).

Scarico e import sono separati apposta: il download costa una firma e scade, il
parsing no. Se il parser migliora, `riprocessa` rilegge gli archivi gia' in
casa — cancella le fatture prodotte da quel job e rimette gli archivi in coda,
senza richiedere nulla a SdI. Le fatture non storiche non vengono toccate.

Se una passata si interrompe, il job resta `PARTIAL` e si riprende richiamando
`importa` o `scarica`: gli archivi gia' lavorati non vengono ritoccati. Se
invece e' passata `DataFineDisponibilita` il job va in `EXPIRED` e non c'e'
niente da riprovare: serve una richiesta nuova, con una firma nuova.

Da sapere prima di leggere i risultati: le fatture in **reverse charge sono
escluse** da tutte le operazioni di download e non arriveranno mai. Un buco li'
non e' un errore del backfill.

## Lavori aperti, in ordine

1. **Chiudere i tre `.p7m` illeggibili e il tracciato dei metadati**, poi
   lanciare l'import vero sui job 1 e 2 (vedi "Stato del backfill").
2. Pianificare, firmare e importare le due finestre delle **attive**.
3. Import automatico delle passive firmate `.p7m` dal canale realtime: oggi
   vengono archiviate ma non importate, e il CRM risponde comunque `ER01`.
4. Client di quadratura e reinoltro: **bloccato**, mancano tre WSDL da recuperare
   dal Sistema di Accreditamento
   (`SdIQuadraturaWSFlussoRicezioneReport_v1.0.wsdl`,
   `SdIQuadraturaWSFlussoTrasmissioneReport_v1.0.wsdl`,
   `SdIQuadraturaWSFlussoTrasmissioneReinoltro_v1.0.wsdl`).
5. `ScaricoRichiesteEsito_v1.0.xsd`, non pubblicato insieme agli altri contratti
   SMTS: il parser dell'esito segue la tabella della specifica, avere lo schema
   permetterebbe di validarlo.
6. Rate limiter globale su `/api` (`src/index.js`): copre anche il callback SdI,
   300 richieste al minuto per IP. Da escludere o alzare prima di volumi reali.

## Cose che non vanno rifatte

Sono gia' fatte e verificate, non ripartire da zero:

- separazione fra numero fiscale e `ProgressivoInvio`, con sequenza persistente;
- `sdi.production_send_policy` con conferma esplicita;
- XML immutabile con SHA-256 e registro degli schemi;
- lettura del campo `Errore` nella risposta `RiceviFile`;
- deduplicazione dell'import e guardrail contro il reinvio dello storico.

## Trappole verificate sul campo

Sono tutte in `SDI_INTEGRATION_OVERVIEW.md` §8. Le due che costano di piu':

**Scritture da `docker compose exec`**: vanno chiuse con
`db.exec('PRAGMA wal_checkpoint(TRUNCATE)')` nello stesso processo, altrimenti
sopravvivono al `restart` ma spariscono al `up --build`. Il comando riporta
successo e il dato svanisce ore dopo.

**Configurazioni nginx**: scrivere con heredoc, mai con l'editor. Un edit con
joe ha svuotato tre vhost. E i backup `~` dentro `sites-enabled` vengono
caricati da nginx come configurazione.

## Ambiente

VPS `/opt/horygon-crm`, container Docker `horygon-crm`, nginx con vhost
`sdi.horygon.it` (canale accreditato) e `crm.horygon.it` (applicazione, con
`/api/sdi/ws/` chiuso a 403). Certificati in `/root/sdi-certs`, montati su
`/run/sdi-certs`. Database SQLite `horygon.db`: contiene 168.818 righe MEPA, non
va mai azzerato in blocco — per i soli dati fattura c'e'
`scripts/reset-sdi-invoice-data.js`, con dry-run di default.

## File non tracciati, di proposito

`CRM_FEATURES.md`, `DemoFatturazione/`, piu' le modifiche non committate a
`CODING_BASICS.md` e `SDI_INTEROPERABILITY_STATUS.md`, che sono lavoro
precedente non mio.

`.claude/launch.json` e' stato creato per avviare l'app in locale durante la
verifica dell'interfaccia: e' comodita' di sviluppo, non serve al deploy.
