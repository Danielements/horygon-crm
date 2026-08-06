# Stato interoperabilita SDICoop HORYGON

Ultimo aggiornamento: 2026-08-06

Questo documento raccoglie lo stato operativo dell'integrazione SdI nel CRM HORYGON, le cose gia funzionanti, le configurazioni note e le lezioni apprese durante il test di accreditamento WS.

## Stato accreditamento

Gia superati sul portale SdI:

- Ricezione Fattura.
- Notifica Scarto.

Ancora da completare:

- Ricevuta Consegna.
- Notifica Mancata Consegna B2G / Ricevuta Impossibilita Recapito B2B/B2C.
- Notifica di esito da PA.
- Notifica di scarto esito a PA.
- Notifica Decorrenza Termini a PA.
- Notifica esito a Operatore Economico.
- Notifica Decorrenza Termini a Operatore Economico.
- Attestazione avvenuta trasmissione.

Nota importante: Ricevuta Consegna e Notifica Mancata Consegna sono notifiche del servizio `TrasmissioneFatture`, quindi arrivano dopo un invio fattura a SdI tramite `SdIRiceviFile`. Non sono la stessa cosa del test "Ricezione Fattura", che riguarda il servizio `RicezioneFatture`.

## Architettura attuale

Il CRM espone un unico endpoint pubblico:

- `https://sdi.horygon.it/api/sdi/ws/inbound`

Lo stesso URL riceve piu contratti SOAP, distinguendo namespace, SOAPAction e operazione dentro il `Body`.

Componenti gia implementati:

- Client `SdIRiceviFile`: invia fatture a SdI TEST via SOAP 1.1 MTOM/XOP.
- Client `SdIRiceviNotifica`: invia `NotificaEsitoCommittente` a SdI TEST via SOAP 1.1.
- Server `RicezioneFatture`: riceve fatture passive da SdI, decodifica file e metadati, importa la fattura e risponde `ER01`.
- Server `TrasmissioneFatture`: riceve notifiche lato trasmittente, salva XML e collega il flusso.
- Registro schemi FatturaPA locali: FPA12, FPR12, FSM10.
- Validazione XSD locale prima dell'invio.
- Persistenza dei metadati SdI delle fatture passive ricevute: `IdentificativoSdI`, nome file fattura, nome file metadati, path XML e hash.
- Log tecnico su `System Log` e audit utente.

Ancora da completare:

- Test automatici MTOM inbound reali per tutte le operazioni.
- Verifica reale sul portale degli step PA con invio `EC01` / `EC02` da fattura passiva FPA12 ricevuta.
- Decorrenza termini e attestazione, che dipendono dai tempi/stati del simulatore SdI.

## Ambiente server

CRM sul VPS:

- Path progetto: `/opt/horygon-crm`
- Branch operativa: `codex/sdi-diagnostics`
- Docker Compose service: `horygon-crm`
- Porta container: `3001`
- Porta host: `8443`

Reverse proxy:

- Nginx su porta `443`.
- Dominio SdI dedicato: `sdi.horygon.it`.
- Record Cloudflare: DNS only, nuvola grigia.

Motivo del dominio dedicato:

- SdI deve raggiungere direttamente il server con certificato server rilasciato dal Sistema di Accreditamento.
- Il proxy Cloudflare arancione non va usato per questo endpoint perche interferisce con TLS/certificati.

## Certificati

I certificati non devono essere versionati su GitHub.

Sul VPS i certificati stanno sotto:

- `/root/sdi-certs`

Nel container sono montati read-only sotto:

- `/run/sdi-certs`

Path usati dal CRM:

- Produzione client cert: `/run/sdi-certs/prod/client.cer`
- Produzione client key: `/run/sdi-certs/prod/client.key`
- Produzione server cert: `/run/sdi-certs/prod/server.cer`
- Produzione server key: `/run/sdi-certs/prod/server.key`
- Produzione CA: `/run/sdi-certs/prod/ca.cer`
- Test CA: `/run/sdi-certs/test/caentrate.cer`

Nota imparata: i file `.cer` possono essere DER o PEM. Nginx richiede PEM, quindi per il certificato server puo servire conversione con OpenSSL. Non rinominare semplicemente `.cer` in `.crt`.

## Endpoint e codici destinatario TEST

Endpoint registrato:

- `https://sdi.horygon.it/api/sdi/ws/inbound`

Codici destinatario PA di test:

- `ESOJKL`
- `VRRMFL`
- `ESOWLS`

Codici destinatario B2B di test:

- `UMZGLCP`
- `TLYFKZO`
- `SKXEJYN`

Questi codici sono stati salvati nel CRM tramite script come anagrafiche TEST.

## Cosa funziona

### Diagnostica certificati e handshake

Funziona:

- Lettura certificati dal container tramite `/run/sdi-certs`.
- Verifica presenza CSR/cert/key configurati.
- Handshake HTTPS verso ambiente SdI TEST.
- Bundle CA test corretto dopo aver incluso CA/intermedi.

Errore risolto:

- `self-signed certificate in certificate chain`

Causa:

- CA chain incompleta o CA non corretta per ambiente test.

### Ricezione fattura

Funziona:

- SdI chiama `https://sdi.horygon.it/api/sdi/ws/inbound`.
- Il CRM riconosce `RicezioneFatture/fileSdIConMetadati`.
- Il CRM decodifica fattura e metadati.
- Il CRM salva envelope, XML decodificato, metadati e manifest.
- Il CRM importa la fattura passiva.
- Il CRM risponde SOAP con `rispostaRiceviFatture` e `Esito ER01`.
- Il portale SdI ha marcato "Ricezione Fattura" come OK.

Path salvataggio inbound:

- `/uploads/sdi-inbound/YYYY/MM/DD/<requestId>/sdi-envelope.xml`
- `/uploads/sdi-inbound/YYYY/MM/DD/<requestId>/decoded/<NomeFile>`
- `/uploads/sdi-inbound/YYYY/MM/DD/<requestId>/metadata/<NomeFileMetadati>`
- `/uploads/sdi-inbound/YYYY/MM/DD/<requestId>/manifest.json`

### Invio fattura a SdI TEST

Funziona:

- Generazione XML FatturaPA FPR12/FPA12 con validazione XSD locale.
- Invio SOAP 1.1 `multipart/related` MTOM/XOP verso `https://testservizi.fatturapa.it/ricevi_file`.
- Certificato client mTLS caricato da `/run/sdi-certs/prod/client.cer` e `/run/sdi-certs/prod/client.key`.
- Parsing risposta multipart SdI.
- Salvataggio risposta SdI.
- Acquisizione `IdentificativoSdI`.

Invio TEST riuscito documentato:

- File: `IT03365990591_2608061651.xml`
- Identificativo SdI: `32477811`
- HTTP: `200 OK`

Errore risolto:

- `Certificato client SDI non trovato: /app/C:\Users\...`

Causa:

- Path Windows rimasti nelle impostazioni applicative.

Correzione:

- Normalizzazione path legacy verso `/run/sdi-certs`.

Errore risolto:

- HTTP `500 Internal Error` su `ricevi_file`.

Causa principale:

- `NomeFile` non conforme a `TrasmissioneTypes_v1.0.xsd`, pattern `[a-zA-Z0-9_\.]{9,50}`.
- Il nome precedente conteneva trattini e superava il limite: `03365990591_IT01043931003_TEST-SDI-001_2608061647.xml`.

Correzione:

- Nome file conforme: `IT03365990591_<ProgressivoInvio>.xml`.

### Ricezione Notifica Scarto

Funziona:

- SdI chiama il nostro endpoint con operazione `TrasmissioneFatture/notificaScarto`.
- Il CRM riconosce SOAPAction `http://www.fatturapa.it/TrasmissioneFatture/NotificaScarto`.
- Il CRM decodifica il campo `File`.
- Il CRM collega la notifica al flusso tramite `NomeFile` o `IdentificativoSdI`.
- Il CRM risponde `HTTP 200` con body vuoto, come richiesto dalle operazioni one-way.
- Il portale SdI ha marcato "Notifica Scarto" come OK.

Varianti gestite:

- `NotificaScarto`
- `RicevutaScarto`

Nota: `RicevutaScarto` e' la variante B2B/B2C e ora viene normalizzata come `scarto`.

### Progressivo invio

Errore risolto:

- Piu fatture generate nello stesso minuto avevano lo stesso nome file, ad esempio `IT03365990591_2608061723.xml`.

Causa:

- `ProgressivoInvio` era basato su timestamp tagliato ai minuti.

Correzione:

- `ProgressivoInvio` ora usa una componente alfanumerica basata su `Date.now()` piu id fattura, entro 10 caratteri.
- I file generati sono univoci anche in batch.

Esempio:

- `IT03365990591_SHSJEJW008.xml`

## Cosa non funziona ancora

Le fatture inviate per i test successivi sono state ricevute da SdI ma scartate.

Conseguenza:

- Non arriva `RicevutaConsegna`.
- Non arriva `NotificaMancataConsegna` / `RicevutaImpossibilitaRecapito`.

Motivo:

- Se SdI scarta il file, il flusso si ferma prima del recapito al destinatario.
- Per ottenere consegna/mancata consegna serve una fattura formalmente e applicativamente valida per quello scenario di test.

Prossimo passo tecnico:

- Leggere codice e descrizione dello scarto dalle notifiche gia salvate.
- Correggere il tracciato XML o i dati test in base al codice scarto reale.

Comando VPS:

```bash
cd /opt/horygon-crm
docker compose exec horygon-crm node scripts/inspect-sdi-notification-errors.js 30
```

## Comandi operativi VPS

Aggiornare branch e rebuild:

```bash
cd /opt/horygon-crm
git pull origin codex/sdi-diagnostics
docker compose up -d --build
```

Popolare anagrafiche test:

```bash
docker compose exec horygon-crm node scripts/seed-sdi-test-recipients.js
```

Popolare sei fatture test:

```bash
docker compose exec horygon-crm node scripts/seed-sdi-test-invoices.js
```

Inviare batch fatture test a SdI TEST:

```bash
docker compose exec horygon-crm node scripts/transmit-sdi-test-invoices.js
```

Leggere ultimi errori SdI:

```bash
docker compose exec horygon-crm node scripts/inspect-sdi-notification-errors.js 30
```

Seguire log container:

```bash
docker compose logs -f horygon-crm
```

Seguire log Nginx endpoint SdI:

```bash
tail -f /var/log/nginx/sdi_access.log
tail -f /var/log/nginx/sdi_error.log
```

## Bottoni UI

In `Fatture attive`:

- `Genera XML TEST`: genera solo XML e crea un flusso locale `sdi.test-send`.
- `Invia a SdI TEST`: genera XML e lo trasmette realmente a SdI TEST, creando log `sdi.test-transmit`.

In `Fatture passive`:

- `Accetta SdI TEST`: genera `NotificaEsitoCommittente` con `EC01` e la invia a `SdIRiceviNotifica` in ambiente TEST.
- `Rifiuta SdI TEST`: genera `NotificaEsitoCommittente` con `EC02` e la invia a `SdIRiceviNotifica` in ambiente TEST.

Nota: i log `sdi.test-send` non dimostrano invio a SdI. Per far avanzare il portale interoperabilita servono invii `sdi.test-transmit` e successive callback `sdi.ws.inbound`.

Nota: l'esito committente e previsto per fatture PA `FPA12` ricevute dallo SdI. Il CRM usa l'`IdentificativoSdI` ricevuto nel wrapper `RicezioneFatture`, non il `ProgressivoInvio` interno alla fattura.

## Tabelle principali

Gia presenti:

- `fatture_sdi_flussi`
- `fatture_sdi_notifiche`
- `sdi_schema_registry`

Campi importanti:

- `fatture_sdi_flussi.nome_file`
- `fatture_sdi_flussi.identificativo_sdi`
- `fatture_sdi_flussi.stato`
- `fatture_sdi_flussi.esito_codice`
- `fatture_sdi_flussi.esito_descrizione`
- `fatture_sdi_flussi.xml_path`
- `fatture_sdi_flussi.response_path`
- `fatture_sdi_notifiche.tipo_notifica`
- `fatture_sdi_notifiche.stato_normalizzato`
- `fatture_sdi_notifiche.codice`
- `fatture_sdi_notifiche.descrizione`
- `fatture_sdi_notifiche.xml_path`

## Contratti SOAP locali

Versionati nel repository:

- `resources/sdi/wsdl/SdIRiceviFile_v1.0.wsdl`
- `resources/sdi/wsdl/TrasmissioneFatture_v1.1.wsdl`
- `resources/sdi/wsdl/RicezioneFatture_v1.0.wsdl`
- `resources/sdi/wsdl/SdIRiceviNotifica_v1.0.wsdl`
- `resources/sdi/xsd/TrasmissioneTypes_v1.0.xsd`
- `resources/sdi/xsd/TrasmissioneTypes_v1.1.xsd`
- `resources/sdi/xsd/RicezioneTypes_v1.0.xsd`

## Matrice operazioni inbound

### TrasmissioneFatture

Namespace:

- `http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0/types`

Operazioni one-way:

- `RicevutaConsegna` / `ricevutaConsegna`
- `NotificaMancataConsegna` / `notificaMancataConsegna`
- `NotificaScarto` / `notificaScarto`
- `NotificaEsito` / `notificaEsito`
- `NotificaDecorrenzaTermini` / `notificaDecorrenzaTermini`
- `AttestazioneTrasmissioneFattura` / `attestazioneTrasmissioneFattura`

Risposta corretta:

- HTTP `200`
- body vuoto

Non restituire per queste operazioni:

- JSON
- HTML
- SOAP response
- `ER01`

### RicezioneFatture

Namespace:

- `http://www.fatturapa.gov.it/sdi/ws/ricezione/v1.0/types`

Operazioni:

- `RiceviFatture`: request-response, risposta SOAP `rispostaRiceviFatture/Esito=ER01`.
- `NotificaDecorrenzaTermini`: one-way, HTTP 200 body vuoto.

Attenzione: `TrasmissioneFatture/NotificaDecorrenzaTermini` e `RicezioneFatture/NotificaDecorrenzaTermini` hanno lo stesso localName ma sono operazioni diverse, distinte da namespace e SOAPAction.

## Requisiti allegato

Dal memo operativo del 2026-08-06 risultano implementati:

- Gestire risposta `ES01` come accettata.
- Gestire risposta `ES00` con `ScartoEsito` decodificato e codici `EN00`/`EN01`.
- Gestire risposta `ES02` come retryable.
- Aggiungere supporto e test MTOM inbound dove il nodo `File` contiene `xop:Include`.
- Salvare separatamente stato lato trasmittente e stato lato ricevente.

Restano da completare/verificare:

- Aggiungere fixture per tutte le operazioni one-way.
- Produrre tabella finale dei test con fattura, file, IdentificativoSdI, codice destinatario, operazione attesa, endpoint, data invio, data callback, HTTP restituito ed esito portale.

## Lezioni imparate

- Non usare path Windows nel container: dentro Docker i certificati devono stare sotto `/run/sdi-certs`.
- Non pushare certificati, CSR private o key su GitHub.
- Per `sdi.horygon.it` usare DNS only su Cloudflare.
- Per Nginx il certificato server deve essere in formato PEM.
- Il canale SdI puo rispondere con errori generici Axis2; spesso la causa reale e un dettaglio XSD o di nome file.
- Un `HTTP 200` su `SdIRiceviFile` dimostra che SdI ha preso in carico il file, non che la fattura e stata consegnata.
- Una notifica di scarto dimostra che il canale callback funziona, ma non sostituisce ricevuta di consegna o mancata consegna.
- Per debug reale degli scarti bisogna guardare codice e descrizione dentro la notifica fiscale decodificata, non solo l'operazione SOAP.
