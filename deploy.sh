#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

BRANCH="${1:-codex/ricambi-area}"
SERVICE="${2:-horygon-crm}"

echo "[deploy] Avvio deploy Horygon CRM"
echo "[deploy] Repo: $ROOT_DIR"
echo "[deploy] Branch: $BRANCH"

if [[ -n "$(git status --short)" ]]; then
  echo "[deploy] Worktree sporca: fai commit, stash o ripristino prima del deploy."
  git status --short
  exit 1
fi

echo "[deploy] Aggiorno il repository"
git fetch origin

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  git switch "$BRANCH" || git switch -c "$BRANCH" --track "origin/$BRANCH"
fi

git pull --ff-only origin "$BRANCH"

echo "[deploy] Ricreo il container"
docker compose down
docker compose up -d --build --force-recreate

echo "[deploy] Stato servizi"
docker compose ps

echo "[deploy] Ultimi log"
docker compose logs --tail=120 "$SERVICE"

echo "[deploy] Deploy completato"
