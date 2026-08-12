// Nessun canale in uscita puo' partire da una corsa di test.
//
// I test di questo progetto girano sulle rotte vere e sul database vero, che in
// sviluppo e' una copia della produzione: dentro ci sono i token Google buoni e
// le iscrizioni push dei colleghi. Provare la catena preventivo -> ordine ->
// fattura significa portare l'ordine a 'confermato', e quel cambio di stato
// notifica via mail tutti gli utenti attivi. Il 12 agosto 2026 sono uscite
// cosi' 58 mail vere verso caselle vere, per ordini che a fine corsa la pulizia
// dei test aveva gia' cancellato.
//
// La guardia sta al punto di uscita e non dentro i test di proposito: se
// stesse nei test, ogni test nuovo dovrebbe ricordarsi di disinnescare
// qualcosa, e prima o poi qualcuno se ne dimentica. Qui invece e' il canale a
// rifiutarsi di partire, chiunque lo chiami.

// `node --test` avvia ogni file in un processo figlio con NODE_TEST_CONTEXT
// valorizzato ('child-v8'): e' il segnale piu' onesto che abbiamo, perche' non
// dipende da come la suite viene lanciata ne' da variabili da ricordarsi.
function inTestRun() {
  return Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === 'test';
}

// L'unica via per mandare qualcosa davvero da un test e' chiederlo a voce alta.
function outboundAllowed() {
  return process.env.HORYGON_ALLOW_OUTBOUND === '1';
}

// Ritorna true se la chiamata va fermata. Il chiamante decide cosa rispondere:
// qui interessa solo che non esca nulla e che a schermo resti scritto perche'.
function outboundBlocked(canale, dettagli = {}) {
  if (!inTestRun() || outboundAllowed()) return false;
  console.warn(`[outbound] ${canale}: invio bloccato, corsa di test`, dettagli);
  return true;
}

module.exports = { inTestRun, outboundAllowed, outboundBlocked };
