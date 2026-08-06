# SDI SOAP Integration Notes

## Contratti locali

I WSDL/XSD pubblici SdICoop sono versionati in:

- `resources/sdi/wsdl/SdIRiceviFile_v1.0.wsdl`
- `resources/sdi/wsdl/TrasmissioneFatture_v1.1.wsdl`
- `resources/sdi/wsdl/RicezioneFatture_v1.0.wsdl`
- `resources/sdi/wsdl/SdIRiceviNotifica_v1.0.wsdl`
- `resources/sdi/xsd/TrasmissioneTypes_v1.0.xsd`
- `resources/sdi/xsd/TrasmissioneTypes_v1.1.xsd`
- `resources/sdi/xsd/RicezioneTypes_v1.0.xsd`

`sdi-certs/` resta area runtime per certificati, CSR e kit scaricati, ed e ignorata da Git.

## Causa del bug originale

Il CRM riconosceva SOAP usando euristiche su stringhe/prefissi. Con messaggi SdI reali, l'applicazione poteva trattare `Envelope` come payload applicativo, producendo log come:

- `isSoap: false`
- `operationName: Envelope`
- `payloadRootElement: Envelope`

La correzione riconosce SOAP dal namespace dell'envelope, estrae il primo elemento dentro `Body`, usa `localName` come operazione SdI e decodifica separatamente il campo `File` base64.

## Policy risposta inbound

`TrasmissioneFatture_v1.1` gestisce notifiche one-way per fatture inviate:

- `ricevutaConsegna`
- `notificaMancataConsegna`
- `notificaScarto`
- `notificaEsito`
- `notificaDecorrenzaTermini`
- `attestazioneTrasmissioneFattura`

Per queste operazioni il CRM risponde `HTTP 200` con body vuoto.

`RicezioneFatture_v1.0` gestisce fatture passive con `fileSdIConMetadati`. In questo caso il CRM salva fattura e metadati decodificati e risponde SOAP con `rispostaRiceviFatture/Esito=ER01`.

## Invio a SdI

Il client di trasmissione usa:

- endpoint test: `https://testservizi.fatturapa.it/ricevi_file`
- operazione: `RiceviFile`
- SOAPAction: `http://www.fatturapa.it/SdIRiceviFile/RiceviFile`
- certificato/key client configurati in `app_settings`
- messaggio `multipart/related` MTOM/XOP con allegato binario

## Salvataggio inbound

Ogni richiesta inbound viene salvata in:

`uploads/sdi-inbound/YYYY/MM/DD/<requestId>/`

con:

- `sdi-envelope.xml`
- `decoded/<NomeFile>`
- `metadata/<NomeFileMetadati>` se presente
- `manifest.json`

Il manifest contiene request id, namespace, operazione, nome file, hash, stato di processing e dati di correlazione.

## Limiti residui

Il CRM conserva P7M e ZIP originali e ne calcola hash/tipo, ma l'estrazione del contenuto firmato P7M e l'estrazione sicura ZIP sono step successivi. Le notifiche non correlate vengono salvate come `unmatched` e accettate verso SdI per evitare ritrasmissioni causate da problemi interni di correlazione.
