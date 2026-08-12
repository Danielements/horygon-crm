// Allineamento dello storico allo snapshot IVA di riga.
//
// Tre principi, in ordine di importanza:
//
//   1. **non si riscrive un importo gia' salvato.** Le testate dei documenti
//      restano intoccate: sono il totale con cui il documento e' stato emesso,
//      concordato o pagato. Qui si riempiono solo colonne vuote.
//   2. **non si inventa un'aliquota.** Dove non c'e' modo di sapere quale IVA
//      fosse applicata, il campo resta vuoto e lo si vede: meglio una riga che
//      chiede all'operatore di scegliere che un 22% messo li' di default.
//   3. **si passa una volta sola.** Ogni passo lavora esclusivamente sulle
//      righe che hanno ancora il campo a NULL, quindi un riavvio non ripassa
//      sopra a cio' che nel frattempo qualcuno ha corretto a mano.

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// Riconosce a quale regola corrisponde una coppia (aliquota, natura) gia'
// presente sulle righe. Serve solo ad agganciare la provenienza: il calcolo
// resta quello dei campi salvati.
function buildRuleMatcher(db) {
  let rules = [];
  try {
    rules = db.prepare(`
      SELECT id, codice, aliquota_iva, natura_iva, riferimento_normativo
      FROM regole_iva
      WHERE tipo_regola = 'VAT_TREATMENT'
      ORDER BY priorita DESC, id ASC
    `).all();
  } catch {
    return () => null;
  }
  return (aliquota, natura) => {
    const naturaText = String(natura || '').trim().toUpperCase();
    if (naturaText) {
      return rules.find((rule) => String(rule.natura_iva || '').toUpperCase() === naturaText) || null;
    }
    const rate = Number(aliquota);
    if (!Number.isFinite(rate)) return null;
    return rules.find((rule) => !rule.natura_iva && Number(rule.aliquota_iva) === rate) || null;
  };
}

// Preventivi e fatture avevano gia' aliquota e natura sulla riga: manca solo
// dire da quale regola vengono.
function linkExistingLines(db, table, matcher) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, aliquota_iva, natura_iva
      FROM ${table}
      WHERE codice_iva IS NULL AND (aliquota_iva IS NOT NULL OR natura_iva IS NOT NULL)
    `).all();
  } catch {
    return 0;
  }
  const update = db.prepare(`
    UPDATE ${table}
    SET regola_iva_id = ?, codice_iva = ?, riferimento_normativo = COALESCE(riferimento_normativo, ?)
    WHERE id = ?
  `);
  let linked = 0;
  for (const row of rows) {
    const rule = matcher(row.aliquota_iva, row.natura_iva);
    if (!rule) continue;
    update.run(rule.id, rule.codice, rule.riferimento_normativo, row.id);
    linked += 1;
  }
  return linked;
}

// `fatture_righe` porta gia' il riferimento normativo da sola: non va toccato,
// e' quello con cui la fattura e' stata trasmessa.
function linkInvoiceLines(db, matcher) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, aliquota_iva, natura_iva
      FROM fatture_righe
      WHERE codice_iva IS NULL AND (aliquota_iva IS NOT NULL OR natura_iva IS NOT NULL)
    `).all();
  } catch {
    return 0;
  }
  const update = db.prepare('UPDATE fatture_righe SET regola_iva_id = ?, codice_iva = ? WHERE id = ?');
  let linked = 0;
  for (const row of rows) {
    const rule = matcher(row.aliquota_iva, row.natura_iva);
    if (!rule) continue;
    update.run(rule.id, rule.codice, row.id);
    linked += 1;
  }
  return linked;
}

// Aliquota implicita di un ordine storico: le righe non ne avevano una, la
// testata si'. `iva / imponibile` la restituisce solo quando l'ordine e'
// interamente a una sola aliquota, che e' l'unico caso in cui dedurla e'
// legittimo. Su un ordine a IVA mista il rapporto darebbe un numero medio che
// non e' l'aliquota di nessuna riga: li' si lascia vuoto.
function inferHeaderRate(imponibile, iva) {
  const base = Number(imponibile);
  const tax = Number(iva);
  if (!Number.isFinite(base) || !Number.isFinite(tax) || base <= 0) return null;
  if (tax === 0) return null;
  const rate = round2((tax / base) * 100);
  const known = [4, 5, 10, 22];
  return known.includes(rate) ? rate : null;
}

// Le righe ordine non avevano ne' dati fiscali ne' importi. Si ricostruiscono
// da tre fonti, in quest'ordine di attendibilita':
//   1. la riga del preventivo da cui l'ordine e' nato, che e' la condizione
//      davvero concordata col cliente;
//   2. l'aliquota implicita nella testata, se l'ordine e' a aliquota unica;
//   3. niente, e la riga resta da completare a mano.
function fillOrderLines(db, matcher) {
  let orders = [];
  try {
    orders = db.prepare(`
      SELECT o.id, o.preventivo_id, o.imponibile, o.iva
      FROM ordini o
      WHERE EXISTS (
        SELECT 1 FROM ordini_righe r
        WHERE r.ordine_id = o.id AND r.imponibile IS NULL
      )
    `).all();
  } catch {
    return { orders: 0, lines: 0, unresolved: 0, mismatched: [] };
  }

  const selectLines = db.prepare(`
    SELECT r.id, r.prodotto_id, r.quantita, r.prezzo_unitario, r.sconto, p.nome
    FROM ordini_righe r
    LEFT JOIN prodotti p ON p.id = r.prodotto_id
    WHERE r.ordine_id = ? AND r.imponibile IS NULL
    ORDER BY r.id
  `);
  const selectQuoteLines = db.prepare(`
    SELECT prodotto_id, descrizione, aliquota_iva, natura_iva, riferimento_normativo, codice_iva, regola_iva_id
    FROM preventivi_righe
    WHERE preventivo_id = ?
    ORDER BY id
  `);
  const update = db.prepare(`
    UPDATE ordini_righe SET
      descrizione = COALESCE(descrizione, ?),
      imponibile = ?, aliquota_iva = ?, natura_iva = ?, importo_iva = ?, totale_riga = ?,
      regola_iva_id = ?, codice_iva = ?, riferimento_normativo = ?
    WHERE id = ?
  `);

  let lines = 0;
  let unresolved = 0;
  const mismatched = [];

  for (const order of orders) {
    const orderLines = selectLines.all(order.id);
    const quoteLines = order.preventivo_id ? selectQuoteLines.all(order.preventivo_id) : [];
    const headerRate = inferHeaderRate(order.imponibile, order.iva);
    let sumImponibile = 0;
    let sumImposta = 0;

    orderLines.forEach((line, index) => {
      // Abbinamento con il preventivo: prima per articolo, poi per posizione.
      // La conversione copiava le righe nell'ordine in cui stavano, quindi la
      // posizione e' un ripiego ragionevole quando l'articolo non basta.
      const byProduct = line.prodotto_id
        ? quoteLines.find((q) => String(q.prodotto_id) === String(line.prodotto_id))
        : null;
      const source = byProduct || quoteLines[index] || null;

      const quantita = Number(line.quantita || 0) || 0;
      const prezzo = Number(line.prezzo_unitario || 0) || 0;
      const sconto = Number(line.sconto || 0) || 0;
      const imponibile = round2(Math.max(0, quantita * prezzo - sconto));

      const natura = source?.natura_iva || null;
      const aliquota = natura
        ? 0
        : (source && source.aliquota_iva !== null && source.aliquota_iva !== undefined
            ? Number(source.aliquota_iva)
            : headerRate);

      if (aliquota === null || aliquota === undefined) unresolved += 1;

      const importoIva = natura || !aliquota ? 0 : round2(imponibile * aliquota / 100);
      const rule = source?.regola_iva_id
        ? { id: source.regola_iva_id, codice: source.codice_iva, riferimento_normativo: source.riferimento_normativo }
        : matcher(aliquota, natura);

      update.run(
        source?.descrizione || line.nome || null,
        imponibile,
        aliquota ?? null,
        natura,
        importoIva,
        round2(imponibile + importoIva),
        rule?.id || null,
        rule?.codice || null,
        source?.riferimento_normativo || rule?.riferimento_normativo || null,
        line.id
      );
      sumImponibile = round2(sumImponibile + imponibile);
      sumImposta = round2(sumImposta + importoIva);
      lines += 1;
    });

    // Controllo di quadratura richiesto prima di considerare fatta la
    // migrazione: la somma delle righe deve tornare con la testata. Se non
    // torna **la testata non si tocca** — e' il totale storico — ma il caso
    // viene segnalato, perche' significa che quell'ordine andra' guardato.
    const headerImponibile = round2(order.imponibile);
    const headerIva = round2(order.iva);
    const differs = Math.abs(sumImponibile - headerImponibile) > 0.01
      || Math.abs(sumImposta - headerIva) > 0.01;
    if (differs && (headerImponibile || headerIva)) {
      mismatched.push({
        ordine_id: order.id,
        testata: { imponibile: headerImponibile, iva: headerIva },
        righe: { imponibile: sumImponibile, iva: sumImposta }
      });
    }
  }

  return { orders: orders.length, lines, unresolved, mismatched };
}

function backfillSnapshotIva(db) {
  const matcher = buildRuleMatcher(db);
  const quotes = linkExistingLines(db, 'preventivi_righe', matcher);
  const invoices = linkInvoiceLines(db, matcher);
  const orders = fillOrderLines(db, matcher);
  return { preventivi: quotes, fatture: invoices, ordini: orders };
}

module.exports = { backfillSnapshotIva, buildRuleMatcher, inferHeaderRate };
