# Horygon — Architettura

Desktop Windows WPF, .NET 10, MVVM e dependency injection. Core contiene contratti e modelli; Data persiste un archivio SQLite attraverso EF Core; Security protegge payload e segreti con DPAPI CurrentUser. Email usa MailKit in sola lettura e SMTP con approvazione esplicita. AI usa endpoint compatibili, output validato e fallback locale. Integrations contiene parsing ordini e accesso a domini autorizzati.

Il database conserva payload aziendali cifrati (inclusi MIME e allegati); gli indici tecnici non contengono testo della posta. La ricerca MVP decifra in memoria. Nessun contenuto remoto viene eseguito. Le regole orientano le proposte, mai le autorizzazioni. L'invio viene registrato prima di contattare SMTP: un risultato incerto non viene ritentato automaticamente.

La UI lavora su copie in memoria e salva mediante un repository serializzato. La sincronizzazione è incrementale per account/cartella/UIDVALIDITY/UID; un cambio di epoca conserva l'archivio precedente. La prima versione privilegia il percorso email completo. Le integrazioni senza configurazione e le funzioni successive sono dichiarate non disponibili.
