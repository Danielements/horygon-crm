# Merlino press Server 0.9.0

## Architettura
Windows usa esclusivamente il browser. La VM Linux esegue l'interfaccia web, OAuth Gmail, sincronizzazione IMAP, analisi AI, registro ordini/attività e SQLite. Nessun processo Windows deve restare acceso. Un solo processo applicativo con servizi separati nel codice, più Caddy per HTTPS. Il server non include WPF, Playwright o un browser automatico.

Le aree sono Ordini, Attività (anche chiamate/appuntamenti con data e ora), Alert, Contabilità, Logistica. Le colonne e il loro ordine si personalizzano per area e rimangono salvati nel browser. Gli alert sono una vista dei problemi, non nuove copie delle attività. Le modifiche manuali prevalgono sulle successive letture delle email. Una nuova email collegata produce un avviso in Alert, anche su una voce chiusa. Dopo averla verificata, togliere la spunta Aggiornamento email da verificare nel dettaglio. Le copie dello stesso messaggio non riattivano un avviso già verificato. È presente un controllo contro il salvataggio di versioni obsolete.

Il riconoscimento locale ricava numeri ordine e tracking esplicitamente etichettati; non garantisce ogni formato di corriere. Tracking e ordini da email sono da verificare. Un tracking non implica consegna. I riferimenti all'email aprono il messaggio originale nel browser per gli operatori. Un'associazione ambigua tra più ordini richiede intervento manuale. Il connettore di verifica spedizioni di terze parti non è ancora attivato: serve scegliere provider e API key.

## Installazione Linux con Docker Compose
Come punto di partenza dimensionare la VM con 2 vCPU e 4 GB RAM; spazio disco secondo il volume di email e allegati. Non è un dimensionamento misurato su una casella reale. SQLite è per un singolo server, non per più repliche concorrenti. Docker Engine con plugin Compose e Python 3 devono essere disponibili.

1. Copiare ed estrarre il pacchetto sorgente sulla VM, mantenendo tutte le cartelle.
2. Dalla radice: `python3 deploy/setup.py --domain ordini.azienda.it` (sostituire il dominio).
3. Creare il record DNS verso il server. Se dietro router, inoltrare TCP 80 e 443 alla VM. In rete interna usare DNS interno verso la stessa VM. Non esporre 5080.
4. `cd deploy` poi `docker compose --profile https up -d --build`.
5. Aprire `http://ordini.azienda.it`: Caddy reindirizza a HTTPS sulla 443 e gestisce il certificato. Porta 80 è l'ingresso, non trasporta dati autenticati. Il dominio deve essere raggiungibile per la convalida del certificato.
6. Nel file `.env` il valore HORYGON_ADMIN_KEY è il codice operatore, HORYGON_VIEWER_KEY quello di sola lettura. Distribuirli tramite un canale sicuro. I codici sono condivisi per ruolo, non account personali con SSO/MFA. Le sessioni scadono dopo 8 ore e al riavvio server.

Per una prova solo LAN: `python3 deploy/setup.py --lan-http` poi `cd deploy && docker compose up -d --build`; aprire `http://IP-DELLA-VM`. Non inoltrare questa modalità su Internet. Per collegare Gmail sul server occorre comunque configurare il dominio HTTPS e il callback Google; la modalità HTTP è una prova del registro manuale, non del login Google.

## Collegamento Gmail dal browser
In Google Cloud creare un client OAuth di tipo **Applicazione web**, non App desktop. Autorizzare il redirect esatto `https://ordini.azienda.it/oauth/google/callback`. Abilitare/consentire gli scope Gmail IMAP `https://mail.google.com/`, openid, email secondo le policy aziendali. In Horygon → Servizi inserire Client ID e secret, salvare, indicare l'email e premere Accedi con Google. Confermare l'account corretto. I token restano cifrati sul server.

In Servizi si può abilitare il download automatico, che continua sulla VM senza browser aperto. Pausa arresta la lavorazione e disabilita il download automatico anche dopo un riavvio; per riattivarlo usare Servizi. Le analisi AI si avviano soltanto con Analizza, massimo 10 nuove per richiesta. Nessuna analisi parte all'avvio del server o dal timer. L'archivio tiene risultati e ricevute dei tentativi: copie dello stesso Message-ID non generano una nuova analisi. Gli esiti incerti restano bloccati. Impostare provider, endpoint, modello, API key e consenso al trasferimento prima di analizzare.

## Migrazione dell'archivio Windows esistente
Questa operazione si esegue una sola volta: il programma di migrazione non è un client operativo.

1. Chiudere Horygon Windows e conservare una copia della cartella `%LOCALAPPDATA%/Horygon`.
2. Con lo stesso utente Windows che usava Horygon, impostare `HORYGON_MIGRATION_PASSWORD` con una passphrase lunga e temporanea, quindi eseguire `Horygon.Migrate.exe C:\percorso\archivio.horygon`. Il file è cifrato; contiene anche credenziali/token. Non inviare la passphrase insieme al file.
3. Copiare il file sulla VM. Eseguire l'importazione PRIMA di configurare nuove caselle e su archivio posta vuoto. Da deploy: `docker compose stop app`, quindi con HORYGON_MIGRATION_PASSWORD impostata nell'ambiente: `docker compose run --rm -e HORYGON_MIGRATION_PASSWORD -v /percorso/archivio.horygon:/import.horygon:ro app --import /import.horygon`.
4. `docker compose --profile https up -d`. Rimuovere la passphrase dalle variabili della shell. Verificare i conteggi e il registro prima di avviare altre analisi. La prima sincronizzazione deve essere scelta dall'operatore. Le email e le analisi migrano insieme. Un token Google precedente ancora valido può essere rinnovato; per un nuovo collegamento usare il client Web.
5. Le ultime versioni delle regole archiviate vengono ripristinate; controllarle prima di riattivare le analisi.

Non eliminare l'archivio originale prima di avere verificato la migrazione. Un'importazione interrotta va ripristinata su un volume nuovo dal backup, senza unire archivi parziali.

## Gestione e backup
`docker compose logs --tail=100 app` e `docker compose ps` per lo stato. `docker compose --profile https down` arresta senza cancellare i volumi. Non usare `down -v` per aggiornare.
Salvare il volume horygon_data con l'app arrestata e, separatamente, il file `.env`. La chiave HORYGON_DATA_KEY è necessaria a decifrare l'archivio; perderla rende inutilizzabile il backup. Conservare anche caddy_data per i certificati. I record di posta e quelli operativi sono cifrati AES-GCM a riposo, ma nomi tabelle/identificatori e metadati tecnici SQLite non sono cifrati. Proteggere la VM e i backup con i permessi aziendali.
Per cambiare codici di accesso modificare `.env` e ricreare il servizio. NON cambiare HORYGON_DATA_KEY su un archivio esistente.

## Stato della consegna
Il pacchetto è preparato per Linux; compilazione e test applicativi possono essere eseguiti anche su Windows. L'installazione sulla VM, DNS, firewall/router, certificato reale e consenso Google aziendale richiedono l'infrastruttura di destinazione. Nessun accesso Internet viene dichiarato attivo prima del collaudo su quella VM.


Riferimenti tecnici: [OAuth Google per applicazioni web](https://developers.google.com/identity/protocols/oauth2/web-server), [HTTPS automatico e porte di Caddy](https://caddyserver.com/docs/automatic-https).

## Status per smart TV e player
Dalla dashboard operatore aprire **Impostazioni**. Scegliere da 1 a 30 ordini per pagina e copiare il **link permanente** nel browser della TV o nel player. Nessun login periodico: il link resta valido anche al riavvio del server, finché si conserva il database e la chiave di cifratura. Il link è una credenziale di sola lettura: mostra solo numero ordine, nome cliente, titolo/descrizione e stato degli ordini aperti. Non consente accesso a mail, configurazioni o modifiche.

La vista aggiorna i dati ogni 5 secondi, ruota pagina ogni 15 secondi e segnala la perdita di connessione. La quantità per pagina viene salvata sul server e applicata a tutti i monitor. L'accesso operatore continua a scadere dopo 8 ore; l'accesso Status è separato. Non cancellare il frammento dopo `#` quando si configura il player. Per accesso da Internet mantenere HTTPS. La modalità schermo intero e l'avvio automatico del browser si configurano sul player.

## Stampanti e produzione
In **Impostazioni → Stampanti e servizi** inserire il nome della macchina, i servizi associati e l'eventuale indirizzo del servizio (solo anagrafica, senza credenziali). Dal dettaglio di un ordine selezionare la stampante e lo stato produzione: In coda, In lavorazione, Sospeso o Terminato. Una stampante può avere più ordini assegnati ma un solo ordine aperto In lavorazione. Chiudere o sospendere il precedente prima di avviarne un altro.

La pagina **Stampanti** mostra gli ordini assegnati a ciascuna macchina e i servizi associati. Il tabellone Status TV mostra nome stampante e stato produzione. Questi dati sono inseriti manualmente: non attestano che il dispositivo sia connesso o stia fisicamente stampando. Telemetria e rilevamento automatico richiedono marca/modello e API del servizio reale; nessun comando di stampa viene inviato.

### Gestione anagrafica e test
La sezione Impostazioni consente creazione, lettura, modifica e rimozione delle stampanti. Per rimuovere una macchina occorre prima togliere tutte le assegnazioni, anche dagli ordini chiusi, per non perdere riferimenti. Il test apre soltanto connessioni TCP sulle porte configurate, dal server Linux e con timeout di 3 secondi; nessun documento o comando di stampa viene trasmesso. Gli esiti sono salvati con data e visibili nella pagina Stampanti. Una porta aperta non certifica il protocollo né l'identità o lo stato fisico della macchina. Indicare anche il controller (Fiery, TotalFlow, controller Konica) nel campo Modello / controller.

### Studio dei servizi tipografici (10 novembre 2026)
- **Konica Minolta AccurioPress C4080/C4070/C4065:** la documentazione Web Connection elenca IPP, SNMP per informazioni sul controller, DPWS, OpenAPI e JSP/AccurioPro Print Manager. La presenza di queste voci non equivale a un'API pubblica uniforme su tutti i modelli. [Manuale ufficiale](https://manuals.konicaminolta.eu/AccurioPress-C4080-C4070-C4065/EN/contents/WCI_07_01.html).
- **Ricoh:** Data Collector distingue stampanti SNMP generiche, Ricoh GW, Fiery e TotalFlow e documenta comunicazione JMF per le tipologie compatibili. I dati disponibili dipendono da macchina e controller; occorre verificare supporto, abilitazione e licenze della configurazione reale. [Documentazione ufficiale](https://help.ricohsoftware.com/datacollector/ricoh-predictive-insight/en-us/dc_Help_project.ditamap?onepage=true).
- **Strategia di integrazione:** SNMP per stato/contatori; IPP per attributi e lavori esposti; JMF o API del controller per avanzamento di produzione, dove documentato e disponibile. Sono direzioni da verificare sui dispositivi reali, non connettori già implementati. Per associare automaticamente un lavoro all'ordine Horygon servirà un identificativo stabile (numero ordine nel nome lavoro oppure una mappatura esplicita del job ID).
- **Già implementato:** anagrafica, servizi dichiarati, verifica TCP, assegnazione manuale, tabella stampanti/ordini e visualizzazione sulle TV. **Non implementato:** lettura SNMP/IPP/JMF, discovery automatico e avanzamento automatico da controller. Nessuna stampante reale è stata contattata durante il collaudo.

## Nome del prodotto e tabellone
Il prodotto si chiama **Merlino press**. I nomi tecnici dei progetti, le variabili `HORYGON_*` e gli archivi precedenti restano compatibili per conservare configurazioni e dati esistenti.

Lo Status ordini usa un tabellone stile aeroporto a tutta larghezza e altezza del viewport: fondo blu, intestazione bianca, righe a contrasto, colonne ordine/token, nome, descrizione, stato e stampante. Il numero di righe è quello configurato in Impostazioni; gli spazi senza ordini restano righe vuote. Le pagine ruotano automaticamente. I testi lunghi sono limitati a due righe per evitare che il layout esca dallo schermo; il dettaglio completo rimane nella dashboard. Il pulsante Schermo intero richiede un clic; per avvio senza interazione configurare il browser del player in modalità kiosk.

## Affiancamento a un CRM Docker esistente
Usare un progetto Compose distinto: `docker compose -p merlino-press up -d --build app` dalla cartella deploy. Il nome esplicito separa reti e volumi dal CRM. Non avviare il profilo https di questo pacchetto se il proxy del CRM occupa già le porte 80/443.

Per un proxy installato sull'host, impostare nel file .env `HORYGON_BIND=127.0.0.1:5081` (verificare che la porta sia libera), `HORYGON_PUBLIC_ORIGIN=https://press.DOMINIO-AZIENDALE` e configurare il proxy esistente per inoltrare quel sottodominio a `http://127.0.0.1:5081`, con header `X-Forwarded-Proto: https`. Usare un sottodominio dedicato: l'applicazione utilizza percorsi assoluti dalla radice.

Se il proxy è un container, il suo localhost non è l'host: collegare app e proxy a una rete Docker condivisa, con un alias univoco merlino-press; il backend del proxy sarà `http://merlino-press:5080`. La rete e la configurazione concreta dipendono dal compose del CRM e vanno verificate prima della pubblicazione. Non riutilizzare il database o le chiavi del CRM. Non caricare .env, credenziali, archivi mail o database nel repository Git.
