// QualifiedSignatureProvider — astrazione della firma qualificata della
// richiesta SMTS. Non tocca il motore (`SdiHistoricalSyncService`/`sdi-backfill`):
// cambia solo *chi* produce il `.p7m`.
//
//   isAutomatic(): boolean         puo' firmare senza una persona?
//   async sign({ jobId, tenantId, utenteId })   solo se isAutomatic():
//        getRequestToSign -> firma -> attachSignedRequest
//
// Oggi la firma e' manuale (FirmaOK, PIN+OTP, nessuna API): l'unico provider
// usabile e' ManualP7mSignatureProvider, che NON e' automatico. Il giorno del
// sigillo qualificato server-to-server si abilita RemoteQualifiedSignatureProvider
// e la riconciliazione diventa automatica senza altre modifiche.

const { getSetting } = require('./google');

class ManualP7mSignatureProvider {
  get name() { return 'ManualP7mSignatureProvider'; }
  // Richiede l'operatore: scarica l'XML, firma con FirmaOK, ricarica il .p7m.
  isAutomatic() { return false; }
}

class RemoteQualifiedSignatureProvider {
  get name() { return 'RemoteQualifiedSignatureProvider'; }
  // Non ancora configurato: finche' non esiste un sigillo qualificato con API,
  // non e' automatico e la richiesta resta in attesa di firma manuale.
  isAutomatic() { return false; }
  // async sign({ jobId, tenantId, utenteId }) { /* futuro: firma remota */ }
}

function signatureMode() {
  return String(getSetting('sdi.massive.signature.mode', 'external') || 'external').trim().toLowerCase();
}

function getQualifiedSignatureProvider() {
  if (signatureMode() === 'remote') return new RemoteQualifiedSignatureProvider();
  // `external` (e `local`, che il motore gestisce da se') -> dal punto di vista
  // dell'automazione e' firma manuale.
  return new ManualP7mSignatureProvider();
}

module.exports = {
  ManualP7mSignatureProvider,
  RemoteQualifiedSignatureProvider,
  getQualifiedSignatureProvider,
  signatureMode
};
