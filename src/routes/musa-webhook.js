// Webhook Stripe per MUSA. Montato con body RAW e senza auth (Stripe non manda
// JWT): la firma e' verificata via MUSA_STRIPE_WEBHOOK_SECRET. Stripe resta la
// fonte di verita' (il CRM legge live), quindi qui registriamo l'evento per
// audit/idempotenza e rispondiamo 200.

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const stripe = require('../services/stripe-client');

router.post('/', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.verifyWebhook(req.body, sig);
  } catch (e) {
    try { require('../services/system-log').writeSystemLog('warn', 'musa-webhook', `Firma rifiutata: ${e.message}`, {}); } catch {}
    return res.status(400).send(`Webhook error: ${e.message}`);
  }
  try {
    const payload = JSON.stringify(event);
    db.prepare('INSERT OR IGNORE INTO musa_stripe_events (stripe_event_id, type, livemode, payload) VALUES (?, ?, ?, ?)')
      .run(event.id, event.type, event.livemode ? 1 : 0, payload.slice(0, 200000));
  } catch (e) {
    try { require('../services/system-log').writeSystemLog('error', 'musa-webhook', e.message, { type: event && event.type }); } catch {}
  }
  res.json({ received: true });
});

module.exports = router;
