# Integrazione SdI nel CRM HORYGON

Ultimo aggiornamento: 2026-08-07

Questo documento e' il riferimento operativo per il passaggio in produzione del
canale SdI. Descrive cosa il CRM fa davvero oggi, cosa manca, e in quale ordine
vanno fatte le cose per non commettere errori irreversibili.

Regola di lettura: dove c'e' scritto **verificato**, il comportamento e' coperto
da test automatici o e' stato confermato sul campo con SdI. Dove c'e' scritto
**da fare**, non e' ancora implementato o non e' ancora stato provato.

## 1. Stato del canale

Canale Web Service SDICoop per HORYGON S.R.L. (`IT03365990591`), accreditato in
ambiente TEST con test di interoperabilita' superati.

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

In ordine di impatto. Nessuno di questi dipende dal codice del CRM.

1. **Passaggio del canale in produzione.** Va accettato l'Accordo di Servizio e
   richiesta l'attivazione sul Sistema di Accreditamento. Sblocca in cascata:
   comparsa di HORYGON nell'elenco provider, censimento canale, richieste SMTS e
   invio di fatture reali.
2. **Certificato di firma qualificata.** Serve un **sigillo elettronico
   qualificato** con firma automatizzabile, non una firma digitale personale su
   smart card, che richiede presenza fisica a ogni operazione. Senza, le fatture
   FPA12 non partono: il CRM le blocca prima dell'invio invece di farle scartare
   con `00102`.
3. **Censimento canale** su *Fatture e Corrispettivi -> Consultazione ->
   Censimento canali per forniture massive*. Necessario solo per i Servizi
   Massivi, non per la fatturazione ordinaria. Finche' manca, ogni richiesta
   massiva risponde `ER02 - utente non abilitato`.
4. **mTLS sul vhost SdI.** `sdi.horygon.it` presenta il certificato server
   emesso dall'Agenzia ma **non verifica il certificato client di SdI**. Chiunque
   raggiunga l'endpoint puo' iniettare notifiche e fatture passive. Vedi §7.

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
`resources/sdi/smts/`. Adapter implementato e testato su fixture; **non ancora
provato contro l'endpoint reale**, perche' bloccato dai punti 1-3 del §2.

Attenzione a tre cose delle Istruzioni SMTS v1.5:

- le fatture in **reverse charge sono escluse** da tutte le operazioni di
  download: non arriveranno mai dal backfill;
- scaricare un archivio contenente **fatture messe a disposizione vale come
  presa visione fiscale**: non va fatto in automatico;
- limiti: 10 interrogazioni di esito per richiesta, 10 archivi ogni due minuti,
  intervallo massimo di tre mesi per richiesta.

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

1. Accettare l'Accordo di Servizio e richiedere il passaggio in produzione.
2. Verificare che HORYGON compaia nell'elenco provider accreditati.
3. Verificare se l'attivazione consegna **nuovi** certificati e, in tal caso,
   sostituirli in `/root/sdi-certs/prod/`.
4. Attivare l'mTLS su `sdi.horygon.it`, prima `optional` poi `on`.
5. Configurare il certificato di firma qualificata e impostare
   `sdi.signature.mode = local`.
6. **Backup del database**, a container fermo o con checkpoint esplicito.
7. Esportare lo storico dal cassetto fiscale e importarlo, prima in **dry-run**.
8. Verificare numeri, totali e direzioni dello storico importato.
9. Azzerare i dati di test con `scripts/reset-sdi-invoice-data.js`, prima in
   dry-run. Sblocca anche l'indice univoco sui nomi file.
10. Ricostruire la numerazione fiscale corrente.
11. Impostare `sdi.mode = production` e `production_send_policy = MANUAL_CONFIRMATION`.
12. Emettere la prima fattura reale con conferma esplicita e verificare la
    ricevuta.
13. Cutover della ricezione da Pass.go al codice destinatario HORYGON.
14. Ricevere e verificare la prima fattura passiva reale.
15. Attivare la riconciliazione periodica settimanale.

I punti 6, 7 e 9 in quest'ordine: importare lo storico **prima** di azzerare i
dati di test, altrimenti si perde il termine di confronto.

## 10. Cosa resta aperto

- import automatico delle passive firmate `.p7m` dal canale realtime;
- orchestratore che lega archivio ZIP, estrazione e import documento per
  documento, con report e dry-run end-to-end;
- client di quadratura e reinoltro, in attesa dei tre WSDL;
- `SDITrasmissioneFile` per dati fattura e liquidazioni IVA, accreditato ma non
  implementato;
- il rate limiter globale su `/api` copre anche il callback SdI: da escludere o
  alzare prima di volumi reali;
- schemi XSD dei file messaggi, utili per conoscere cardinalita' e campi
  facoltativi oltre a quanto mostrano i campioni reali.
