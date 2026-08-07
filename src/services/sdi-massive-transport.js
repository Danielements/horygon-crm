const https = require('https');
const { getSetting } = require('./google');
const { postSoapToSdi } = require('./sdi-transmission');

// Trasporto reale verso sm-scarico-file.
//
// Riusa il materiale mTLS del canale SDICoop, perche' i Servizi Massivi sono
// riservati ai provider gia' accreditati a SdICoop e viaggiano sullo stesso
// canale mutuamente autenticato. Restano invece separate le credenziali di
// FIRMA della richiesta (sdi.massive.signature.*), che sono un'altra cosa:
// una firma qualificata del titolare della partita IVA, non un certificato
// di trasporto.
//
// Il client accetta qualunque funzione con questa forma, quindi in test si usa
// uno stub e qui non si tocca la rete.

function createMassiveTransport({ mode = 'production' } = {}) {
  return async function transport({ endpoint, soapAction, contentType, body }) {
    const response = await postSoapToSdi(
      endpoint,
      { body, contentType: contentType || 'text/xml; charset=UTF-8' },
      mode,
      { soapAction }
    );
    return {
      statusCode: response.statusCode,
      statusMessage: response.statusMessage,
      headers: response.headers,
      body: response.bodyBuffer
    };
  };
}

// Diagnostica di raggiungibilita' senza inviare alcuna richiesta applicativa:
// utile prima del primo backfill, quando il censimento potrebbe non essere
// ancora attivo e vogliamo distinguere un problema di rete da un ER02.
function probeMassiveEndpoint(timeoutMs = 5000) {
  const endpoint = String(getSetting('sdi.massive.endpoint', 'https://servizi.fatturapa.it/sm-scarico-file') || '').trim();
  if (!endpoint) return Promise.resolve({ ok: false, reason: 'Endpoint servizi massivi non configurato' });
  const target = new URL(endpoint);
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: target.hostname, port: target.port || 443, path: target.pathname, method: 'HEAD', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve({ ok: true, endpoint, statusCode: res.statusCode });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', (error) => resolve({ ok: false, endpoint, reason: error.message, code: error.code || null }));
    req.end();
  });
}

module.exports = { createMassiveTransport, probeMassiveEndpoint };
