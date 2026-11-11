# Stato della roadmap – App Rilievi SIA

Pagina con le voci dell'Allegato A (Roadmap App Rilievi – Testimoniali di Stato) confrontate
con l'app alla fase 2t. Per ogni voce si sceglie uno stato (Approvato, Non approvato,
Da revisionare, Da aggiornare) e si scrivono note; il server li salva in `data/revisione.json`.

## Avvio

```
docker compose up -d --build
```

La pagina è su `http://<vm>:8090`. Per cambiare porta modificare `ports` in `docker-compose.yml`
(ad esempio `"8123:8090"`).

I dati restano nella cartella `data/` accanto al compose (fuori dal repository): per il backup
basta copiare `data/revisione.json`.

## Nota

Il server non ha autenticazione: chi raggiunge la porta può modificare stati e note.
Se si pubblica tramite Cloudflare, proteggere l'indirizzo con Cloudflare Access.
