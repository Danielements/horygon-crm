# Versione 0.7.0 — tabellone task

Pagina aggiuntiva Tabellone task in stile aeroportuale: solo attività aperte, stato manuale, ultimo evento email, priorità, responsabile, scadenza, ora email e storico origine. Aggiornamento locale idempotente a ogni ricaricamento archivio, incluso dopo sincronizzazione e prima dell'analisi AI. Collegamenti basati sulle conversazioni Roadmap o accorpamenti espliciti. Eventi: cambio appuntamento, problema, sollecito, esito da verificare, invio, nuovo messaggio. Regole locali: non è un riconoscimento semantico completo di ogni possibile interferenza. Nessuna modifica automatica della data appuntamento/scadenza, nessuna chiusura da email, nessuna operazione su calendario. Il polling richiede app aperta e sincronizzazione automatica attiva. Task privi di email collegate richiedono collegamento alla conversazione; attività chiuse non modificate automaticamente.

# Versione 0.6.0 — stato pratiche con posta inviata

Cartella Sent individuata da SPECIAL-USE/XLIST, attributi IMAP, nomi comuni o nome esplicito configurato. Download prioritario di Inviata, poi INBOX; errori di comando di una cartella non impediscono il tentativo sulle altre. Copertura cifrata registrata per casella e finestra temporale; conteggi ricevute/inviate e storico parziale nella Roadmap. I messaggi già scaricati vengono aggiornati con il ruolo della cartella senza ripetere il download. Le risposte da alias nella cartella Sent sono riconosciute. Bozze escluse; risposta collegata tramite riferimenti e destinatario: un inoltro interno o il solo accorpamento manuale non chiude l'attesa del cliente. Risposta inviata non equivale a pratica risolta; chiusura attività sempre manuale. Incluso riconoscimento spam/pubblicità 0.5 non precedentemente distribuito.

# Versione 0.4.1 — Dashboard e Roadmap separate

Ripristinata Dashboard come pagina iniziale. Roadmap rimane una voce aggiuntiva nel menu, con tutte le funzioni sulle richieste.

# Versione 0.4.0 — Roadmap

Tabella richieste con conversazioni collegate tramite intestazioni, suggerimenti per mittente/ordine/categoria, accorpamenti manuali reversibili, priorità, attesa risposta e ritardi su obiettivo configurabile (24 ore solari iniziali) o scadenza impostata. Chiusura/riapertura delle attività collegate e navigazione alla posta. Nessun accorpamento semantico automatico e nessuna scadenza inventata; categorie coerenti non garantiscono coerenza dei fatti. Risposte rilevate solo nei dati locali o invii SMTP accettati.

# Aggiornamento 0.3.2 — analisi arretrato locale

Pulsante Analizza email già scaricate, indipendente da IMAP. Il ciclo periodico continua con analisi locale dopo errori di download, conservando il messaggio di errore finale. Risultati aggiornati durante il lotto. Test smoke isolato verifica elaborazione e mancata ripetizione delle email già analizzate. Corretta doppia Dispose del ViewModel alla chiusura.

# Aggiornamento 0.3.1 — diagnostica sincronizzazione IMAP

Rimossa la chiusura esplicita tra cartelle in sola lettura; escluse cartelle NonExistent. Gli errori di comando mostrano fase, cartella, UID quando disponibile e conteggio salvato, senza risposta grezza del server. La UI aggiorna la posta salvata anche dopo un errore. La causa del rifiuto Gmail segnalato resta da verificare con la nuova diagnostica; nessun accesso reale alla casella eseguito per questa modifica.

# Aggiornamento 0.3.0 — Google OAuth

Login desktop Google con importazione JSON, browser, PKCE/state, rinnovo token e persistenza DPAPI. SMTP/IMAP XOAUTH2. Il login reale resta da collaudare con il client aziendale e il consenso dell’utente. Guida: GOOGLE_OAUTH_SETUP.md.

# Stato progetto — 27 ottobre 2026

## Aggiornamento 0.2.0 — provider AI e Gmail
- Selettore LM Studio locale / OpenAI / Anthropic / API compatibile, profili separati con chiavi cifrate e migrazione della configurazione 0.1.
- OpenAI: Chat Completions con max_completion_tokens, senza temperature imposta. Anthropic: Messages API nativa, parsing blocchi testo, header versione e workspace facoltativo. Endpoint ufficiali vincolati per evitare l'invio involontario della chiave a un host diverso.
- Preset Gmail/Aruba; normalizzazione password per le app Gmail; istruzioni e collegamento Google; diagnostica distinta IMAP/SMTP/TLS, senza esposizione di credenziali o errori grezzi del server.
- Build Release: 0 errori, 0 avvisi. **57 test superati** (37 precedenti + 20 casi nuovi, con adeguamento del test del tipo di errore SMTP).
- Test HTTP sintetici: protocollo, headers, uso della sola chiave selezionata, token, migrazione, consenso cloud, host vincolati, risposte troncate e messaggi d'errore. Test Gmail: preset, password formattata, password ordinaria e distinzione autenticazione/TLS.
- Verifica di rete da questo PC: TCP e TLS validati per imap.gmail.com:993 e smtp.gmail.com:465. Nessuna autenticazione effettuata; le credenziali e le policy Google dell'utente restano da verificare.
- Avvio e rendering delle tre configurazioni AI verificati su archivio isolato in `artifacts/ProviderSmoke`. Nessuna API key reale usata, nessun contenuto email trasmesso a provider cloud durante i test.
- Pacchetto aggiornato: `artifacts/Horygon-0.2.0-win-x64.zip`. La versione 0.1 pubblicata resta separata. Chiudere la precedente prima di avviare la nuova: condividono il profilo dati utente.
- Restano non collaudati l'accesso Gmail reale e le chiamate a modelli reali; OAuth Google è stato aggiunto nella 0.3.0.

Le sezioni successive documentano la baseline 0.1 e i suoi limiti ancora validi, salvo quanto aggiornato sopra.

## Risultato
Prima versione 0.1 implementata, compilata e pubblicata per Windows x64. Non è il completamento di tutte le sei fasi della specifica. I percorsi principali del MVP sono collegati a servizi reali; le integrazioni esterne non sono state collaudate con account reali.

Soluzione `Horygon.sln`, otto progetti .NET 10. SDK locale Microsoft 10.0.403 in `.dotnet` (non versionato); SDK globali 8/9 non modificati. Pacchetto self-contained in `artifacts/Horygon-win-x64`, archivio ZIP e script di installazione per utente. Nessuna installazione permanente dell'app effettuata.

## Criteri MVP
| Criterio | Implementazione e verifica |
|---|---|
| Avvio Windows | Eseguito con runtime self-contained; finestra e database inizializzati |
| Account Aruba | Form modificabile, più account, password DPAPI; nessuna credenziale reale usata |
| Test connessione | TLS + autenticazione IMAP e SMTP, enumerazione cartelle; prova reale da eseguire |
| Download non distruttivo | FolderAccess.ReadOnly, BODY.PEEK, UIDVALIDITY/UID, deduplicazione SQLite; comportamento server reale da verificare |
| Visualizzazione messaggi | Elenco, testo sicuro, filtri, ricerca e conversazione; HTML convertito in testo |
| Allegati | Parsing MIME e export su scelta dell'utente; test multipart superato |
| LM Studio | Endpoint/modello/API key/timeout configurabili, test connessione; nessun modello reale disponibile per collaudo |
| Analisi AI | JSON validato, storico limitato, regole, fallback; test sintetici superati |
| Priorità e sintesi | Visualizzate insieme a motivazione, fonte e confidence non calibrata |
| Bozza risposta | Risposta, tutti, inoltro, generazione AI con fallback, firma e riferimenti conversazione |
| Modifica e approvazione | Editor destinatari/corpo/allegati, salvataggio, rifiuto e conferma prima di SMTP |
| Invio SMTP | MailKit reale; test con trasporto simulato per successo, errore autenticazione, timeout e blocco reinvio; nessuna email inviata realmente |
| Dashboard | Conteggi reali dell'archivio, briefing deterministico e criticità locali |
| Regole Markdown | Editor, validazione dimensione/nome, versionamento, attivazione e recupero versioni |
| Attività | Creazione manuale/dalla mail, stato, responsabile, scadenza, ricerca e ordinamento |
| Storico operazioni | Audit cifrato visualizzato in Report; non antimanomissione |

## Verifiche eseguite
- `build.ps1`: build Release, **0 errori, 0 avvisi**.
- xUnit: **37 test superati, 0 falliti, 0 ignorati**. Report `artifacts/TestResults/horygon.trx`.
- Aree coperte: parsing MIME, HTML inerte, priorità fallback con storico, output AI invalido, identità UID, deduplicazione concorrente, conversazioni e Reply-To/CC, autorizzazioni, bozze SMTP, stato invio incerto, task, DPAPI e assenza di testo noto in SQLite/WAL, versioni regole e path traversal, parsing ordini e allowlist URL, consenso AI esterno.
- Smoke test di avvio self-contained: `artifacts/SmokeData/smoke-ok.txt`.
- Rendering WPF di Dashboard, Posta, Approvazioni, Attività, Workflow, Impostazioni e tema chiaro con archivio **sintetico isolato**, immagini in `artifacts/RenderSmoke/Screenshots`. Controllo visivo e correzione contrasto/tema eseguiti. Dati sintetici mai inseriti nel profilo normale.
- Automazione interattiva computer-use non completata: timeout dell'autorizzazione all'app. Il rendering WPF e i test dei servizi non equivalgono a una prova end-to-end di tutti i clic.
- Pubblicazione self-contained win-x64 riuscita. Installazione tramite script non eseguita; nessuna prova su un secondo PC pulito.

## Non ancora completato
Tray, notifiche, avvio automatico, IMAP IDLE, retention configurabile, rendering HTML/immagini inline, wizard multipagina, automazioni autonome e action registry completo, budget AI cumulativo, copie IMAP Inviata, rubrica/aziende normalizzate, migrazioni EF versionate, backup portabili, integrazione effettiva con portale ordini autenticato, installer firmato/aggiornamenti automatici e scelta licenza di distribuzione.

Il connettore HTTP/AngleSharp e quello browser Playwright sono disponibili come librerie e il parsing è testato; nessun portale aziendale reale è configurato, nessun login automatico implementato. Gli aggiornamenti ordini restano disabilitati.

## Prossime verifiche pratiche
1. Inserire nell'app un account di prova Aruba, verificare autenticazione e prima sincronizzazione confrontando flag/cartelle con un altro client.
2. Avviare LM Studio con un modello compatibile e verificare analisi/bozza in italiano.
3. Inviare manualmente una sola risposta a un destinatario di prova, verificando conversazione e comportamento della cartella Inviata del provider.
4. Definire portale e autenticazione prima di integrare la ricerca ordini reale.

Consultare `SECURITY.md` prima di utilizzare dati aziendali. La versione richiede ulteriore collaudo e revisione prima della distribuzione commerciale.




## 0.8.0 — Lavorazione e ripresa
Download, analisi e accessi SQLite/DPAPI vengono eseguiti fuori dal thread della finestra. Le pagine restano consultabili; per modificare dati durante un flusso usare prima Pausa lavorazione. L'avanzamento è salvato dopo ogni analisi, con eventi nel Report; la fonte AI/fallback è indicata. Il tabellone si aggiorna anche durante l'analisi, circa ogni 20 secondi.
Ogni cartella IMAP conserva un checkpoint UID separato per account e UIDVALIDITY. Un ampliamento del periodo storico fa ricontrollare la cartella; le email già presenti non vengono riscaricate. Le analisi riprendono soltanto sui messaggi privi di risultato, anche se l'ultimo conteggio non era stato salvato.
Chiudere termina il processo: alla riapertura un lavoro interrotto riprende automaticamente. Una pausa esplicita resta in pausa, anche con sincronizzazione automatica: usare Riprendi lavorazione. Minimizzare lascia lavorare l'app; non è installato un servizio Windows. Nessun invio viene ripreso automaticamente. Una richiesta AI interrotta prima del salvataggio può essere ripetuta e conteggiata dal provider.


## 0.8.1 — Protezione consumi (sostituisce la ripresa automatica 0.8.0)
Nessuna ripresa automatica all'avvio; AutoSync viene disattivato ad ogni avvio. Se riattivato, scarica soltanto e non avvia analisi. Ogni avvio manuale del flusso consente al massimo 10 nuove analisi (limite di chiamate, non di euro/token). Un errore o limite non viene ripreso dal timer.
Risultati riutilizzati per account e Message-ID, indipendentemente da cartella/UID/UIDVALIDITY; se manca Message-ID si usa un'impronta dei contenuti completi e della data. Ripristino locale all'avvio sulle copie già scaricate, senza API. Nessuna cancellazione di email o task esistenti. Creazione task da email riutilizza un task già collegato alle copie.
Ricevuta cifrata prima della chiamata: se l'esito è incerto, nessun retry automatico anche dopo riavvio. Le ricevute iniziate senza risultato restano bloccate, da verificare prima di autorizzare un nuovo tentativo. Registro ANALYSIS_ATTEMPT e CLASSIFY_EMAIL distingue i tentativi dalle analisi completate. Non è un contatore di fatturazione del provider.


## 0.9.0 — Architettura server Linux, client solo browser
Horygon.Server contiene UI web, servizi Gmail OAuth web/IMAP, worker background, analisi manuale limitata e registro operativo cifrato. Core, Data, Email e AI compilano per net10.0 multipiattaforma. La dashboard ha cinque aree, colonne riordinabili, modifiche con controllo versione, origine email e permessi consultazione/operatore. Horygon.Migrate esporta una volta l'archivio DPAPI Windows in un backup portabile cifrato. Nessun worker desktop o publisher Windows è richiesto.
Pacchetto Docker e Caddy in deploy; configurazione dettagliata in SERVER_SETUP.md. Verifica tracking di terze parti non collegata. VM, DNS, certificati e OAuth aziendale reali ancora da collaudare sull'infrastruttura di destinazione.
