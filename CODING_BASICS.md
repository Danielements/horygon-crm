# Basi operative CRM HORYGON

## Deploy e ambiente

- Non assumere mai che il deploy sul server sia equivalente a un push GitHub.
- Distinguere sempre tra:
  - `push su GitHub`
  - `deploy sul VPS`
  - `restart del servizio/container`
- Non assumere mai `pm2` senza verifica esplicita sul server.
- Verificare sempre prima se il CRM gira con:
  - `Docker`
  - `docker compose`
  - processo Node diretto
  - altro orchestratore

## Prima di proporre comandi server

- controllare i file presenti nel repo:
  - `Dockerfile`
  - `docker-compose.yml`
- se si parla del VPS, chiedere o verificare:
  - `docker ps`
  - `docker compose ps`
  - struttura reale del deploy
- non dare per scontato che `npm start` sia il comando corretto di produzione.

## Git e branch

- Quando si dice `ho pushato`, significa pushato su `origin` GitHub, non deployato sul server.
- Comunicare sempre in modo esplicito:
  - remote Git
  - branch
  - se il server e' stato aggiornato oppure no

## Certificati SDI

- Non copiare `key`, `csr`, `cer`, `crt`, `pem`, `p12` nel repo.
- Tenere i certificati reali solo sul server.
- Nel repo lasciare solo:
  - struttura cartelle
  - placeholder
  - README
  - path configurabili

## Regola generale

- Se manca una verifica concreta del runtime/server, non ipotizzare.
- Prima verificare, poi suggerire il comando operativo.
