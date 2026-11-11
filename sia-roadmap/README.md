# Stato della roadmap – App Rilievi SIA

Pagina con le voci dell'Allegato A (Roadmap App Rilievi – Testimoniali di Stato) confrontate
con l'app alla fase 2t. Con "Modifica" si cambiano stato (Approvato, Non approvato, Da revisionare, Da aggiornare,
Non più necessario), testo, stato di sviluppo, dettaglio e note di una voce, sempre con una
motivazione. Il server salva in `data/revisione.json` i valori correnti e lo storico di ogni
modifica (data, campi prima → dopo, motivazione), visibile con "Storico".

## Avvio

```
docker compose up -d --build
```

Il container ascolta solo su `127.0.0.1:8090`: da fuori si passa da nginx (https://roadmap.horygon.it). Per cambiare porta modificare `ports` in `docker-compose.yml`
(ad esempio `"8123:8090"`).

I dati restano nella cartella `data/` accanto al compose (fuori dal repository): per il backup
basta copiare `data/revisione.json`.

## Nota

Il server non ha autenticazione: chi raggiunge la porta può modificare stati e note.
Se si pubblica tramite Cloudflare, proteggere l'indirizzo con Cloudflare Access.
