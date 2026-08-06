# Piano Implementazione SDI nel CRM HORYGON

## Obiettivo

Integrare nel CRM HORYGON le funzioni necessarie per:

- ricevere e archiviare fatture elettroniche ricevute tramite SDI;
- generare fatture elettroniche XML a partire dagli ordini evasi;
- inviare le fatture elettroniche al Sistema di Interscambio tramite canale WS;
- monitorare esiti, notifiche, consegne, scarti e stati del flusso.

Questo documento serve a evitare errori di analisi, sviluppo e go-live.

## Fonti da considerare vincolanti

### 1. Documentazione ufficiale SDI

- Guida operativa del Sistema di Accreditamento:
  [Sistema Accreditamento Guida operativa_v2.pdf](</C:/Users/lelef/Documents/HORYGON/sdi-certs/csr/Sistema Accreditamento Guida operativa_v2.pdf>)
- Portale Sistema di Accreditamento:
  [accreditamento.fatturapa.gov.it](https://accreditamento.fatturapa.gov.it/)
- Guida Agenzia Entrate sulla fatturazione elettronica:
  [fatturazione elettronica](https://www1.agenziaentrate.gov.it/web_app_entrate/fatturazione_elettronica.html/images/icons/backtotop.svg)
- Monitoraggio ricevute:
  [monitoraggio file trasmessi](https://ivaservizi.agenziaentrate.gov.it/ser/monitoraggio/?v=1763650709656)

### 2. Documentazione tecnica da reperire e versionare in progetto

- Specifiche tecniche FatturaPA attualmente valide.
- XSD ufficiale FatturaPA attualmente valido.
- Rappresentazione tabellare del tracciato.
- Elenco controlli SDI.
- WSDL, endpoint, accordo di servizio e documentazione WS del sistema satellite SDI.
- Eventuale documentazione dei servizi massivi, se saranno usati.

## Cosa conferma la guida del Sistema di Accreditamento

Dal PDF ufficiale emergono questi punti chiave:

- il canale `WS` richiede certificati `Client` e `Server`;
- prima del passaggio in produzione servono:
  - dati anagrafici completi;
  - endpoint di test e produzione;
  - test di interoperabilita';
  - presa visione dell'accordo di servizio;
- il canale `WS` gestisce separatamente `Ricezione` e `Trasmissione`;
- i `Codici destinatario B2B` sono gestibili solo quando la ricezione e' in produzione;
- esiste la funzione `Gestione Servizi Massivi` per scarico massivo file su intervallo temporale e una o piu' Partite IVA;
- la modifica degli endpoint di ricezione ha effetto immediato sul flusso B2B/B2C.

Implicazione pratica:

- non basta produrre XML validi;
- il CRM dovra' essere progettato come sistema che gestisce endpoint, stati canale, notifiche e flussi SDI.

## Stato attuale del CRM

### Gia presente

- anagrafiche con dati fiscali base;
- ordini di vendita e acquisto;
- DDT;
- fatture con righe e riepilogo IVA;
- import fatture da XML FatturaPA;
- import fatture da spreadsheet;
- collegamenti logici tra ordini, DDT, fatture, spedizioni e proforme.

### Note tecniche gia visibili nel codice

- gli ordini di vendita scaricano la giacenza di magazzino;
- le fatture sono gia memorizzate con:
  - `tipo`;
  - `direzione`;
  - `tipo_documento`;
  - `partita_iva`;
  - `codice_fiscale`;
  - `stato`;
  - `stato_pagamento`;
  - `sdi_id`;
  - `xml_path`;
  - `hash_documento`;
  - `riepilogo IVA`;
- l'import XML lato backend usa gia una prima lettura della FatturaPA.

### Mancanze principali

- generazione XML FatturaPA in uscita;
- invio WS verso SDI;
- ricezione automatica WS di fatture/notifiche;
- gestione esiti SDI;
- mapping fiscale completo ordine -> fattura elettronica;
- validazione XSD + controlli SDI prima dell'invio;
- gestione anagrafica del canale e dei codici destinatario.

## Requisiti funzionali da bloccare prima dello sviluppo

### 1. Ricezione fatture

Decidere se il CRM deve:

- ricevere direttamente le fatture dal canale WS di ricezione;
- usare anche o invece i servizi massivi per scarico storico o recuperi;
- importare anche le notifiche SDI collegate ai file ricevuti.

Output atteso:

- registrazione automatica fattura passiva;
- salvataggio XML originale;
- eventuale generazione PDF leggibile;
- riconciliazione con fornitore, ordine, DDT e pagamento;
- log tecnico dell'evento SDI.

### 2. Generazione fatture da ordini evasi

Decidere:

- quando un ordine e' considerato `evaso`;
- se la fattura nasce da ordine, da DDT o da aggregazione di piu' DDT;
- se supportiamo solo fattura ordinaria o anche:
  - nota di credito;
  - nota di debito;
  - autofattura;
  - integrazione estero;
- gestione numerazione fatture;
- gestione bollo, ritenute, casse previdenziali, split payment, reverse charge.

### 3. Invio al Sistema di Interscambio

Decidere:

- se l'invio parte automaticamente o richiede approvazione utente;
- chi puo' inviare;
- come gestire reinvio dopo scarto;
- cosa succede se il file e' formalmente valido ma il cliente ha dati telematici incompleti.

## Requisiti anagrafici minimi nel CRM

Per ogni cliente da fatturare il CRM deve poter gestire almeno:

- ragione sociale o nominativo;
- partita IVA;
- codice fiscale;
- paese;
- indirizzo completo;
- CAP;
- comune;
- provincia;
- regime soggetto;
- PEC destinatario;
- codice destinatario SDI;
- flag consumatore finale;
- flag PA;
- codice univoco ufficio per PA, se rilevante;
- condizioni di pagamento;
- esigibilita' IVA e natura IVA, se necessarie.

Regole minime:

- `PEC` e `Codice Destinatario` non devono essere campi liberi non validati;
- deve esistere una regola chiara di precedenza:
  - codice destinatario;
  - PEC;
  - `0000000`;
- per i clienti PA serve anche il legame con IPA e regole B2G.

## Mapping minimo Ordine -> Fattura elettronica

Questo mapping va confermato col commercialista prima di sviluppare.

### Testata documento

- `ordini.codice_ordine` -> riferimento documento origine, non numero fattura finale;
- numerazione fattura -> nuovo contatore dedicato;
- `ordini.data_ordine` o data evasione -> data documento, da definire;
- `anagrafica cliente` -> cessionario/committente;
- dati HORYGON -> cedente/prestatore;
- `valuta` -> default `EUR`, ma da gestire in modo esplicito;
- `note` -> causale o note documento solo se fiscalmente corretto.

### Righe

- `ordini_righe.prodotto_id` -> solo supporto interno, non deve essere il driver dell'XML;
- `descrizione` -> descrizione fiscale vendibile;
- `quantita`;
- `prezzo_unitario`;
- `sconto`;
- `aliquota_iva`;
- `natura_iva`, se non imponibile/esente/FC;
- `totale_riga`.

### Totali

- imponibile;
- imposta;
- riepilogo IVA per aliquota/natura;
- totale documento;
- bollo, se dovuto;
- arrotondamenti, se presenti.

## Validazioni obbligatorie prima dell'invio

Prima di inviare qualunque XML il CRM deve eseguire:

- validazione XSD;
- controlli sintattici propri del file;
- controlli funzionali SDI replicabili localmente;
- controlli di coerenza numerica:
  - somma righe;
  - imponibili;
  - imposte;
  - riepiloghi IVA;
  - totale documento;
- controlli anagrafici:
  - partita IVA;
  - codice fiscale;
  - codice destinatario;
  - PEC;
  - paese identificativo fiscale;
- verifica univocita' del file e della fattura per evitare duplicati.

Senza questo layer si finira' a debuggare sugli scarti SDI, che e' il modo piu' costoso di lavorare.

## Stati applicativi da introdurre

Serve una state machine distinta da `stato pagamento`.

### Stati fattura elettronica in uscita

- `bozza`;
- `da_validare`;
- `validata`;
- `pronta_per_invio`;
- `inviata_a_sdi`;
- `consegnata`;
- `impossibilita_consegna`;
- `scartata`;
- `accettata_pa`, se usata logica PA;
- `rifiutata_pa`, se usata logica PA;
- `sostituita`;
- `annullata`.

### Stati fattura ricevuta

- `ricevuta_da_sdi`;
- `importata`;
- `da_collegare`;
- `collegata_a_ordine`;
- `collegata_a_ddt`;
- `in_verifica`;
- `registrata`;
- `pagata`.

## Tabelle e campi da prevedere

Conviene introdurre una tabella tecnica dedicata ai flussi SDI, separata dalla sola tabella `fatture`.

### Esempio minimo

`fatture_sdi_flussi`

- `id`
- `fattura_id`
- `direzione` (`outbound`, `inbound`)
- `tipo_messaggio`
- `identificativo_sdi`
- `nome_file`
- `hash_file`
- `stato_sdi`
- `esito_codice`
- `esito_descrizione`
- `xml_path`
- `pdf_path`
- `raw_payload_path`
- `ricevuto_il`
- `inviato_il`
- `ultimo_evento_il`
- `meta_json`

`fatture_sdi_notifiche`

- `id`
- `flusso_id`
- `tipo_notifica`
- `codice`
- `descrizione`
- `xml_path`
- `creato_il`

`settings` o tabella dedicata canale

- endpoint test ricezione
- endpoint test trasmissione
- endpoint produzione ricezione
- endpoint produzione trasmissione
- path certificato client
- path certificato server
- path chiave privata
- path CA
- modalita' test/produzione
- attivazione servizi massivi

## Architettura suggerita

### Modulo 1. Generatore XML

Responsabile di:

- costruire il documento FatturaPA da dati CRM;
- calcolare riepiloghi e totali;
- assegnare nome file;
- produrre XML firmato o non firmato, secondo regole del canale.

### Modulo 2. Validatore

Responsabile di:

- validare contro XSD;
- eseguire controlli applicativi locali;
- bloccare l'invio in caso di incoerenze.

### Modulo 3. Trasmettitore WS

Responsabile di:

- invio a SDI;
- tracciamento richiesta;
- gestione autenticazione TLS/certificati;
- log tecnico;
- retry controllati.

### Modulo 4. Ricevitore WS

Responsabile di:

- esporre endpoint ricezione;
- ricevere fatture/notifiche/ricevute;
- archiviare XML originali;
- aprire flussi di import e riconciliazione.

### Modulo 5. Riconciliazione

Responsabile di:

- collegare fatture ricevute a fornitore, ordine, DDT, spedizione;
- proporre suggerimenti automatici;
- lasciare conferma umana in caso di ambiguita'.

## Rischi principali da coprire

- uso di campi CRM non abbastanza fiscali per l'XML;
- codici destinatario e PEC non puliti;
- ordine evaso non sufficiente da solo a generare una fattura corretta;
- errori di arrotondamento su IVA e riepiloghi;
- mancanza di separazione tra stato amministrativo e stato SDI;
- dipendenza da portale per recuperare manualmente i problemi;
- certificati scaduti o ruotati senza aggiornamento del server;
- endpoint modificati in produzione senza governo del change.

## Piano di implementazione consigliato

### Fase 1. Preparazione documentale

- raccogliere e salvare nel repo i documenti ufficiali mancanti;
- scaricare accordo di servizio quando disponibile;
- definire con il commercialista i casi fiscali da supportare;
- congelare il mapping dati.

### Fase 2. Hardening dati CRM

- obbligatorieta' e validazione campi fiscali anagrafiche;
- validazione codici destinatario e PEC;
- revisione dei dati ordine/righe per renderli fatturabili.

### Fase 3. Generazione XML offline

- generare XML da ordine evaso senza invio;
- validazione XSD;
- test su casi reali;
- esportazione manuale XML/PDF per verifica.

### Fase 4. Invio WS

- configurazione certificati ed endpoint;
- invio ambiente test;
- gestione ricevute e scarti;
- superamento test interoperabilita'.

### Fase 5. Ricezione WS

- endpoint ricezione;
- import automatico file ricevuti;
- archiviazione e riconciliazione.

### Fase 6. Produzione

- presa visione accordo di servizio;
- richiesta passaggio in produzione;
- monitoraggio;
- gestione incidenti e rotazione certificati.

## Decisioni da prendere subito

1. La fonte primaria delle fatture emesse sara' il CRM oppure un sistema esterno/commercialista?
2. L'emissione automatica parte da `ordine evaso` o da `DDT evaso`?
3. Il CRM deve coprire da subito solo B2B/B2C oppure anche B2G?
4. Volete usare solo il canale WS oppure prevedere anche servizi massivi?
5. Chi valida il mapping fiscale finale: commercialista interno o consulente esterno?

## Prossima attivita' consigliata nel repo

- creare un modulo `fatturazione elettronica` separato dalla gestione fatture generiche;
- aggiungere tabella flussi SDI e notifiche;
- aggiungere `export XML da ordine`;
- aggiungere `validazione pre-invio`;
- aggiungere pagina impostazioni canale WS;
- aggiungere log tecnico SDI.
