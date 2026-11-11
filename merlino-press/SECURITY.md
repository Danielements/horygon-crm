# Sicurezza e limiti del MVP

Aggiornamento 0.2: ogni provider AI ha un profilo e una API key distinti, inclusi nel payload DPAPI di AppSettings. La migrazione conserva le impostazioni precedenti senza abilitare il consenso cloud. OpenAI e Anthropic accettano soltanto i rispettivi endpoint ufficiali; LM Studio locale solo loopback. Il connettore Anthropic usa Messages API e valida comunque il JSON applicativo restituito. I test provider non inviano email. I messaggi di errore distinguono le fasi di autenticazione/TLS senza includere risposte grezze del server o segreti. Gmail supporta anche OAuth desktop: PKCE S256, state verificato, callback loopback, identità email verificata, token e client cifrati DPAPI. Nessun FileDataStore in chiaro. I token sono vincolati alla casella e inviati solo ai server Gmail ufficiali. Il consenso IMAP/SMTP richiede https://mail.google.com/.

## Protezione verificabile
I record SQLite contengono soltanto tipo entità, identificativo tecnico e payload binario protetto con Windows DPAPI `CurrentUser`. Sono cifrati: credenziali, API key, indirizzi, oggetto, corpo, allegati, analisi, bozze, attività, impostazioni, audit e versioni storiche delle regole. Chiave primaria composta `(Kind, Id)`; nessun indice di ricerca contiene testo aziendale. Il test automatico controlla anche che una stringa sintetica non compaia nei file database/WAL.

DPAPI protegge contro la lettura offline senza le chiavi del profilo Windows; NON protegge da malware o processi eseguiti sotto lo stesso utente, amministratori che controllano il processo, memoria, pagefile o catture schermo. SQLite non è cifrato integralmente: tipi, ID, dimensioni e conteggi possono essere visibili. La ricerca decifra i record in memoria. I file Markdown attivi in Rules sono intenzionalmente editabili e in chiaro: non inserirvi segreti. Le copie esportate degli allegati sono in chiaro per scelta esplicita dell'utente. Usare BitLocker e protezione del profilo Windows per una difesa ulteriore.

Le copie del database non sono portabili a un altro utente/computer senza adeguato recupero delle chiavi DPAPI. Nessuna funzione di backup/ripristino portabile è inclusa. Non cancellare il profilo Windows senza un piano di migrazione. Il database è schema v1 creato con EnsureCreated: prima di modificare lo schema occorre introdurre migrazioni e backup verificati.

## Posta e AI
- IMAP usa TLS verificato, `FolderAccess.ReadOnly` e `GetMessageAsync` (BODY.PEEK). Nessuna chiamata a Move, Delete, SetFlags, Expunge o Append.
- Le identità includono account, nome cartella, UIDVALIDITY e UID. Un'epoca diversa viene archiviata separatamente; vecchie copie non sono eliminate automaticamente.
- Le email HTML vengono trasformate in testo inerte con AngleSharp. Nessun WebBrowser esegue contenuto; script, tracking e risorse inline non vengono caricati. Gli allegati possono essere salvati ma non eseguiti dall'app.
- Invio SMTP con snapshot approvato, identità Message-ID persistente e stato Sending scritto prima del tentativo. Nessun retry dopo errore in fase di invio; Sending dopo un crash diventa Uncertain all'avvio. Il server può aver accettato il messaggio anche se la risposta non arriva. Verificare con il provider; non creare un altro invio senza controllo.
- I provider non locali richiedono consenso esplicito e HTTPS. Redirect AI e HTTP portali sono disabilitati. LM Studio è consentito su localhost/127.0.0.1/::1.
- Il modello riceve email come dati non attendibili, non dispone di tool di sistema e non può cambiare la policy. JSON validato con enum e campi obbligatori. Questo riduce l'impatto delle prompt injection, ma non garantisce correttezza delle sintesi/bozze: la revisione umana resta necessaria.
- Le regole Markdown sono istruzioni comportamentali. Il front matter non è una fonte di autorizzazione. Invio sempre esplicito; UPDATE_ORDER sempre negato.
- I log Serilog registrano solo tipo dell'errore e messaggi tecnici controllati. Non viene abilitato il protocol logging di MailKit. L'audit aziendale è cifrato ma non è un registro antimanomissione certificato.

## Limiti operativi
App monopostazione, nessun RBAC aziendale. Nessuna garanzia di consegna dopo accettazione SMTP. Nessuna protezione antivirus allegati incorporata. Non esiste ancora un limite dimensionale ai download IMAP: evitare caselle con messaggi molto grandi; archivio e ricerca sono in memoria e richiedono ottimizzazione per grandi volumi. I connettori browser non gestiscono login/MFA né sessioni persistenti; sono componenti predisposti per portali pubblici autorizzati. La versione non è ancora qualificata per distribuzione commerciale senza revisione di sicurezza, firme del pacchetto, licenze e prove di integrazione.

