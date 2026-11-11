const webpush = require('web-push');
const db = require('../db/database');
const { writeSystemLog } = require('./system-log');

const PUBLIC_KEY = String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim();
const PRIVATE_KEY = String(process.env.WEB_PUSH_PRIVATE_KEY || '').trim();
const SUBJECT = String(process.env.WEB_PUSH_SUBJECT || 'mailto:info@horygon.com').trim();

let vapidConfigured = false;
if (PUBLIC_KEY && PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    vapidConfigured = true;
  } catch (error) {
    writeSystemLog({
      livello: 'error',
      origine: 'push.init',
      messaggio: error.message || 'Configurazione VAPID non valida',
      stack: error.stack || null
    });
  }
}

function isPushConfigured() {
  return vapidConfigured;
}

function getPushPublicKey() {
  return PUBLIC_KEY;
}

function normalizeSubscriptionInput(subscription = {}) {
  const endpoint = String(subscription.endpoint || '').trim();
  const keys = subscription.keys || {};
  const p256dh = String(keys.p256dh || '').trim();
  const auth = String(keys.auth || '').trim();
  if (!endpoint || !p256dh || !auth) throw new Error('Subscription push non valida');
  return {
    endpoint,
    expirationTime: subscription.expirationTime || null,
    keys: { p256dh, auth }
  };
}

function upsertPushSubscription(userId, subscription, userAgent = '') {
  const cleanUserId = Number(userId || 0);
  if (!cleanUserId) throw new Error('Utente non valido');
  const normalized = normalizeSubscriptionInput(subscription);
  db.prepare(`
    INSERT INTO web_push_subscriptions
    (utente_id, endpoint, subscription_json, user_agent, enabled, last_error, last_error_at, aggiornato_il)
    VALUES (?, ?, ?, ?, 1, NULL, NULL, datetime('now'))
    ON CONFLICT(endpoint) DO UPDATE SET
      utente_id = excluded.utente_id,
      subscription_json = excluded.subscription_json,
      user_agent = excluded.user_agent,
      enabled = 1,
      last_error = NULL,
      last_error_at = NULL,
      aggiornato_il = datetime('now')
  `).run(
    cleanUserId,
    normalized.endpoint,
    JSON.stringify(normalized),
    String(userAgent || '').slice(0, 500)
  );
  return { ok: true, endpoint: normalized.endpoint };
}

function disablePushSubscription(userId, endpoint = '') {
  const cleanUserId = Number(userId || 0);
  const cleanEndpoint = String(endpoint || '').trim();
  if (!cleanUserId || !cleanEndpoint) return { ok: false };
  db.prepare(`
    UPDATE web_push_subscriptions
    SET enabled = 0, aggiornato_il = datetime('now')
    WHERE utente_id = ? AND endpoint = ?
  `).run(cleanUserId, cleanEndpoint);
  return { ok: true };
}

function listUserPushSubscriptions(userId) {
  return db.prepare(`
    SELECT id, endpoint, enabled, last_success_at, last_error_at, last_error, creato_il, aggiornato_il
    FROM web_push_subscriptions
    WHERE utente_id = ?
    ORDER BY id DESC
  `).all(Number(userId || 0));
}

function getUnreadNotificationCount(userId) {
  return db.prepare(`
    SELECT COUNT(*) AS n
    FROM notifiche_app
    WHERE utente_id = ? AND letta = 0 AND eliminata = 0
  `).get(Number(userId || 0))?.n || 0;
}

async function sendPushToUserIds(userIds = [], payload = {}) {
  if (!isPushConfigured()) {
    return { sent: 0, failed: 0, skipped: true, reason: 'not_configured' };
  }

  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(v => Number(v || 0)).filter(v => v > 0))];
  if (!ids.length) return { sent: 0, failed: 0, skipped: true, reason: 'no_users' };

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT s.id, s.utente_id, s.endpoint, s.subscription_json
    FROM web_push_subscriptions s
    JOIN utenti u ON u.id = s.utente_id
    WHERE s.enabled = 1 AND u.attivo = 1 AND s.utente_id IN (${placeholders})
  `).all(...ids);

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const unreadCount = getUnreadNotificationCount(row.utente_id);
      const message = JSON.stringify({
        title: payload.title || 'Nuova notifica Horygon',
        body: payload.body || '',
        icon: payload.icon || '/icons/icon-192.png',
        badge: payload.badge || '/icons/icon-192.png',
        tag: payload.tag || `horygon-${row.utente_id}`,
        url: payload.url || '/?openNotifications=1',
        data: {
          url: payload.url || '/?openNotifications=1',
          unreadCount,
          entitaTipo: payload.entitaTipo || null,
          entitaId: payload.entitaId || null
        }
      });
      await webpush.sendNotification(JSON.parse(row.subscription_json), message);
      db.prepare(`
        UPDATE web_push_subscriptions
        SET last_success_at = datetime('now'),
            last_error = NULL,
            last_error_at = NULL,
            aggiornato_il = datetime('now')
        WHERE id = ?
      `).run(row.id);
      sent += 1;
    } catch (error) {
      failed += 1;
      const statusCode = Number(error?.statusCode || 0);
      const disable = statusCode === 404 || statusCode === 410;
      db.prepare(`
        UPDATE web_push_subscriptions
        SET enabled = CASE WHEN ? THEN 0 ELSE enabled END,
            last_error = ?,
            last_error_at = datetime('now'),
            aggiornato_il = datetime('now')
        WHERE id = ?
      `).run(
        disable ? 1 : 0,
        String(error?.message || 'push_send_failed').slice(0, 1000),
        row.id
      );
      writeSystemLog({
        livello: 'warning',
        origine: 'push.send',
        utente_id: row.utente_id,
        messaggio: error?.message || 'Invio web push fallito',
        stack: error?.stack || null,
        dettagli: {
          endpoint: row.endpoint,
          statusCode,
          disable
        }
      });
    }
  }

  return { sent, failed, skipped: false };
}

module.exports = {
  isPushConfigured,
  getPushPublicKey,
  upsertPushSubscription,
  disablePushSubscription,
  listUserPushSubscriptions,
  sendPushToUserIds
};
