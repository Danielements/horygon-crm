// Firma qualificata remota della richiesta SMTS — predisposizione, non ancora
// attiva.
//
// Oggi la firma della richiesta massiva e' manuale (FirmaOK di Poste, PIN + OTP,
// nessuna API): il ciclo SMTS si ferma in `CREATED` finche' l'operatore non
// carica il `.p7m`. Questo modulo esiste per il giorno in cui HORYGON avra' un
// sigillo/firma qualificata **server-to-server**: allora la riconciliazione
// giornaliera potra' firmare da sola, senza toccare il motore SMTS.
//
// L'interfaccia attesa di un provider:
//   isAvailable(): boolean
//   async signJob({ jobId, tenantId, utenteId }): void   // internamente:
//        getRequestToSign -> firma remota -> attachSignedRequest
//
// Finche' `sdi.massive.signature.mode` non vale `remote` con un provider
// configurato, `getRemoteSignatureProvider()` torna null e la richiesta resta in
// attesa di firma manuale.

const { getSetting } = require('./google');

function currentMode() {
  return String(getSetting('sdi.massive.signature.mode', 'external') || 'external').trim().toLowerCase();
}

// Ritorna un provider di firma remota **solo** quando esiste davvero. Oggi:
// mai. Il chiamante deve trattare `null` come "firma non automatizzabile" e
// lasciare il job in attesa di firma manuale.
function getRemoteSignatureProvider() {
  if (currentMode() !== 'remote') return null;
  // Punto di innesto futuro: qui si istanzierebbe il RemoteQualifiedSignatureProvider
  // reale (es. sigillo qualificato con API). Non ancora implementato: torniamo
  // null di proposito, cosi' il flusso ripiega sulla firma manuale invece di
  // fingere un'automazione che non c'e'.
  return null;
}

module.exports = { getRemoteSignatureProvider, currentMode };
