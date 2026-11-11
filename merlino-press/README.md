# Merlino press

Gestionale web per posta, ordini e produzione. La versione corrente è il server 0.9.0: tutta la logica gira sul server e Windows, TV e player accedono dal browser. Consultare [SERVER_SETUP.md](SERVER_SETUP.md) per installazione, migrazione e configurazione.

Lo Status ordini è un tabellone stile aeroporto che occupa tutto il viewport, con accesso permanente e quantità di righe configurabile da Impostazioni.

## Documentazione storica del client desktop

Le indicazioni seguenti descrivono le versioni precedenti alla migrazione server.

# Tabellone task — 0.8.1

Apri Tabellone task per vedere solo attività aperte in una tabella stile aeroportuale. La colonna STATO è lo stato operativo gestito dall'utente; ULTIMO EVENTO EMAIL si aggiorna automaticamente con le email della conversazione collegata. Seleziona una riga per leggere lo storico e aprire il messaggio origine, modificare la scadenza o chiudere il task. Le attività chiuse restano in Attività.

Attiva Sincronizzazione automatica, scegli i secondi e premi Salva. L'app deve restare aperta; l'aggiornamento avviene alla sincronizzazione, non tramite notifiche push. I segnali locali non richiedono API e includono cambio call, problemi, solleciti ed esiti da verificare. Non estraggono automaticamente nuovi orari né sostituiscono scadenze: verifica la mail e modifica il task. Crea attività dalla mail per collegarla alla conversazione; per conversazioni distinte conferma prima l'accorpamento in Roadmap.

# Versione 0.8.1 — posta ricevuta e inviata

Dopo l'aggiornamento premi Sincronizza: Inviata viene elaborata prima di INBOX e delle altre cartelle. Il filtro Posta inviata mostra i messaggi spediti, anche da alias se riconosciuti nella cartella Sent. In Roadmap ogni richiesta riporta ricevute, inviate e la copertura dello storico. Una risposta è collegata tramite riferimenti e destinatario, non solo oggetto o accorpamento manuale. Risposta inviata non significa pratica risolta; puoi chiudere manualmente le attività.

Se compare storico parziale, lo stato della risposta e il possibile ritardo vanno verificati. In Impostazioni puoi indicare il nome completo della cartella Inviata quando il riconoscimento automatico non riesce. Il periodo configurato limita anche la posta inviata; messaggi fuori periodo o non esposti dal server IMAP non sono verificabili. Le analisi esistenti non vengono richiamate automaticamente; la ricostruzione della Roadmap usa subito le risposte appena sincronizzate.

# Roadmap — versione 0.8.1

La pagina aggiuntiva Roadmap mostra richieste, priorità, risposta attesa, ritardo, attività e email collegate in una tabella ordinabile. Seleziona una riga per consultare le email, impostare responsabile e scadenza, mettere in lavorazione/in attesa, chiudere o riaprire tutte le attività collegate.

Le conversazioni sono raggruppate dalle intestazioni email. Le possibili corrispondenze per mittente, ordine e categoria sono segnalate nella sintesi e richiedono accorpamento manuale tramite il selettore in basso; Separa accorpamento ripristina le conversazioni e mantiene le attività sulla conversazione della loro email originaria. Coerenza della categoria non equivale a verifica dei fatti. Le scadenze citate nel testo devono essere verificate e impostate.

Il ritardo usa la scadenza impostata (a giornata) oppure un obiettivo di risposta, inizialmente 24 ore solari dalla prima richiesta non risposta. Un sollecito non azzera il conteggio. Le risposte vengono rilevate nella posta sincronizzata e negli invii confermati SMTP; non copre posta non scaricata. Una nuova email dopo la chiusura riporta la richiesta da verificare. Aggiorna stato ricalcola i tempi.

# HORYGON · AI Executive Assistant

Client Windows WPF in C#/.NET 10, versione 0.8.1. Non è ancora l'intero prodotto descritto nella specifica. Nessun dato dimostrativo viene inserito nell'archivio dell'utente.

## Novità 0.8.1: provider AI e Gmail
- In Impostazioni → Intelligenza artificiale scegli **LM Studio locale**, **OpenAI**, **Anthropic** o API compatibile personalizzata. Ogni provider conserva modello e API key separati nel database cifrato. La configurazione precedente viene migrata automaticamente al primo avvio.
- OpenAI usa il proprio endpoint ufficiale con `max_completion_tokens`; Anthropic usa nativamente `/v1/messages` e la propria intestazione versione, senza adattatore Chat Completions. La temperature viene inviata soltanto a LM Studio/API personalizzate per evitare incompatibilità con i modelli cloud. Inserire un identificativo modello disponibile nel proprio account; non viene scelto un modello automaticamente.
- Per Anthropic è disponibile il campo Workspace ID quando richiesto dalla chiave. Per entrambi i cloud serve il consenso esplicito all'invio esterno. Il test provider invia solo un messaggio sintetico, senza email. API key e risposta grezza d'errore non vengono mostrate nei log.
- Per Gmail aziendale scegli **Gmail · Accedi con Google**, importa il JSON OAuth App desktop e accedi nel browser. Segui [la guida](GOOGLE_OAUTH_SETUP.md). Le password per le app restano una alternativa se consentite.
- Gli errori distinguono autenticazione IMAP, SMTP e negoziazione TLS. OAuth Google è disponibile con client desktop dedicato. Un errore di credenziali/policy Google non può essere risolto dal solo preset.
- Chiudere la versione precedente prima di avviare la 0.8.1: viene utilizzato lo stesso archivio `%LOCALAPPDATA%\Horygon`.

Riferimenti: [password per le app Google](https://support.google.com/accounts/answer/185833?hl=it), [Gmail nei client](https://support.google.com/mail/answer/7126229?hl=it), [API OpenAI](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [autenticazione Anthropic](https://platform.claude.com/docs/en/manage-claude/authentication).

## Avvio rapido
1. Estrarre `artifacts/Horygon-0.8.2-win-x64.zip` in una cartella.
2. Avviare `Horygon.Desktop.exe`, oppure eseguire `install.ps1` dalla cartella estratta per creare un'installazione per utente e un collegamento nel menu Start.
3. In Impostazioni configurare Gmail OAuth oppure casella e password, verificare la connessione e salvare l'account. Aruba standard è precompilato (`imaps.aruba.it:993`, `smtps.aruba.it:465`, SSL/TLS). Parametri diversi, PEC e domini particolari devono essere verificati con il provider.
4. Per LM Studio caricare un modello, avviare il server locale, abilitare AI e inserire l'identificativo esatto del modello. Endpoint predefinito `http://localhost:1234/v1`. Testare e salvare. È possibile lasciare AI disattivata.
5. Premere **Sincronizza**. Il periodo predefinito è 90 giorni. Le cartelle personali selezionabili vengono enumerate e scaricate senza modificare flag o messaggi sul server.
6. Selezionare un messaggio. Analizza mostra priorità, sintesi, motivazione e fonte. Rispondi, A tutti, Inoltra e Prepara risposta AI creano bozze locali nella pagina Approvazioni.
7. Controllare e modificare destinatari, contenuto e allegati; **Approva e invia** apre la conferma finale. Nessun invio viene effettuato per il solo fatto di sincronizzare o analizzare.
8. Creare attività dalla posta, assegnare responsabile/scadenza, modificare regole in Workflow e consultare l'audit in Report.

Il programma pubblicato include il runtime .NET: non richiede Visual Studio né .NET sul computer destinatario. Target Windows 10/11 x64. Windows deve essere in una versione compatibile con .NET 10; ambienti aziendali obsoleti richiedono verifica. LM Studio/modello sono prerequisiti separati solo se si desidera AI locale. I browser Playwright sono un prerequisito opzionale per il connettore browser, non per il client email.

## Compilazione e test
Richiede Windows e SDK .NET 10 stabile. Il progetto supporta SDK di sistema o `.dotnet/dotnet.exe` locale. `global.json` seleziona la famiglia 10.0. Non modificare il target a .NET 9.

```powershell
.\build.ps1
.\publish.ps1
```

`build.ps1` esegue restore, build Release e test xUnit. `publish.ps1` pubblica self-contained win-x64 e crea ZIP con procedura di installazione. `-SkipTests` consente di evitare di ripetere test già eseguiti. Output in `artifacts/`; report test in `artifacts/TestResults/horygon.trx`. Aprire `Horygon.sln` in un IDE compatibile con .NET 10 oppure usare CLI. Nessun segreto deve essere inserito nel repository.

## Moduli
| Progetto | Responsabilità |
|---|---|
| Horygon.Desktop | WPF, MVVM CommunityToolkit, design system chiaro/scuro, DI, polling e configurazione |
| Horygon.Core | Modelli, contratti, policy conservativa e attività |
| Horygon.Data | EF Core SQLite, repository cifrato, versioni regole |
| Horygon.Security | Protezione DPAPI CurrentUser |
| Horygon.Email | MailKit IMAP/SMTP, MIME, allegati, conversazioni e bozze |
| Horygon.AI | Provider compatibile chat completions, output JSON validato, fallback e orchestratore analisi |
| Horygon.Integrations | Parsing AngleSharp, connettori HTTP/Playwright con allowlist |
| Horygon.Tests | Test sintetici senza caselle o provider reali |

## Dati locali
`%LOCALAPPDATA%\Horygon\` contiene `Data`, `Mail`, `Attachments`, `Rules`, `Logs`, `Cache`, `Backups`. Nel MVP i contenuti email e allegati sono nel payload cifrato del database in Data; le cartelle Mail/Attachments/Backups sono predisposte ma non usate come copie in chiaro. I Markdown distribuiti in `config` vengono copiati in Rules soltanto se mancanti. Gli aggiornamenti non sovrascrivono le regole attive.

Leggere **SECURITY.md** per protezione effettiva, limiti DPAPI e gestione degli invii incerti. Chiudendo la finestra termina il processo e si arresta il polling. L'archivio resta leggibile senza rete/AI. Nessuna eliminazione automatica locale o remota.

## Limiti ancora presenti
- Primo avvio guidato in una pagina impostazioni, non wizard a sei schermate.
- Visualizzazione sicura in testo anche per email HTML; layout HTML e immagini inline non renderizzati.
- Polling configurabile, senza IMAP IDLE, tray, avvio automatico o notifiche desktop.
- Sincronizzazione incrementale dei messaggi mancanti nella finestra temporale; ricerca UID del periodo a ogni ciclo. Cancellazioni/spostamenti remoti non eliminano l'archivio locale.
- Classificazione automatica dopo sincronizzazione; bozze e attività create su richiesta, non pianificazione autonoma completa. Nessun aggiornamento ordini.
- Connettori ordini implementati a livello libreria e testati con HTML sintetico; configurazione UI, login e collegamento al portale reale da completare.
- Nessuna copia IMAP automatica in Inviata (evita doppie copie); viene conservata la bozza inviata locale. Verificare se il proprio server salva la copia.
- Nessuna retention configurabile, backup portabile, budget token cumulativo, embedding, rubrica aziende/contatti o normalizzazione completa delle 15 entità previste. Conversazioni, analisi e allegati sono inclusi nel record email.
- Nessun installer MSI/MSIX firmato o aggiornamento automatico. Script installazione per utente e pacchetto portable disponibili. Scelta licenza open-source e verifica dipendenze da completare prima di pubblicare commercialmente.

Lo stato delle verifiche effettivamente eseguite è in **PROJECT_STATUS.md**. I test sintetici non sostituiscono la prova con Aruba, LM Studio o il portale aziendale.

## Riferimenti tecnici
- Microsoft: https://learn.microsoft.com/dotnet/core/tools/dotnet-install-script
- MailKit accesso cartelle: https://mimekit.net/docs/html/T_MailKit_FolderAccess.htm
- Versioni pacchetti risolte dal feed ufficiale NuGet; riferimenti esatti nei `.csproj`.




## 0.8.1 — Lavorazione e ripresa
Download, analisi e accessi SQLite/DPAPI vengono eseguiti fuori dal thread della finestra. Le pagine restano consultabili; per modificare dati durante un flusso usare prima Pausa lavorazione. L'avanzamento è salvato dopo ogni analisi, con eventi nel Report; la fonte AI/fallback è indicata. Il tabellone si aggiorna anche durante l'analisi, circa ogni 20 secondi.
Ogni cartella IMAP conserva un checkpoint UID separato per account e UIDVALIDITY. Un ampliamento del periodo storico fa ricontrollare la cartella; le email già presenti non vengono riscaricate. Le analisi riprendono soltanto sui messaggi privi di risultato, anche se l'ultimo conteggio non era stato salvato.
Chiudere termina il processo: alla riapertura un lavoro interrotto riprende automaticamente. Una pausa esplicita resta in pausa, anche con sincronizzazione automatica: usare Riprendi lavorazione. Minimizzare lascia lavorare l'app; non è installato un servizio Windows. Nessun invio viene ripreso automaticamente. Una richiesta AI interrotta prima del salvataggio può essere ripetuta e conteggiata dal provider.


## 0.8.1 — Protezione consumi (sostituisce la ripresa automatica 0.8.0)
Nessuna ripresa automatica all'avvio; AutoSync viene disattivato ad ogni avvio. Se riattivato, scarica soltanto e non avvia analisi. Ogni avvio manuale del flusso consente al massimo 10 nuove analisi (limite di chiamate, non di euro/token). Un errore o limite non viene ripreso dal timer.
Risultati riutilizzati per account e Message-ID, indipendentemente da cartella/UID/UIDVALIDITY; se manca Message-ID si usa un'impronta dei contenuti completi e della data. Ripristino locale all'avvio sulle copie già scaricate, senza API. Nessuna cancellazione di email o task esistenti. Creazione task da email riutilizza un task già collegato alle copie.
Ricevuta cifrata prima della chiamata: se l'esito è incerto, nessun retry automatico anche dopo riavvio. Le ricevute iniziate senza risultato restano bloccate, da verificare prima di autorizzare un nuovo tentativo. Registro ANALYSIS_ATTEMPT e CLASSIFY_EMAIL distingue i tentativi dalle analisi completate. Non è un contatore di fatturazione del provider.
