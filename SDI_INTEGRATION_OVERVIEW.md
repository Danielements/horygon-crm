# Integrazione SdI nel CRM HORYGON

Ultimo aggiornamento: 2026-08-09

Questo documento e' il riferimento operativo per il passaggio in produzione del
canale SdI. Descrive cosa il CRM fa davvero oggi, cosa manca, e in quale ordine
vanno fatte le cose per non commettere errori irreversibili.

Regola di lettura: dove c'e' scritto **verificato**, il comportamento e' coperto
da test automatici o e' stato confermato sul campo con SdI. Dove c'e' scritto
**da fare**, non e' ancora implementato o non e' ancora stato provato.

## 1. Stato del canale

Canale Web Service SDICoop per HORYGON S.R.L. (`IT03365990591`), **passato in
produzione il 07.08.2026**: il Sistema di Accreditamento lo ha dichiarato
pienamente operativo. Non esiste piu' un ambiente di prova per questo canale:
ogni file inviato a SdI e' un documento fiscale.

Lo stesso giorno sono stati attivati i **Servizi Massivi** per l'identificativo
fiscale: Scarico Corrispettivi, Scarico Documenti IVA, **Scarico Fatture**,
Servizio Bollo.

Il **censimento del canale per le forniture massive** e' attivo e confermato:
provider HORYGON S.R.L., partita IVA `03365990591`, tipo **WebService**,
servizio rilevante **Scarico Fatture**. E' il presupposto senza il quale SdI
risponderebbe `ER02` a ogni richiesta massiva: non e' piu' un blocco.

I certificati non sono stati sostituiti al passaggio in produzione: restano
quelli emessi il 06.08.2026, validi fino al 05.08.2029.

Endpoint accreditato, confermato dall'Accordo di Servizio:

```text
https://sdi.horygon.it/api/sdi/ws/inbound
```

E' lo stesso per TEST e PRODUZIONE, e serve sia `TrasmissioneFatture` sia
`RicezioneFatture`. I due contratti vengono distinti dal dispatcher per
namespace, SOAPAction e operation: **non vanno separati**. `crm.horygon.it` non
e' il canale accreditato e su di esso `/api/sdi/ws/` risponde 403.

Endpoint SdI in uscita, dall'Accordo:

| Servizio | Produzione | Test |
|---|---|---|
| `SdIRiceviFile` | `servizi.fatturapa.it/ricevi_file` | `testservizi.fatturapa.it/ricevi_file` |
| `SdIRiceviNotifica` | `servizi.fatturapa.it/ricevi_notifica` | `testservizi.fatturapa.it/ricevi_notifica` |

Dimensione massima messaggio: **5 MB**. Finestra di manutenzione quotidiana
**00:00-00:59**: i job schedulati non vanno pianificati in quella fascia, e la
disponibilita' 01:00-24:00 e' un obbligo reciproco previsto dall'Accordo.

Nell'Accordo compare anche `SDITrasmissioneFile` (`servizi.fatturapa.it/dati-fattura`),
per dati fatture e liquidazioni periodiche IVA: accreditato ma **non implementato**.

## 2. Blocchi al go-live

Ne resta uno solo, ed e' operativo.

1. **Cutover della ricezione** dal codice destinatario Pass.go a quello HORYGON.
   E' l'ultimo passo: da quel momento le fatture passive reali arrivano
   sull'endpoint, indipendentemente da `sdi.mode`, che governa solo l'uscita.

La **firma qualificata** non e' piu' un blocco: HORYGON dispone di FirmaOK di
Poste, firma remota con PIN e OTP che produce un `.p7m` CAdES, tecnologicamente
adeguato sia per le FPA12 sia per le richieste SMTS. Non essendoci API
server-to-server, il CRM governa il ciclo di firma esterna descritto al §3.

L'**interfaccia** di quel ciclo e' stata fatta il 09.08.2026: stato della firma
sulla riga della fattura, scarico dell'XML, caricamento del `.p7m`, esito della
verifica con nome del firmatario e invio. Vedi §3.

Gia' risolti il 07.08.2026: passaggio del canale in produzione, attivazione dei
Servizi Massivi, indice univoco sui nomi file, pubblicazione della porta del
container solo su loopback, e mTLS sul vhost SdI su **entrambi** gli strati
(`ssl_verify_client on` in nginx e `sdi.inbound.client_cert_policy = enforce`
nell'applicazione). La catena del certificato client di SdI e' stata verificata
offline contro `ca.pem` prima di chiudere.

Fatture **B2B e B2C** sono quindi gia' emettibili: non richiedono firma.

## 3. Cosa fa il CRM oggi

### Invio fatture attive — verificato

1. genera XML FatturaPA nel formato corretto (FPA12, FPR12, FSM10);
2. valida contro XSD locale versionato;
3. esegue **pre-controlli fiscali** allineati all'Elenco dei controlli 2.0;
4. firma in CAdES-BES se il formato lo richiede;
5. salva XML immutabile, hash SHA-256 e versione schema;
6. invia via `SdIRiceviFile/RiceviFile` in SOAP 1.1 con MTOM/XOP su mTLS;
7. legge la risposta e registra l'esito reale.

I pre-controlli implementati, con le tolleranze dichiarate dall'Elenco:

| Codice | Controllo |
|---|---|
| 00400 / 00401 | Natura coerente con AliquotaIVA sulle linee |
| 00403 | data documento non futura |
| 00417 | cessionario con almeno un identificativo fiscale |
| 00421 | Imposta = Aliquota x Imponibile, tolleranza 0,01 EUR |
| 00422 | ImponibileImporto = somma PrezzoTotale, tolleranza 1 EUR |
| 00423 | PrezzoTotale coerente con sconti, anche a cascata, tolleranza 0,01 EUR |
| 00425 | numero documento con almeno una cifra |
| 00427 | CodiceDestinatario di 6 caratteri per FPA12, 7 per FPR12 e FSM10 |
| 00429 / 00430 | Natura coerente con AliquotaIVA nei riepiloghi |
| 00437 | ScontoMaggiorazione con Percentuale o Importo |
| 00443 / 00444 | corrispondenza aliquote e nature fra linee e riepiloghi |
| 00445 | divieto delle nature generiche N2, N3, N6 |
| — | PECDestinatario solo con CodiceDestinatario 0000000 e mai verso PA |

**Una validazione locale positiva significa che il file e' pronto per essere
inviato**, non che SdI lo accettera': restano fuori portata i controlli che
richiedono Anagrafe Tributaria o IndicePA (00300-00324, 00311, 00312).

### Firma delle FPA12 — ciclo esterno, verificato

`sdi.signature.mode` ammette tre valori: `disabled`, `local` (firma automatica,
richiede una chiave sul server) e **`external`**, che e' il caso HORYGON.

Con `external` una FPA12 nasce nello stato `firma_richiesta` e il flusso attende
il file firmato:

```text
XML generato -> scarica -> firma con FirmaOK (PIN + OTP) -> ricarica .p7m
   -> verifica -> pronto per l'invio -> SdIRiceviFile
```

| Rotta | |
|---|---|
| `GET /api/sdi/fatture/:id/firma` | stato del ciclo: flusso corrente, firmatario, cosa si puo' fare |
| `GET /api/sdi/flussi/:id/xml-da-firmare` | scarica l'XML da portare al dispositivo di firma |
| `POST /api/sdi/flussi/:id/firma` | ricarica il `.p7m` e lo verifica |
| `POST /api/sdi/flussi/:id/invia` | trasmette il flusso gia' firmato, senza rigenerarlo |

Il download propone il nome dell'XML, non quello del `.p7m`: il file scaricato
e' XML, ed e' il dispositivo di firma che aggiunge il suffisso. Il nome atteso
dopo la firma e' comunque mostrato nell'interfaccia, perche' e' quello che SdI
si aspetta di ricevere.

**`POST /api/sdi/flussi/:id/invia` non e' un doppione di
`POST /api/sdi/fatture/:id/send`.** Quest'ultima rigenera sempre l'XML, quindi
alloca un progressivo nuovo e crea un flusso nuovo: con la firma esterna
riporterebbe la fattura in `firma_richiesta` a ogni tentativo, e il file appena
firmato non verrebbe mai trasmesso. Per un documento gia' firmato si passa dal
flusso, non dalla fattura. La modalita' non e' scegliibile nella richiesta: e'
quella con cui il flusso e' nato, perche' nome file e progressivo sono stati
allocati in quell'ambiente.

L'interfaccia vive sulla riga della fattura, nelle sezioni contabili: un badge
mostra lo stato SdI accanto a quello di pagamento, e il pulsante **Firma /
Invio** apre il ciclo. Quando esistono piu' flussi per la stessa fattura — una
doppia generazione ne lascia due, ognuno con il suo progressivo — vengono
mostrati tutti: nasconderne uno significherebbe lasciarlo appeso senza traccia.

A SdI si invia **il `.p7m`**, non la firma separata: il contenitore CAdES
include XML, firma e certificato del firmatario, e viaggia nel campo `File`
dell'MTOM come qualunque altro allegato.

La verifica al rientro confronta lo **SHA-256 dell'XML estratto dal P7M** con
quello che il CRM aveva generato. Serve a impedire lo scenario in cui si scarica
un documento, se ne firma un altro e lo si ricarica: il CRM lo assocerebbe alla
fattura sbagliata. In caso di disallineamento risponde `SIGNED_DOCUMENT_MISMATCH`,
lascia il flusso in attesa, **non scrive nulla** e registra il rifiuto in audit.

Vengono inoltre estratti soggetto, emittente e validita' del certificato
firmatario, e la scadenza blocca l'accettazione: e' il controllo SdI `00100`, il
piu' banale da evitare. **Revoca e affidabilita' della CA non sono verificabili
in locale** e restano in capo a SdI, che lo dichiara nella risposta.

Un flusso in attesa di firma **non e' trasmissibile in nessun ambiente**: il
controllo precede quelli di ambiente, perche' e' una proprieta' del documento.

Le **FPR12 e FSM10 non richiedono firma** e proseguono con l'invio diretto.

Il ciclo non e' un ripiego permanente: se in futuro servira' l'automazione
completa, occorre un **sigillo elettronico qualificato con API**, che e' un
prodotto e un contratto diversi dalla firma remota personale.

### Import documentale — controparte e scadenza

Sulle fatture importate la controparte **dipende dalla direzione**: su una
passiva e' il cedente, su una attiva e' il cessionario. Prendere sempre il
cedente, come si faceva prima del 09.08.2026, significava registrare ogni
fattura emessa con HORYGON stessa come cliente e agganciarla alla nostra
anagrafica.

La scadenza viene letta da `DatiPagamento`: con piu' rate si tiene la **prima
in ordine di data**, e tutte finiscono comunque in `documento_meta`.

Restano fuori dal parser, e per ora vivono solo nel file originale archiviato:
`DatiOrdineAcquisto`, `DatiDDT`, `DatiContratto`, `DatiRitenuta`, `DatiBollo`,
`DatiCassaPrevidenziale`, allegati. Le fatture **in lotto** (piu' di un
`FatturaElettronicaBody`) non vengono importate: sono registrate con esito
`LOTTO` e vanno scomposte a parte.

### Ricezione fatture passive — verificato

SdI chiama l'endpoint, il CRM riconosce il contratto `RicezioneFatture`,
decodifica fattura e metadati, salva XML originale con hash e manifest, importa
la fattura e risponde `ER01`.

**Limite noto:** le fatture passive firmate `.p7m` arrivate dal canale realtime
vengono archiviate ma **non importate** automaticamente. Il CRM risponde comunque
`ER01`, quindi SdI considera la consegna riuscita e non ritenta. Da monitorare
dopo il cutover. La pipeline di import storico invece estrae il P7M correttamente.

### Notifiche — verificato

Operazioni gestite: `RicevutaConsegna`, `NotificaScarto`, `RicevutaScarto`,
`NotificaMancataConsegna`, `RicevutaImpossibilitaRecapito`, `NotificaEsito`,
`NotificaDecorrenzaTermini`, `AttestazioneTrasmissioneFattura`, piu' i metadati.

Per le operazioni one-way la risposta corretta e' `HTTP 200`, `Content-Length: 0`,
body vuoto. Niente JSON, niente HTML, niente SOAP, niente `ER01`.

Il SdI usa **due namespace** e in alcuni casi **due nomi per lo stesso
documento**:

| Concetto | Flusso PA | Flusso B2B/B2C |
|---|---|---|
| namespace | `www.fatturapa.gov.it/sdi/messaggi/v1.0` | `ivaservizi.agenziaentrate.gov.it/.../messaggi/v1.0` |
| scarto | `NotificaScarto` | `RicevutaScarto` |
| mancato recapito | `NotificaMancataConsegna` | `RicevutaImpossibilitaRecapito` |
| metadati | `MetadatiInvioFile` | `FileMetadati` |
| ricevuta consegna | senza `Hash`, con `Destinatario/Descrizione` | con `Hash`, senza descrizione |

**Il suffisso del nome file non determina il tipo**: `_MC_` vale sia per la
notifica PA sia per la ricevuta B2B. La classificazione viene dalla radice.

Undici messaggi realmente ricevuti da SdI sono versionati come fixture in
`tests/fixtures/sdi-messaggi/` e i test ci girano sopra a ogni esecuzione.

### Esito committente PA — verificato

`SdIRiceviNotifica/NotificaEsito` con `EC01` accettazione e `EC02` rifiuto.
Risposte gestite: `ES01` accettata, `ES00` scartata con decodifica di
`ScartoEsito/File` ed estrazione di `EN00`/`EN01`, `ES02` ritentabile.

**HTTP 200 non significa esito accettato**: va letto il contenuto della risposta.

Il documento generato dal CRM e' confrontato in test con quello realmente
accettato da SdI con `ES01`.

## 4. Numerazioni

Sono due cose diverse e non vanno confuse.

**Numero fattura fiscale** (`45/2026`): numero contabile, coerente con la
contabilita' e con lo storico gia' emesso.

**ProgressivoInvio SdI** (`H0001`): progressivo tecnico del file. Allocato da una
sequenza persistente e transazionale in `sdi_progressivi`, con prefisso
configurabile. Non deve seguire una stretta progressivita', ma **non puo' mai
ripetersi**: un nome file gia' usato viene rifiutato con `00002` in modo
definitivo. Un indice UNIQUE parziale sul database rende il vincolo strutturale.

## 5. Sincronizzazione e storico

Il canale SdI **non permette di scaricare le fatture passate**: consegna solo i
documenti nuovi. Lo storico si recupera in due modi.

**Servizi Massivi (SMTS)** — `sm-scarico-file`, endpoint
`servizi.fatturapa.it/sm-scarico-file`, operazioni `inoltroRichiesta`,
`esitoRichiesta`, `scaricoFile`. Contratti ufficiali versionati in
`resources/sdi/smts/`. Adapter e orchestratore implementati e testati su
fixture; **non ancora provati contro l'endpoint reale**.

Il ciclo e' diviso in passi separati perche' non e' automatizzabile fino in
fondo: in mezzo c'e' una firma qualificata con PIN e OTP.

| Passo | Rotta |
|---|---|
| pianifica le finestre | `POST /api/sdi/storico/piano` |
| prepara la richiesta | `POST /api/sdi/storico/jobs/:id/prepara` |
| scarica la richiesta | `GET /api/sdi/storico/jobs/:id/richiesta-da-firmare` |
| ricarica il `.p7m` | `POST /api/sdi/storico/jobs/:id/firma` |
| inoltra | `POST /api/sdi/storico/jobs/:id/inoltra` |
| interroga l'esito | `POST /api/sdi/storico/jobs/:id/esito` |
| scarica gli archivi | `POST /api/sdi/storico/jobs/:id/scarica` |
| importa | `POST /api/sdi/storico/jobs/:id/importa` |
| rileggi quanto gia' scaricato | `POST /api/sdi/storico/jobs/:id/riprocessa` |
| chiudi una richiesta senza via d'uscita | `POST /api/sdi/storico/jobs/:id/abbandona` |
| elimina il job | `DELETE /api/sdi/storico/jobs/:id` |

Una richiesta scartata da SdI non diventera' mai pronta: il job va **abbandonato**
(cosi' l'indice univoco libera quel periodo) oppure **eliminato**. L'eliminazione
cancella job, archivi e registro dei documenti, ma **non le fatture importate**:
quelle sono documenti fiscali e si rimuovono solo con `riprocessa`, che lo
dichiara.

`GET /api/sdi/storico/stato` dice in anticipo cosa manca ancora per partire.

Tutto questo ha un'interfaccia: sezione **Storico SdI** sotto Contabilita, con
pianificazione, tabella dei job e il passo successivo su ogni riga.

**Solo la firma richiede una persona.** Il resto avanza da solo: con
`sdi.massive.auto = 1` uno scheduler in-process fa una passata ogni
`sdi.massive.auto.interval_minutes`, un passo per job. Non tocca mai i job in
attesa di firma, non scarica le fatture messe a disposizione (presa visione
fiscale) e si ferma nella finestra di manutenzione, calcolata sull'ora italiana
e non su quella del container, che in produzione gira su UTC. Le dieci
interrogazioni di esito le spalma con un intervallo minimo configurabile.
`POST /api/sdi/storico/avanza` fa la stessa passata a comando.

Tre cose apprese dalla specifica del formato file v1.5, che non erano nel
codice:

- **l'elenco degli archivi non e' nella risposta SOAP.** `esitoRichiesta`
  restituisce un `EsitoFile`, ed e' li' dentro che stanno gli `IdFile` da
  passare a `scaricoFile`, insieme a `DataFineDisponibilita`, che e' la
  scadenza oltre la quale non si scarica piu' niente;
- **ogni file-fattura viaggia con un file di metadati** che riporta `idfile`,
  cioe' l'IdentificativoSdI, `hashfile` e `dataaccoglienza`. Dal nome del
  file-fattura quell'identificativo non si ricava, e senza di esso il livello
  di deduplicazione piu' forte resterebbe inutilizzato. Il CRM riconosce quei
  file dal contenuto e li abbina alla fattura **per hash**, non per nome;
- gli archivi hanno una `TipoElementi`: un archivio per richiesta contiene una
  sola tipologia, e il backfill fatture scarica solo `Fatt`.

Manca `ScaricoRichiesteEsito_v1.0.xsd`, che non e' pubblicato insieme al WSDL:
il parser segue la tabella della specifica. Il **primo esito realmente
ricevuto** e' versionato in `tests/fixtures/smts/` e i test ci girano sopra,
perche' mostra due cose che la tabella non dice:

- `TipoElementi` arriva **maiuscolo** (`FATT`), non `Fatt` come nella tabella.
  Un confronto esatto scartava in silenzio l'unico archivio prodotto;
- `NumeroErrori` **manca del tutto** quando non ci sono errori, invece di
  valere zero;
- il namespace reale e' `.../ScaricoRichiestaEsito/v1.0`, al singolare, mentre
  la specifica nomina lo schema `ScaricoRichiesteEsito_v1.0.xsd`, al plurale;
- `DataFineDisponibilita` e' un **dateTime** con fuso, non una data.

**Attenzione a non confondere due tracciati omonimi.** Esiste anche un
`InputMassivo` del servizio *Consultazione e Download Massivi* (versione 2.4),
quello che si usa a mano dal portale Fatture e Corrispettivi: stesso namespace
`http://www.sogei.it/InputPubblico`, stessa radice, schema diverso. Quello
prevede `Adesione`, `Anagrafica` e `Ricevute` e **non** ha `TipoOutput`; il
nostro, versionato accanto al WSDL, ha `TipoOutput`, `FattureSDI`,
`FattureDataAcc`, `IvaPrecompilata` e `Lipe`. Il contratto giusto per il canale
in cooperazione applicativa e' quello nel repo.

Il CRM **omette comunque `TipoOutput`**: e' facoltativo nel nostro tracciato e
assente vale `FILE_FATTURA`, quindi toglierlo non cambia il risultato e rende
la richiesta accettabile da entrambe le versioni. Resta passabile
esplicitamente per chiedere `ELENCO`, che pero' produce un CSV di estremi non
importabile.

Tre vincoli del servizio sono applicati sul job, non solo in memoria:

- le **dieci interrogazioni di esito** per richiesta sono contate sul job.
  Fra l'inoltro e la disponibilita' degli archivi passano ore, e un contatore
  tenuto solo nel client si azzererebbe al primo riavvio del container;
- oltre **`DataFineDisponibilita`** non si scarica piu' nulla: il job passa a
  `EXPIRED` e lo dice, invece di consumare tentativi contro archivi che non
  esistono piu'. Da li' serve una richiesta nuova, quindi un'altra firma;
- un job **`PARTIAL` si riprende** da dove si era fermato: gli archivi gia'
  importati restano `PROCESSED`. Un backfill non ripartibile costringerebbe a
  rifare la richiesta, cioe' a spendere una firma per dati gia' scaricati.

**Ogni richiesta viene validata contro gli XSD ufficiali prima di essere
proposta alla firma** (`validateMassiveRequest`, entrambi i livelli, con
`libxml2-wasm`). Non e' zelo: un file non conforme torna indietro come `00200`
solo dopo l'inoltro, cioe' quando la firma qualificata e' gia' stata spesa e
non e' recuperabile. Gli schemi sono versionati nel repo, verificare li' costa
nulla ed e' l'ultimo momento in cui l'errore e' gratis.

**La richiesta e' annidata su due livelli, e si firma quello esterno.** Le
specifiche del formato v1.5 par. 1.1 dicono che alla SOAP request si allega un
file conforme a `RichiestaServiziMassivi_v1.0.xsd`:

```text
FileRichiesta versione="1.0"        <- questo e' il documento firmato
  TipoRichiesta = FATT
  NomeFile
  File = base64( InputMassivo )     <- il periodo e la partita IVA stanno qui
```

Firmare l'`InputMassivo` nudo produce un file che il servizio rifiuta, e la
firma qualificata spesa per produrlo e' persa: va rifatta. Il `ds:Signature`
previsto dal tracciato e' lo spazio per la firma XAdES avvolgente; con CAdES il
documento resta com'e' e la firma lo avvolge dall'esterno, nel `.p7m`.

**I due tracciati si scrivono in modo opposto**, ed e' la trappola che e'
costata una firma il 10.08.2026:

| Schema | `elementFormDefault` | Come si scrive |
|---|---|---|
| `InputMassivo_v1.5` | `qualified` | `xmlns` di default: tutto nel namespace |
| `RichiestaServiziMassivi_v1.0` | **assente** = `unqualified` | prefisso sulla sola radice: i figli **fuori** dal namespace |

Con `xmlns` di default sull'involucro, `TipoRichiesta` finisce nel namespace e
SdI risponde `00200 - File non conforme al tracciato`, indicando proprio quel
primo elemento.

Formati ammessi per la firma: **CAdES-BES** (ETSI TS 101 733 v1.7.4, cioe' il
`.p7m`) oppure **XAdES-BES** (ETSI TS 101 903 v1.4.1). Il base-64 non e' un
terzo formato: e' la codifica con cui il file viaggia, applicata due volte, e la
mette il CRM.

**Una richiesta chiede una direzione sola.** Dentro `Fatture` il tracciato ha
un `xs:choice` fra `FattureEmesse`, `FattureRicevute`, `FattureFEDisposizione`,
`FattureSDI` e `FattureDataAcc`: esattamente uno per richiesta. Attive e passive
non possono arrivare insieme, e infatti il `Ruolo` e' fisso per blocco (CEDENTE
sulle emesse, CESSIONARIO sulle ricevute). Per marzo-oggi servono quindi quattro
richieste: due finestre per due direzioni, quattro firme.

La firma della richiesta massiva segue lo stesso ciclo esterno delle FPA12
(`sdi.massive.signature.mode = external`), con lo stesso controllo: il
contenuto estratto dal `.p7m` deve coincidere con la richiesta registrata,
altrimenti si interrogherebbe un periodo diverso da quello del job.

**Sono due firme diverse e non vanno confuse.** Quella sulla fattura riguarda
solo le FPA12 che emettiamo noi. Quella sulla richiesta massiva riguarda il
file `InputMassivo`, serve per **ogni** richiesta SMTS a prescindere dalla
direzione, e non tocca le fatture che tornano indietro: una fattura passiva non
si firma mai: la firma, se c'e', e' di chi l'ha emessa, e il CRM al massimo la
verifica estraendola dal `.p7m`. Nell'interfaccia le due cose hanno etichette
distinte proprio per questo.

Attenzione a queste cose delle Istruzioni SMTS v1.5:

- le fatture in **reverse charge sono escluse** da tutte le operazioni di
  download: non arriveranno mai dal backfill;
- scaricare un archivio contenente **fatture messe a disposizione vale come
  presa visione fiscale**: non va fatto in automatico;
- intervallo massimo di **tre mesi** per richiesta (controllo 00201), e sono
  mesi di calendario, non un numero fisso di giorni: dal 1 marzo al 1 giugno
  sono tre mesi e ne fanno 93, dal 1 dicembre al 1 marzo sono tre mesi e ne
  fanno 91. Contare i giorni rifiuta intervalli che il servizio accetta;
- **10 richieste al giorno** per partita IVA e tipologia (errore 00604): le
  quattro del backfill marzo-oggi ci stanno comodamente;
- al massimo **50 archivi per richiesta**, ciascuno fino a **35 MB**
  (errori 00502 e 00503);
- gli archivi restano scaricabili **30 giorni** per i file-fattura. E' la
  finestra che `DataFineDisponibilita` esprime.

Sulle **interrogazioni di esito** le Istruzioni dicono "per la stessa richiesta
al piu' 10 volte", ma la finestra temporale a cui quel limite si riferisce **non
e' leggibile**: la frase e' spezzata da un salto di pagina nel PDF. L'errore
restituito e' pero' `ER03 - Richiesta troppo frequente`, lo stesso dei dieci
archivi in due minuti, quindi e' una soglia di frequenza e non un tetto
definitivo. Il CRM la tratta cosi': conteggio azzerato dopo 24 ore di riposo,
piu' un intervallo minimo fra due interrogazioni. Trattarla come un budget a
vita bloccherebbe per sempre un job che deve solo aspettare piu' del previsto.

**Import manuale** — export XML dal cassetto fiscale o da Pass.go, poi import
nel CRM. Non dipende da nessuno dei blocchi ed e' la strada percorribile subito.

**Riconciliazione** — quadratura e reinoltro esistono per **entrambi** i flussi:
`quadratura-flusso-trasmissione` e `reinoltro-flusso-trasmissione` per le
notifiche sulle fatture inviate, `quadratura-flusso-ricezione` e
`reinoltro-flusso-ricezione` per fatture passive e decorrenze. Quindi **una
passiva persa durante un fermo e' recuperabile**, entro 30 giorni.

Finestre: la quadratura non puo' includere gli ultimi 15 giorni e copre al
massimo 15 giorni; il reinoltro accetta identificativi degli ultimi 30 giorni
esclusi gli ultimi 7. Cadenza sensata: **settimanale**, fuori dalla finestra di
manutenzione. Mancano i tre WSDL, da recuperare dal Sistema di Accreditamento.

## 6. Protezioni contro gli errori irreversibili

- una fattura importata dallo storico nasce con `sdi_send_allowed = 0` e non e'
  ritrasmettibile: il guardrail e' nel dato, non nella UI;
- un flusso generato in un ambiente non puo' essere trasmesso nell'altro;
- l'invio in produzione richiede `sdi.mode = production` **e**, con policy
  `MANUAL_CONFIRMATION`, una conferma esplicita per ogni fattura;
- la deduplicazione dell'import lavora su cinque livelli e riconosce lo stesso
  documento anche fra versione firmata e in chiaro; se la fattura esiste gia'
  come `CRM` viene arricchita, non duplicata;
- gli archivi ZIP passano da `SafeZipReader`, che valida l'intera central
  directory prima di estrarre e blocca Zip Slip, percorsi assoluti, symlink, zip
  bomb e dimensioni dichiarate false.

## 7. Sicurezza operativa

- **Cloudflare in modalita' DNS only** (nuvola grigia) su `sdi.horygon.it`: il
  proxy arancione interferisce con il certificato del canale.
- **La porta del container e' pubblicata solo su loopback** (`127.0.0.1:8443`):
  senza questo, l'endpoint SdI sarebbe raggiungibile da Internet scavalcando
  nginx, e gli header di verifica del certificato client sarebbero falsificabili.
- **mTLS da attivare** sul vhost SdI, in due tempi: prima
  `ssl_verify_client optional` osservando `sslClientVerify` in `system_log` su
  una chiamata reale, poi `on` solo dopo aver visto `SUCCESS`. Chiudere alla
  cieca fa perdere consegne in silenzio.
- **Certificati e chiavi non vanno mai versionati.** Sul VPS stanno in
  `/root/sdi-certs`, montati in sola lettura su `/run/sdi-certs`. Nel CRM usare
  sempre path container: un path Windows dentro Docker diventa inesistente.
- I file `.cer` possono essere DER o PEM. Nginx richiede PEM e non basta
  rinominarli: vanno convertiti verificando prima il formato reale.

## 8. Trappole dell'ambiente, verificate sul campo

**Scritture da `docker compose exec`.** Nel container e' montato solo
`horygon.db`, non i sidecar `-wal` e `-shm`. Una scrittura fatta da un processo
`exec` resta nel WAL, sopravvive a `docker compose restart` e viene **buttata via
da `docker compose up --build`**, che ricrea il container. Ogni comando `exec`
che scrive deve terminare con `PRAGMA wal_checkpoint(TRUNCATE)` nello stesso
processo. Il sintomo e' insidioso: il comando riporta successo, la verifica
immediata conferma, e il dato sparisce ore dopo al primo rebuild.

**Backup degli editor in `sites-enabled`.** Debian include i vhost con
`include /etc/nginx/sites-enabled/*`, una glob senza estensione che cattura anche
i file `~` lasciati dall'editor. Un backup dimenticato li' viene caricato come
configurazione. Editare sempre in `sites-available`, mai in `sites-enabled`, e
tenere i backup fuori da entrambe.

**Il certificato di `sdi.horygon.it` non corrisponde all'hostname**: e' il
certificato del canale emesso dall'Agenzia (`CN = SDI-03365990591`). Un client
normale rifiuta la connessione, e va bene cosi': per verificare da riga di
comando serve `curl -k` oppure `openssl s_client`.

**Le radici di sistema servono nel bundle CA.** `servizi.fatturapa.it` e' firmato
da una CA pubblica: passare a Node solo i certificati della cartella
sostituirebbe lo store di sistema e la connessione reggerebbe unicamente sul
certificato foglia, che scade e viene ruotato senza preavviso.

## 9. Sequenza di go-live

Fatto il 07.08.2026:

1. ~~Accettare l'Accordo di Servizio e richiedere il passaggio in produzione.~~
2. ~~Verificare la consegna di nuovi certificati.~~ Nessun certificato nuovo.
3. ~~Attivare l'mTLS su `sdi.horygon.it`.~~ `on` in nginx piu' `enforce`
   nell'applicazione, con verifica offline della catena prima di chiudere.
4. ~~Rendere strutturale l'indice univoco sui nomi file.~~

Da fare, in quest'ordine:

5. Impostare `sdi.signature.mode = external` e collaudare il ciclo di firma su
   una FPA12 dall'interfaccia: scarica, firma con FirmaOK, ricarica, verifica,
   invia. E' il primo passo che tocca il canale reale.
6. **Backup del database**, a container fermo o con checkpoint esplicito.
7. Azzerare i dati di test con `scripts/reset-sdi-invoice-data.js`, prima in
   dry-run e **senza `--reset-progressivo`**: i progressivi gia' arrivati a SdI
   restano bruciati per sempre.
8. **Scaricare** lo storico dai Servizi Massivi (`/api/sdi/storico`), oppure
   esportarlo dal cassetto fiscale. Per marzo-oggi bastano **due finestre da
   tre mesi** per direzione (01.03-31.05 e 01.06-oggi): il tracciato non ne
   ammette di piu' larghe, e ogni finestra costa una firma qualificata a mano.
9. **Importare**, prima in dry-run, poi davvero. Verificare numeri, totali,
   direzioni e controparti.
10. Ricostruire la numerazione fiscale corrente.
11. Impostare `sdi.mode = production`, lasciando
    `production_send_policy = MANUAL_CONFIRMATION`.
12. Emettere la prima fattura reale con conferma esplicita e verificare la
    ricevuta. In produzione non esiste un invio di prova: la prima fattura e'
    gia' un documento fiscale.
13. Cutover della ricezione da Pass.go al codice destinatario HORYGON.
14. Ricevere e verificare la prima fattura passiva reale.
15. Attivare la riconciliazione periodica settimanale.

**Azzerare prima di importare, non dopo.** `reset-sdi-invoice-data.js` fa
`DELETE FROM fatture` senza filtri: lanciato dopo l'import cancellerebbe anche
lo storico appena acquisito. E a rovescio, importando per primi, la
deduplicazione riconoscerebbe una fattura di test come gia' presente e la
**arricchirebbe** invece di importare quella vera, lasciando la riga di test
travestita da documento reale.

Scarico e import sono due passi distinti di proposito: il download costa una
firma e scade con `DataFineDisponibilita`, il parsing e' gratis e ripetibile.
Se il parser migliora, `POST /api/sdi/storico/jobs/:id/riprocessa` rilegge gli
archivi gia' in casa senza chiedere niente a SdI.

Se dopo il punto 13 le fatture passive non arrivano, la prima cosa da riportare
indietro e' l'mTLS, riportando `ssl_verify_client` a `optional` e ricaricando
nginx: le consegne fallite non generano un errore visibile, SdI ritenta in
silenzio e poi mette in impossibilita' di recapito.

## 10. Cosa resta aperto

- import automatico delle passive firmate `.p7m` dal canale realtime;
- **collaudo del backfill contro l'endpoint reale**: adapter e orchestratore
  girano su fixture, il censimento c'e', ma nessuna richiesta e' ancora partita;
- interfaccia del backfill: le rotte ci sono, i pulsanti no;
- client di quadratura e reinoltro, in attesa dei tre WSDL;
- `SDITrasmissioneFile` per dati fattura e liquidazioni IVA, accreditato ma non
  implementato;
- il rate limiter globale su `/api` copre anche il callback SdI: da escludere o
  alzare prima di volumi reali;
- schemi XSD dei file messaggi, utili per conoscere cardinalita' e campi
  facoltativi oltre a quanto mostrano i campioni reali.
