process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-outbound';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inTestRun, outboundBlocked } = require('../src/services/outbound');
const { sendMail } = require('../src/services/google');

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
