#!/bin/bash
# redeploy.sh — deploy del CRM che si pulisce da solo.
#
# Il VPS ha un disco piccolo (24 GB) e le immagini/cache Docker si accumulano a
# ogni build fino a riempirlo. Questo script libera lo spazio PRIMA (per avere
# margine di build) e DOPO (per togliere l'immagine appena sostituita), tenendo
# solo cio' che e' effettivamente in uso.
#
# Uso, sul VPS:   cd /opt/horygon-crm && bash redeploy.sh
set -e
cd "$(dirname "$0")"

echo "== git pull =="
git pull

echo "== pulizia PRIMA (immagini inutilizzate + build cache) =="
# -a rimuove le immagini non referenziate da alcun container: quelle in
# esecuzione restano. La build cache viene ricostruita al build successivo.
docker image prune -af || true
docker builder prune -af || true

echo "== validazione compose =="
docker compose config -q

echo "== build + recreate =="
docker compose up -d --build

echo "== pulizia DOPO (rimuove l'immagine precedente, ora inattiva) =="
docker image prune -af || true

echo "== stato =="
docker compose ps
df -h / | tail -1
