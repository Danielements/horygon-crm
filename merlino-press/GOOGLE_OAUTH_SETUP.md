# Collegare Gmail aziendale a Horygon

Non servono password per le app. Serve un client Google OAuth dedicato di tipo **App desktop**; il client web del CRM non è adatto.

## Google Cloud Console

1. Apri https://console.cloud.google.com/ e scegli o crea un progetto nell'organizzazione aziendale.
2. Apri **Google Auth Platform**. Configura **Branding** con nome Horygon e indirizzi di assistenza richiesti.
3. In **Audience**, scegli **Internal / Interno** se disponibile per l'organizzazione Workspace. Se usi External in modalità test, aggiungi il tuo indirizzo agli utenti di test; Google può limitare la durata dell'autorizzazione.
4. In **Data Access / Accesso ai dati**, configura gli ambiti `https://mail.google.com/`, `openid` e `email`. Per IMAP e SMTP Google richiede l'ambito completo della posta. Horygon usa IMAP in lettura e richiede conferma per inviare.
5. In **Clients / Client**, crea un **ID client OAuth**, tipo applicazione **Desktop app / App desktop**, nome Horygon Windows. Scarica il JSON. Non occorre inserire manualmente un URI di reindirizzamento: l'app usa il browser e un callback locale temporaneo.

## Nell'app

1. Apri Impostazioni e applica il profilo **Gmail · Accedi con Google**. Inserisci l'indirizzo aziendale.
2. Premi **Importa JSON OAuth** e seleziona il file scaricato. Client e token vengono salvati cifrati con Windows per l'utente corrente. Il file originale scaricato resta nella sua cartella: custodiscilo e non inviarlo in chat.
3. Premi **Accedi con Google**, scegli lo stesso account e autorizza l'accesso nel browser.
4. Torna nell'app, premi **Verifica connessione**, poi sincronizza. La verifica non invia email.

Se Google blocca l'accesso, l'amministratore Workspace deve consentire il client Horygon e i suoi ambiti nei controlli di accesso alle app di terze parti e permettere IMAP. Il fatto che il CRM sia autorizzato non autorizza automaticamente Horygon.

Il pulsante Scollega elimina il collegamento locale; per revocare il consenso anche su Google visita le connessioni del tuo account Google.

## Riferimenti

- OAuth per app desktop: https://developers.google.com/identity/protocols/oauth2/native-app
- Ambiti e autenticazione Gmail IMAP/SMTP: https://developers.google.com/workspace/gmail/imap/xoauth2-protocol

Il login reale richiede il tuo client e il consenso nel browser; non è incluso un client condiviso preconfigurato.
