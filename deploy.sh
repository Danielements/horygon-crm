#!/bin/bash
# deploy.sh — esegui sul VPS dopo git pull
set -e

echo "🚀 Deploy Horygon CRM..."

# Pull ultimo codice
git pull origin main

# Build Docker
docker compose down
docker compose build --no-cache
docker compose up -d

# Setup Nginx (solo prima volta)
if [ ! -f /etc/nginx/sites-enabled/horygon-crm ]; then
  echo "📋 Configuro Nginx..."
  cp nginx/horygon-crm.conf /etc/nginx/sites-available/horygon-crm
  ln -s /etc/nginx/sites-available/horygon-crm /etc/nginx/sites-enabled/horygon-crm
  nginx -t && systemctl reload nginx
  echo "🔒 Ora esegui: certbot --nginx -d crm.horygon.it"
fi

echo "✅ Deploy completato"
docker compose ps
