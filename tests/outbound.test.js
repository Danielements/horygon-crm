process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-outbound';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db/database');
const { inTestRun, outboundBlocked } = require('../src/services/outbound');
const { sendMail, notifyUsersWithEmail } = require('../src/services/google');

// Questi test valgono per quello che impediscono: se un giorno la guardia
// sparisce, una corsa di `npm test` torna a mandare posta vera dalle caselle
// dei colleghi, e ce ne accorgeremmo dalla loro inbox invece che da qui.

test('la corsa di test viene riconosciuta senza doverlo dichiarare', () => {
  assert.equal(inTestRun(), true);
});

test('i canali in uscita sono bloccati durante i test', () => {
  assert.equal(outboundBlocked('gmail', { to: 'nessuno@example.com' }), true);
  assert.equal(outboundBlocked('web-push', {}), true);
});

test('il blocco si toglie solo dichiarandolo a voce alta', () => {
  process.env.HORYGON_ALLOW_OUTBOUND = '1';
  try {
    assert.equal(outboundBlocked('gmail', {}), false);
  } finally {
    delete process.env.HORYGON_ALLOW_OUTBOUND;
  }
  assert.equal(outboundBlocked('gmail', {}), true);
});

// Il punto vero: la guardia sta *prima* di Google. L'utente 1 qui non ha un
// client utilizzabile, quindi se il controllo fosse dopo otterremmo l'eccezione
// 'Google non connesso' invece della risposta bloccata.
test('sendMail non arriva a chiamare Gmail', async () => {
  const esito = await sendMail(1, 'nessuno@example.com', 'Oggetto di prova', 'Corpo di prova');
  assert.deepEqual(esito, { blocked: true });
});

// La seconda meta' del problema: anche quando gli invii sono permessi, una
// notifica interna non deve diventare una circolare. In produzione gli utenti
// attivi sono sette, e tre hanno un indirizzo fuori dal dominio aziendale.
test('una notifica interna manda una mail sola, alla casella aziendale', async () => {
  const marker = `OUTBOUND-${Date.now()}`;
  const settingKey = 'automation.email_users_order_status';
  const precedente = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(settingKey)?.value;
  db.prepare("INSERT INTO app_settings (key, value, type) VALUES (?,?, 'boolean') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(settingKey, '1');

  try {
    const esito = await notifyUsersWithEmail({
      senderUserId: 1,
      tipo: 'info',
      titolo: `Prova destinatari ${marker}`,
      messaggio: 'Verifica che il destinatario sia uno solo',
      emailSettingKey: settingKey
    });

    // Un destinatario, non uno per utente attivo.
    assert.deepEqual(esito.email.recipients, ['info@horygon.com']);
    // E comunque nessun invio parte: la guardia della corsa di test viene
    // prima, e li conta come bloccati.
    assert.equal(esito.email.sent, 0);
    assert.equal(esito.email.blocked, 1);
    // La notifica in app invece resta, e resta per tutti.
    assert.equal(esito.notifiedUsers > 0, true);
  } finally {
    if (precedente === undefined) db.prepare('DELETE FROM app_settings WHERE key = ?').run(settingKey);
    else db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(precedente, settingKey);
    db.prepare("DELETE FROM notifiche_app WHERE titolo LIKE ?").run(`%${marker}%`);
  }
});
