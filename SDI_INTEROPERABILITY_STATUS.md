# Stato interoperabilita SDICoop HORYGON

Ultimo aggiornamento: 2026-08-06

Questo documento raccoglie lo stato operativo dell'integrazione SdI nel CRM HORYGON, le cose gia funzionanti, le configurazioni note e le lezioni apprese durante il test di accreditamento WS.

## Stato accreditamento

Gia superati sul portale SdI:

- Ricezione Fattura.
- Ricevuta Consegna.
- Notifica Scarto.
- Notifica Mancata Consegna B2G / Ricevuta Impossibilita Recapito B2B/B2C.
- Notifica di esito da PA.

Ancora da completare:

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
- Verifica reale sul portale degli step PA con invio `EC02` e casi di scarto esito.
- Scenario di mancata consegna / impossibilita recapito.
- Decorrenza termini e attestazione, che dipendono dai tempi/stati del simulatore SdI.

## Checkpoint portale 2026-08-06 21:11 CEST

Test obbligatori:

- `Ricezione Fattura`: OK dal `2026-08-06 16:53:05`.
- `Ricevuta consegna`: OK dal `2026-08-06 21:07:52`.
- `Notifica mancata consegna (B2G) / Notifica impossibilita recapito (B2B, B2C)`: KO.
- `Notifica scarto (B2G) / Ricevuta scarto (B2B, B2C)`: OK dal `2026-08-06 18:52:09`.

Ulteriori test FatturaPA:

- `Notifica di esito da PA`: OK dal `2026-08-06 21:11:03`.
- `Notifica di Scarto esito a PA`: KO.
- `Notifica Decorrenza Termini a PA`: KO.
- `Notifica esito a Operatore Economico`: KO.
- `Notifica Decorrenza Termini a Operatore Economico`: KO.
- `Attestazione avvenuta trasmissione`: KO.

## Checkpoint portale 2026-08-06 22:53 CEST

Test obbligatori superati:

- `Ricezione Fattura`: OK dal `2026-08-06 16:53:05`.
- `Ricevuta consegna`: OK dal `2026-08-06 21:07:52`.
- `Notifica mancata consegna (B2G) / Notifica impossibilita recapito (B2B, B2C)`: OK dal `2026-08-06 22:53:35`.
- `Notifica scarto (B2G) / Ricevuta scarto (B2B, B2C)`: OK dal `2026-08-06 18:52:09`.

Ulteriori test FatturaPA:

- `Notifica di esito da PA`: OK dal `2026-08-06 21:11:03`.
- `Notifica di Scarto esito a PA`: KO.
- `Notifica Decorrenza Termini a PA`: KO.
- `Notifica esito a Operatore Economico`: KO.
- `Notifica Decorrenza Termini a Operatore Economico`: KO.
- `Attestazione avvenuta trasmissione`: KO.

Nota: dopo questo checkpoint non ripetere i test obbligatori gia OK salvo regressioni. Concentrarsi sui test FatturaPA facoltativi/residui e sulla preparazione del flusso CRM reale.

Flussi reali confermati:

- Fattura PA ricevuta dal simulatore: `IT03365990591_00011.xml`, `IdentificativoSdI 32477881`, importata nel CRM come fattura passiva `id 12`, numero `ESOJKL-00011-1`.
- Esito committente PA accettato: `IT03365990591_00011_EC_001.xml`, endpoint `https://testservizi.fatturapa.it/ricevi_notifica`, risposta `ES01`, HTTP `200`.
- Fattura B2B inviata dal CRM: `IT03365990591_8H008.xml`, `IdentificativoSdI 32477911`, risposta `SdIRiceviFile` HTTP `200`.
- Ricevuta consegna B2B ricevuta: `IT03365990591_8H008_RC_002.xml`, `IdentificativoSdI 32477911`, stato CRM `consegnata`.

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

Invio B2B che ha superato la ricevuta consegna:

- File: `IT03365990591_8H008.xml`
- Identificativo SdI: `32477911`
- Cliente test: `UMZGLCP`
- Callback ricevuta: `RicevutaConsegna`
- File callback: `IT03365990591_8H008_RC_002.xml`
- Stato CRM: `consegnata`

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

Errore risolto:

- `RicevutaScarto` codice `00001`: `Nome file non valido`.

Causa:

- Il nome file usava un progressivo fino a 10 caratteri, ad esempio `IT03365990591_SHUSSCN008.xml`, non accettato dal piano test SdI.

Correzione:

- Il nome file usa ora un progressivo a 5 caratteri alfanumerici, ad esempio `IT03365990591_8H008.xml`.

Errore risolto:

- `RicevutaScarto` codice `00324`: `1.4.1.1 <IdFiscaleIVA> e 1.4.1.2 <CodiceFiscale> non coerenti : 01043931003 - 01043931003`.

Causa:

- Per i destinatari test B2B il CRM valorizzava sia `IdFiscaleIVA` sia `CodiceFiscale` con lo stesso valore numerico fittizio.

Correzione:

- Se il codice fiscale cliente coincide con la partita IVA, viene omesso dal `CessionarioCommittente`. Il `CodiceFiscale` resta valorizzato se e' davvero diverso, ad esempio codice fiscale persona fisica.

Errore risolto:

- `customerVat is not defined` durante `sdi.test-send` / `sdi.test-transmit`.

Causa:

- Variabile calcolata in `loadRecipientProfile` ma usata in `buildInvoicePayload`.

Correzione:

- `customerVat` viene calcolato nello scope locale di `buildInvoicePayload` e coperto da test automatico.

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

### Ricezione RicevutaConsegna

Funziona:

- SdI chiama il nostro endpoint con operazione `TrasmissioneFatture/ricevutaConsegna`.
- Il CRM decodifica il campo `File`.
- Il CRM collega la ricevuta al flusso in uscita tramite `IdentificativoSdI` / `NomeFile`.
- Il CRM aggiorna il flusso a `consegnata`.
- Il CRM risponde `HTTP 200` con body vuoto.
- Il portale SdI ha marcato "Ricevuta consegna" come OK.

Caso confermato:

- `IdentificativoSdI`: `32477911`
- Fattura: `IT03365990591_8H008.xml`
- Ricevuta: `IT03365990591_8H008_RC_002.xml`

### Progressivo invio

Errore risolto:

- Piu fatture generate nello stesso minuto avevano lo stesso nome file, ad esempio `IT03365990591_2608061723.xml`.

Causa:

- `ProgressivoInvio` era basato su timestamp tagliato ai minuti.

Correzione:

- `ProgressivoInvio` ora usa una componente alfanumerica basata su `Date.now()` piu id fattura, entro 10 caratteri.
- I file generati sono univoci anche in batch.

Esempio:

- `IT03365990591_8H008.xml`

Nota:

- Il `ProgressivoInvio` nel tracciato XML puo arrivare fino a 10 caratteri.
- Il progressivo usato nel nome file e' limitato a 5 caratteri alfanumerici per compatibilita con i test SdI.

### Invio NotificaEsitoCommittente a SdI TEST

Funziona:

- Il CRM genera `NotificaEsitoCommittente` con `EC01` o `EC02`.
- Il CRM usa il servizio `SdIRiceviNotifica/NotificaEsito` su `https://testservizi.fatturapa.it/ricevi_notifica`.
- Il CRM usa l'`IdentificativoSdI` ricevuto nel wrapper `RicezioneFatture`.
- Il CRM genera nome file esito nel formato `<NomeFileFattura>_EC_001.xml`.
- Il CRM interpreta le risposte `ES01`, `ES00`, `ES02`.

Caso confermato:

- Fattura PA ricevuta: `IT03365990591_00011.xml`
- Identificativo SdI: `32477881`
- Fattura CRM: `id 12`, numero `ESOJKL-00011-1`
- Esito inviato: `EC01`
- File esito: `IT03365990591_00011_EC_001.xml`
- Risposta SdI: `ES01`
- HTTP: `200 OK`
- Portale: `Notifica di esito da PA` OK.

## Cosa non funziona ancora

I test obbligatori del canale sono OK. Resta da completare la parte FatturaPA opzionale/residua e il flusso applicativo CRM:

- Scenario `Notifica di Scarto esito a PA`, probabilmente inviando un esito committente non accettabile o duplicato secondo piano test.
- Scenario `Notifica Decorrenza Termini a PA`.
- Scenario `Notifica esito a Operatore Economico`.
- Scenario `Notifica Decorrenza Termini a Operatore Economico`.
- Scenario `Attestazione avvenuta trasmissione`.

## Prossimi lavori CRM dopo accreditamento

Obiettivi funzionali da implementare prima della produzione:

- Azzerare in modo sicuro i dati di test SdI e le fatture demo senza cancellare configurazioni, utenti, anagrafiche reali, certificati, impostazioni aziendali e registri schema.
- Importare fatture storiche da XML esportati da cassetto fiscale/portale, mantenendo XML originale, hash SHA-256, metadati SdI, numero, data, soggetto, righe, riepiloghi IVA e stato.
- Ricostruire la numerazione fatture attive gia emesse prima di generare nuove fatture dal CRM.
- Generare nuove fatture elettroniche da ordini evasi, con bozza, validazione XSD/applicativa, anteprima XML, invio SdI TEST/PROD controllato e blocco immutabile dell'XML inviato.
- Sincronizzare automaticamente nuove fatture passive e notifiche ricevute via endpoint SdI, evitando duplicati tramite hash, nome file e IdentificativoSdI.
- Separare chiaramente modalita `test` e `production`; nessun invio PROD deve essere possibile senza conferma e configurazione produzione completata.

Regola operativa per reset:

- Preparare uno script dedicato e reversibile per pulizia ambiente test, con dry-run obbligatorio e backup database prima dell'esecuzione.
- Non usare cancellazioni manuali estese su tabelle SdI/fatture senza backup.

Attenzione PA outbound:

- Gli invii PA dal CRM senza firma vengono scartati con codice `00102`: `File non integro (firma non valida) : Il file non risulta firmato`.
- Per i test obbligatori B2B non serve firma.
- Per completare i test PA outbound potrebbe servire implementare firma XAdES/CAdES o usare scenari del simulatore che non richiedono trasmissione PA firmata dal CRM.

## Piano residuo implementato nel CRM

Dispatcher da verificare prima dei nuovi invii:

- `trasmissione|NotificaMancataConsegna`
- `trasmissione|NotificaDecorrenzaTermini`
- `trasmissione|AttestazioneTrasmissioneFattura`
- `ricezione|NotificaDecorrenzaTermini`

Il dispatcher usa contratto/namespace, SOAPAction e operation localName. Questo evita di confondere:

- `RicezioneFatture/NotificaDecorrenzaTermini`
- `TrasmissioneFatture/NotificaDecorrenzaTermini`

Codici speciali dal `piano_test_interoperabilita_SDICoop.pdf` locale:

- `XS0000`: B2G/PA per canale inesistente, mancata consegna e attestazione.
- `XS00001`: B2B/B2C per canale inesistente, impossibilita di recapito.

Nota: il PDF locale non riporta `WS0001`; se un piano storico lo riporta, usarlo solo per quel piano specifico.

Script aggiunti:

```bash
docker compose exec -T horygon-crm node scripts/seed-sdi-interoperability-invoices.js
docker compose exec -T horygon-crm node scripts/transmit-sdi-interoperability-invoice.js TEST-MC-001
docker compose exec -T horygon-crm node scripts/send-sdi-invalid-customer-outcome.js <fatturaId-o-numero> EC99
docker compose exec -T horygon-crm node scripts/send-sdi-valid-customer-outcome.js <fatturaId-o-numero> EC01
```

Fatture dedicate create dallo script:

- `TEST-MC-001`: B2B/B2C verso `XS00001`, atteso `RicevutaImpossibilitaRecapito`.
- `TEST-MC-B2C-0000000`: B2C FPR12 verso `0000000` senza `PECDestinatario`, atteso `RicevutaImpossibilitaRecapito`.
- `TEST-DT-001`: PA verso `ESOJKL`, atteso `NotificaDecorrenzaTermini`; dopo la ricezione non inviare `EC01` o `EC02`.
- `TEST-NE-001`: PA verso `VRRMFL`, atteso `NotificaEsito` all'operatore economico dopo invio `EC01`.
- `TEST-AT-001`: PA verso `XS0000`, atteso `NotificaMancataConsegna` e `AttestazioneTrasmissioneFattura`; richiede fattura FPA12 firmata.

Per `Scarto esito PA`:

- usare una fattura PA ricevuta nuova e non ancora esitata;
- inviare `EC99` con `scripts/send-sdi-invalid-customer-outcome.js`;
- il client `SdIRiceviNotifica` non considera `HTTP 200` come successo automatico;
- vengono gestiti `ES01`, `ES00`, `ES02`;
- in caso `ES00`, viene decodificato e salvato `ScartoEsito/File` e viene estratto `EN00` o `EN01`.

Registro interoperabilita:

- tabella `sdi_interoperability_tests`;
- registra nome test, fattura, flusso, nome file, progressivo, codice destinatario, identificativo SdI, data invio, callback atteso/ricevuto, SOAPAction, content-type, MTOM, HTTP restituito, stato portale, metadati.
- per `NotificaDecorrenzaTermini` registra eventi distinti con `flowSide=ricezione` e `flowSide=trasmissione`, per evitare che i due callback si sovrascrivano.

Sequenza residua consigliata:

- `Scarto esito PA`: usare una fattura PA ricevuta nuova e inviare `EC99` con `send-sdi-invalid-customer-outcome.js`; il test vale solo con risposta `ES00` e `ScartoEsito` decodificato con `EN00` o `EN01`.
- `Notifica esito a Operatore Economico`: inviare `TEST-NE-001`, attendere import PA via RiceviFatture, inviare `EC01` con `send-sdi-valid-customer-outcome.js`, poi attendere callback `TrasmissioneFatture/NotificaEsito`.
- `Decorrenze termini`: inviare `TEST-DT-001`, attendere RiceviFatture/ER01 e non inviare alcun EC; attendere due callback distinti `RicezioneFatture/NotificaDecorrenzaTermini` e `TrasmissioneFatture/NotificaDecorrenzaTermini`.
- `Attestazione avvenuta trasmissione`: inviare `TEST-AT-001` FPA12 firmata verso `XS0000`; senza firma gli invii PA possono essere scartati con `00102`.

Limite ancora aperto:

- la firma FPA12 per i test PA outbound non e' ancora automatizzata. Gli invii PA non firmati possono ancora produrre `00102 File non integro`.

Nota dati fiscali per `XS00001`:

- Il codice destinatario `XS00001` simula un canale inesistente, ma SdI continua a validare i dati fiscali del cessionario.
- Un tentativo con P.IVA fittizia `01043931991` ha prodotto `RicevutaScarto 00305`.
- La seed usa quindi P.IVA test gia accettata `IT01043931003`; il CRM omette il `CodiceFiscale` duplicato rispetto alla P.IVA.

Nota `RicevutaImpossibilitaRecapito`:

- L'operazione SOAP esterna resta `TrasmissioneFatture/NotificaMancataConsegna`, ma il file interno B2B/B2C puo avere root `RicevutaImpossibilitaRecapito`.
- Il CRM classifica `NotificaMancataConsegna` come `B2G_MANCATA_CONSEGNA` e `RicevutaImpossibilitaRecapito` come `B2X_IMPOSSIBILITA_RECAPITO`, entrambe con stato `UNDELIVERABLE`.
- I callback one-way rispondono `HTTP 200` con `Content-Length: 0` e body di zero byte.
- Un tentativo B2C con codice fiscale fittizio `RSSMRA80A01H501U` e' arrivato correttamente al CRM ma SdI lo ha scartato con `00306 CodiceFiscale non valido`; la seed usa quindi `01043931003` come codice fiscale numerico test senza valorizzare `IdFiscaleIVA`.
- Per la prova definitiva B2C `0000000`, eseguire la seed con `SDI_TEST_B2C_FISCAL_CODE=<codice_fiscale_reale>`; non versionare CF personali nel repository.
- La validazione locale distingue `xsdValid`, `formalTaxIdValid`, `taxRegistryVerified=false` e `taxRegistryVerificationStatus=NOT_CHECKED`; non verifica l'esistenza in Anagrafe Tributaria.

## Comandi operativi VPS

Aggiornare branch e rebuild:

```bash
cd /opt/horygon-crm
git pull --ff-only origin codex/sdi-diagnostics
docker compose build horygon-crm
docker compose up -d horygon-crm
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

Liberare spazio Docker se la build fallisce con `no space left on device`:

```bash
df -h
df -i
docker system df
docker builder prune -af
docker image prune -af
docker container prune -f
```

Non eseguire `docker volume prune` senza controllo: potrebbe rimuovere volumi dati.

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
