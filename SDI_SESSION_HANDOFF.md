# Passaggio di consegne — integrazione SdI

Ultimo aggiornamento: 2026-08-07, fine sessione.

Questo file serve a riprendere il lavoro in una sessione nuova senza rileggere
tutto. Il riferimento completo resta `SDI_INTEGRATION_OVERVIEW.md`: qui c'e' solo
cio' che non e' deducibile dal repository.

## Da leggere per primi

1. `SDI_INTEGRATION_OVERVIEW.md` — stato reale, blocchi, sequenza di go-live,
   trappole dell'ambiente (§8). E' la fonte di verita'.
2. Questo file, per lo stato del deploy e i lavori aperti.

## Stato del codice

Branch `codex/sdi-diagnostics`, ultimo commit `2233465`. **145 test, tutti
verdi** (`npm test`).

Moduli SdI aggiunti in questa sessione:

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

**Il VPS e' fermo al commit `11ebf49`.** Mancano gli ultimi due, cioe' tutto il
ciclo di firma esterna:

```bash
cd /opt/horygon-crm && git pull && docker compose up -d --build
```

Gia' attivo sul VPS: canale in produzione, Servizi Massivi abilitati, mTLS su
entrambi gli strati (`ssl_verify_client on` piu' `client_cert_policy = enforce`),
porta del container su `127.0.0.1:8443`, indice univoco sui nomi file.

`sdi.mode` e' ancora `test`: nessun invio reale e' possibile finche' non viene
cambiato di proposito.

## Lavori aperti, in ordine

1. **Interfaccia del ciclo di firma esterna.** Le rotte esistono
   (`GET /api/sdi/flussi/:id/xml-da-firmare`, `POST /api/sdi/flussi/:id/firma`)
   ma non c'e' UI: oggi il ciclo e' usabile solo via API. Serve: stato della
   firma sulla fattura, pulsante di download, upload del `.p7m`, esito della
   verifica con nome del firmatario, poi invio.
2. **Firma esterna per le richieste SMTS.** `sdi-massive-request.js` prevede
   solo `signMassiveRequest` in locale. Va aggiunto il ramo esterno, che riusa
   gli stessi mattoni di `sdi-firma-esterna.js`. Senza, lo Scarico Fatture
   attivato il 07.08 resta inutilizzabile.
3. **Orchestratore del backfill**: archivio ZIP, estrazione, import documento per
   documento, report e dry-run end-to-end. I mattoni ci sono tutti
   (`SafeZipReader`, `sdi-import-pipeline`, `sdi-historical-sync`), manca la
   funzione che li lega e la rotta.
4. Import automatico delle passive firmate `.p7m` dal canale realtime: oggi
   vengono archiviate ma non importate, e il CRM risponde comunque `ER01`.
5. Client di quadratura e reinoltro: **bloccato**, mancano tre WSDL da recuperare
   dal Sistema di Accreditamento
   (`SdIQuadraturaWSFlussoRicezioneReport_v1.0.wsdl`,
   `SdIQuadraturaWSFlussoTrasmissioneReport_v1.0.wsdl`,
   `SdIQuadraturaWSFlussoTrasmissioneReinoltro_v1.0.wsdl`).
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
