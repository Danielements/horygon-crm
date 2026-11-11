# Merlino press accanto a Horygon CRM

Questo modulo vive nella cartella `merlino-press/` del repository `Danielements/horygon-crm`. Il Compose del CRM e i suoi dati non vengono modificati. Nel repository il CRM pubblica 8443:3001; verificare sul server il proxy realmente in uso prima di pubblicare Merlino press.

## Deploy con Nginx installato sull'host

1. Recuperare il branch `codex/merlino-press` in un checkout dedicato oppure integrarlo in main dopo revisione. Non cambiare branch nella directory del CRM in produzione mentre si sta usando il suo codice.
2. Dalla cartella `merlino-press`, eseguire `python3 deploy/setup.py --domain press.DOMINIO-AZIENDALE`, sostituendo il dominio. Il file deploy/.env viene creato con chiavi casuali e permessi riservati; non viene sovrascritto se esiste.
3. In deploy/.env impostare `HORYGON_BIND=127.0.0.1:5081` (dopo aver verificato che sia libera). Conservare una copia protetta di questo file: senza la chiave dati il database non si legge.
4. Eseguire:

```sh
cd deploy
docker compose -p merlino-press up -d --build app
docker compose -p merlino-press logs --tail=100 app
```

5. Configurare un sito Nginx HTTPS separato per il dominio scelto, con certificato valido e backend `http://127.0.0.1:5081`. Nel blocco location / impostare:

```nginx
proxy_pass http://127.0.0.1:5081;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Il listener HTTP deve reindirizzare a HTTPS. Non avviare il profilo `https` del Compose Merlino press: il suo Caddy contenderebbe 80/443 al proxy esistente. Se Nginx gira invece in un container, collegare i servizi a una rete Docker condivisa e usare un alias univoco, non localhost.

6. Verificare `https://DOMINIO-SCELTO/health`, poi accedere con il codice HORYGON_ADMIN_KEY conservato in deploy/.env. Configurare Gmail e il client OAuth web con callback `https://DOMINIO-SCELTO/oauth/google/callback`. In Impostazioni recuperare il link permanente Status per TV e player.

## Aggiornamento

Nel checkout dedicato recuperare la versione desiderata, quindi ripetere `docker compose -p merlino-press up -d --build app` dalla cartella deploy. Mantenere lo stesso nome progetto, il volume dati e .env. Non usare `down -v`: eliminerebbe il volume del database.

## Stato del collaudo

127 test .NET superati durante lo sviluppo, test HTTP di autenticazione, CRUD stampanti, collegamento Status persistente dopo riavvio e verifica visiva del tabellone blu/bianco. Docker/Linux, Nginx e i servizi reali Gmail/stampanti richiedono il collaudo sulla VM: non sono stati pubblicati o contattati da questo push. La lettura automatica dei lavori di stampa non è ancora collegata; le assegnazioni degli ordini alle stampanti sono manuali.
