'use strict';

// Categorizzazione euristica degli idpar (dizionario ricambi RTWS/BDRT) in
// categorie navigabili per i menu annidati del bot. Basata su parole chiave
// nella descrizione. Condivisa tra parts.js (runtime menu) e lo script di import.
//
// L'ordine conta: le regole piu' specifiche vanno prima delle generiche.

// Elenco categorie mostrate nei menu (ordine di presentazione).
const IDPAR_CATEGORIES = [
  'Cristalli',
  'Filtri',
  'Freni',
  'Sospensioni e sterzo',
  'Illuminazione',
  'Retrovisori',
  'Raffreddamento e clima',
  'Alimentazione e scarico',
  'Motore',
  'Trasmissione',
  'Elettrico',
  'Carrozzeria',
  'Interni',
  'Altro'
];

// Regole ordinate: prima che matcha vince.
const CATEGORY_RULES = [
  ['Cristalli', /cristall|parabrezz|lunott|\bvetro\b|alzacristall|raschiavetr/i],
  ['Filtri', /filtro|filtre/i],
  ['Freni', /freno|freni|pastigli|disco freno|dischi freno|pinza|ganasce|tamburo|servofreno|pompa freno|cilindretto freno|\babs\b|cavo freno/i],
  ['Sospensioni e sterzo', /ammortizzatore|molla|braccio oscill|braccio sosp|sospension|barra stabil|barra trasvers|silent|testina|tirante|semiasse|giunto omocinetic|mozzo|cuscinetto ruota|sterz|scatola guida|piantone|cremagliera|assale/i],
  ['Illuminazione', /proiettore|\bfaro\b|\bfari\b|fanale|fanalino|lampad|catadiottr|catarifrangent|indicatore direzion|\bfreccia\b|luce targa|plafonier/i],
  ['Retrovisori', /retrovisor|specchi|calotta/i],
  ['Raffreddamento e clima', /radiatore|elettroventol|termostato|compressore a\/?c|condensatore|evaporatore|climatizz|intercooler|manicotto|vaschetta|ventola/i],
  ['Alimentazione e scarico', /serbatoio|pompa carburant|pompa benzina|pompa gasolio|marmitt|silenziatore|catalizz|convertitore catalit|scarico|\bfap\b|\bdpf\b|sonda lambda|corpo farfallat|iniettor|collettore aspir|collettore scaric|egr/i],
  ['Motore', /\bmotore\b|pistone|biella|albero motore|albero a camme|distribuzione|cinghia|catena distrib|valvola|testata|guarnizione|pompa acqua|pompa olio|coppa olio|pescante|candel|candelett|bobina|turbina|puleggia|carter|volano|basamento|monoblocco/i],
  ['Trasmissione', /cambio|frizione|disco frizione|spingidisco|reggispinta|differenziale|convertitore|albero trasmiss|scatola cambio|leva cambio/i],
  ['Elettrico', /alternatore|motorino avviament|batteria|centralina|sensore|interruttore|\brele\b|\brelè\b|fusibil|cablaggio|clacson|avvisatore|tergicrist|tergilunott|tergiparabrezz|motorino terg|spazzol|bloccasterzo/i],
  ['Carrozzeria', /paraurti|cofano|portello|parafango|fiancat|fianchetto|montante|traversa|longherone|portiera|sportello|maniglia|serratura|cerniera|modanatura|lamierat|padiglione|passaruota|griglia|spoiler|minigonna|assorbitore urti|rostro|staffa paraurt/i],
  ['Interni', /sedile|cruscotto|plancia|tappetin|rivestiment|appoggiatesta|appoggiabracci|cintura|airbag|volante|pedaliera|fodera|selleria|bocchett|cassetto|pomello|tunnel/i]
];

function categorizeIdparDescription(descrizione) {
  const d = String(descrizione || '').toLowerCase();
  if (!d) return 'Altro';
  for (let i = 0; i < CATEGORY_RULES.length; i++) {
    if (CATEGORY_RULES[i][1].test(d)) return CATEGORY_RULES[i][0];
  }
  return 'Altro';
}

module.exports = { IDPAR_CATEGORIES, categorizeIdparDescription };
