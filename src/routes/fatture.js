const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware, requirePermesso } = require('../middleware/auth');
const db = require('../db/database');
const XLSX = require('xlsx');
const crypto = require('crypto');
const { importInvoiceXml } = require('../services/fattura-import');
const { calcolaTotaliDocumento } = require('../services/iva');
const { createFatturaPdfBuffer } = require('../services/document-pdf');
const { nextNumeroFattura } = require('../services/fattura-numerazione');
const { writeAudit } = require('../services/audit');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/fatture';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

router.use(authMiddleware);

function sqlNullable(value) {
  return value === undefined ? null : value;
}

// Righe e riepilogo passano dal motore IVA: le stesse formule di preventivi e
// ordini, e un riepilogo raggruppato per aliquota, Natura ed esigibilita'.
// Se il client manda un riepilogo suo lo si rispetta — la griglia del riepilogo
// e' editabile a mano apposta, per i casi che il calcolo non copre.
function prepareInvoiceLines(righe = [], esigibilitaIva = null) {
  const totali = calcolaTotaliDocumento(righe || [], { esigibilita_iva: esigibilitaIva });
  return {
    righe: totali.righe.map((calc, index) => ({ ...((righe || [])[index] || {}), ...calc })),
    totali
  };
}

// Lista fatture
router.get('/', requirePermesso('fatture', 'read'), (req, res) => {
  const { tipo, stato, direzione } = req.query;
  // Lo stato verso SdI si legge dai flussi e dalle notifiche, non dalla sola
  // colonna `stato_sdi`: quella dice a che punto e' la generazione, non se il
  // documento e' partito ne' se e' tornata una ricevuta.
  let sql = `SELECT f.*,
      COALESCE(a.ragione_sociale, f.cliente_fornitore_label) AS ragione_sociale,
      (SELECT COUNT(*) FROM fatture_sdi_flussi fl
        WHERE fl.fattura_id = f.id AND COALESCE(fl.direzione,'outbound') = 'outbound') AS sdi_flussi,
      (SELECT COUNT(*) FROM fatture_sdi_flussi fl
        WHERE fl.fattura_id = f.id AND COALESCE(fl.direzione,'outbound') = 'outbound'
          AND fl.stato = 'firma_richiesta') AS sdi_da_firmare,
      (SELECT COUNT(*) FROM fatture_sdi_flussi fl
        WHERE fl.fattura_id = f.id AND COALESCE(fl.direzione,'outbound') = 'outbound'
          AND (fl.inviato_il IS NOT NULL OR fl.identificativo_sdi IS NOT NULL)) AS sdi_inviati,
      (SELECT fl.identificativo_sdi FROM fatture_sdi_flussi fl
        WHERE fl.fattura_id = f.id AND fl.identificativo_sdi IS NOT NULL
        ORDER BY fl.id DESC LIMIT 1) AS sdi_identificativo,
      (SELECT COUNT(*) FROM fatture_sdi_notifiche nt WHERE nt.fattura_id = f.id) AS sdi_notifiche,
      (SELECT nt.tipo_notifica FROM fatture_sdi_notifiche nt
        WHERE nt.fattura_id = f.id ORDER BY nt.id DESC LIMIT 1) AS sdi_ultima_notifica,
      (SELECT nt.stato_normalizzato FROM fatture_sdi_notifiche nt
        WHERE nt.fattura_id = f.id ORDER BY nt.id DESC LIMIT 1) AS sdi_ultimo_esito
    FROM fatture f LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id WHERE 1=1`;
  const params = [];
  if (tipo) { sql += ' AND f.tipo = ?'; params.push(tipo); }
  if (direzione) { sql += ' AND COALESCE(f.direzione, CASE WHEN f.tipo = "emessa" THEN "attiva" ELSE "passiva" END) = ?'; params.push(direzione); }
  if (stato) { sql += ' AND f.stato = ?'; params.push(stato); }
  sql += ' ORDER BY f.data DESC';
  res.json(db.prepare(sql).all(...params));
});

// Singola fattura con righe
router.get('/:id', requirePermesso('fatture', 'read'), (req, res) => {
  // Il tipo della controparte serve all'interfaccia: i riferimenti CIG/CUP e
  // l'esigibilita' IVA hanno senso solo verso la PA.
  const f = db.prepare(`
    SELECT f.*,
           COALESCE(a.ragione_sociale, f.cliente_fornitore_label) AS ragione_sociale,
           a.tipo AS anagrafica_tipo,
           a.tipologia_cliente AS anagrafica_tipologia
    FROM fatture f
    LEFT JOIN anagrafiche a ON a.id = f.anagrafica_id
    WHERE f.id = ?
  `).get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Non trovata' });
  f.righe = db.prepare(`SELECT r.*, p.nome, p.codice_interno FROM fatture_righe r LEFT JOIN prodotti p ON p.id = r.prodotto_id WHERE r.fattura_id = ?`).all(req.params.id);
  f.riepilogo_iva = db.prepare(`SELECT * FROM fatture_iva_riepilogo WHERE fattura_id = ? ORDER BY id`).all(req.params.id);
  res.json(f);
});

// Copia di cortesia. Il documento fiscale resta l'XML: questo PDF serve a
// leggerla, e infatti lo dice in fondo alla pagina.
router.get('/:id/pdf-cortesia', requirePermesso('fatture', 'read'), async (req, res) => {
  try {
    const pdf = await createFatturaPdfBuffer(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=${pdf.filename}`);
    res.send(pdf.buffer);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Una fattura si elimina solo finche' non e' uscita.
//
// Il discrimine non e' lo stato in interfaccia ma il fatto che di quel
// documento esista traccia al SdI: un flusso trasmesso, un identificativo, un
// numero SdI. Da quel momento la fattura e' un documento fiscale e si rettifica
// con una nota di credito, non si cancella. Le fatture ricevute o scaricate
// dallo storico non si toccano proprio: quelle non sono nostre.
function motivoNonEliminabile(fattura) {
  if (!fattura) return 'Fattura non trovata';
  if (fattura.source && fattura.source !== 'CRM') {
    return `Questa fattura proviene da ${fattura.source} e non e' un documento emesso da qui: non puo essere eliminata.`;
  }
  if (fattura.tipo !== 'emessa') {
    return 'Le fatture ricevute non si eliminano: sono documenti altrui gia acquisiti.';
  }
  if (fattura.sdi_id) {
    // Un identificativo SdI vero e' numerico. Quando non lo e', quasi sempre
    // e' il Codice Univoco Ufficio del cliente finito nel campo sbagliato, e
    // dirlo evita di far cercare una trasmissione che non c'e' mai stata.
    if (!/^\d+$/.test(String(fattura.sdi_id).trim())) {
      return `Il campo Identificativo SdI contiene "${fattura.sdi_id}", che non e un identificativo SdI (quelli sono numerici e li assegna SdI). `
        + 'Finche resta valorizzato la fattura risulta trasmessa: se e il Codice Univoco Ufficio del cliente, svuota il campo dalla scheda della fattura e riprova.';
    }
    return `La fattura ha un identificativo SdI (${fattura.sdi_id}): e gia stata trasmessa e va rettificata con una nota di credito.`;
  }
  const trasmesso = db.prepare(`
    SELECT id, nome_file, identificativo_sdi, stato
    FROM fatture_sdi_flussi
    WHERE fattura_id = ? AND COALESCE(direzione, 'outbound') = 'outbound'
      AND (identificativo_sdi IS NOT NULL OR inviato_il IS NOT NULL)
    LIMIT 1
  `).get(fattura.id);
  if (trasmesso) {
    return `Il flusso ${trasmesso.nome_file || trasmesso.id} risulta trasmesso al SdI: la fattura va rettificata con una nota di credito.`;
  }
  return null;
}

router.delete('/:id', requirePermesso('fatture', 'delete'), (req, res) => {
  const fattura = db.prepare('SELECT id, numero, tipo, source, sdi_id FROM fatture WHERE id = ?').get(req.params.id);
  if (!fattura) return res.status(404).json({ error: 'Fattura non trovata' });
  const motivo = motivoNonEliminabile(fattura);
  if (motivo) return res.status(409).json({ error: motivo });

  const notaCollegata = db.prepare('SELECT id, numero FROM fatture WHERE fattura_riferimento_id = ? LIMIT 1').get(fattura.id);
  if (notaCollegata) {
    return res.status(409).json({
      error: `Esiste la nota di credito ${notaCollegata.numero || notaCollegata.id} che si riferisce a questa fattura: eliminare prima quella.`
    });
  }

  try {
    db.exec('BEGIN');
    // I flussi mai trasmessi se ne vanno con la fattura; il progressivo che
    // avevano allocato resta bruciato, perche' un nome file gia' proposto al
    // SdI non si riusa comunque.
    db.prepare('DELETE FROM fatture_sdi_flussi WHERE fattura_id = ?').run(fattura.id);
    db.prepare('DELETE FROM fatture_righe WHERE fattura_id = ?').run(fattura.id);
    db.prepare('DELETE FROM fatture_iva_riepilogo WHERE fattura_id = ?').run(fattura.id);
    db.prepare('DELETE FROM fatture WHERE id = ?').run(fattura.id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(400).json({ error: e.message });
  }

  writeAudit({
    utente_id: req.user.id,
    azione: 'fattura_eliminata',
    entita_tipo: 'fattura',
    entita_id: fattura.id,
    dettagli: { numero: fattura.numero, tipo: fattura.tipo, source: fattura.source }
  });
  res.json({ ok: true });
});

// Nota di credito a storno di una fattura emessa.
//
// Ne ricopia righe e riepilogo con gli importi positivi: nel tracciato la nota
// di credito e' un TD04 e non porta segni meno, e' il tipo documento a dire che
// storna. Prende un numero della stessa serie e resta collegata all'originale,
// che finisce in DatiFattureCollegate.
router.post('/:id/nota-credito', requirePermesso('fatture', 'edit'), (req, res) => {
  const originale = db.prepare('SELECT * FROM fatture WHERE id = ?').get(req.params.id);
  if (!originale) return res.status(404).json({ error: 'Fattura non trovata' });
  if (originale.tipo !== 'emessa') {
    return res.status(400).json({ error: 'La nota di credito si emette a storno di una fattura emessa' });
  }
  const esistente = db.prepare('SELECT id, numero FROM fatture WHERE fattura_riferimento_id = ? LIMIT 1').get(originale.id);
  if (esistente) {
    return res.status(409).json({ error: `Esiste gia la nota di credito ${esistente.numero || esistente.id} per questa fattura` });
  }

  const righe = db.prepare('SELECT * FROM fatture_righe WHERE fattura_id = ? ORDER BY id').all(originale.id);
  if (!righe.length) return res.status(400).json({ error: 'La fattura non ha righe da stornare' });
  const riepilogo = db.prepare('SELECT * FROM fatture_iva_riepilogo WHERE fattura_id = ? ORDER BY id').all(originale.id);

  const data = String(req.body?.data || '').trim() || new Date().toISOString().slice(0, 10);
  const numero = nextNumeroFattura({ data }).numero;

  try {
    db.exec('BEGIN');
    const creata = db.prepare(`
      INSERT INTO fatture (
        numero, numero_documento, tipo, direzione, tipo_documento, anagrafica_id, ordine_id, data,
        imponibile, iva, totale, stato, stato_pagamento, valuta, partita_iva, codice_fiscale, note,
        origine_importazione, cig, cup, esigibilita_iva, fattura_riferimento_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      numero, numero, 'emessa', 'attiva', 'nota_credito',
      originale.anagrafica_id, originale.ordine_id, data,
      originale.imponibile, originale.iva, originale.totale,
      'ricevuta', 'da_pagare', originale.valuta || 'EUR',
      originale.partita_iva, originale.codice_fiscale,
      String(req.body?.note || '').trim() || `Storno della fattura ${originale.numero_documento || originale.numero}`,
      'nota_credito', originale.cig, originale.cup, originale.esigibilita_iva, originale.id
    );
    const notaId = Number(creata.lastInsertRowid);

    const insRiga = db.prepare(`
      INSERT INTO fatture_righe (
        fattura_id, prodotto_id, descrizione, quantita, prezzo_unitario, sconto, imponibile,
        aliquota_iva, natura_iva, importo_iva, totale_riga, regola_iva_id, codice_iva, riferimento_normativo
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    // Lo snapshot fiscale si copia, non si ricalcola: la nota deve stornare
    // esattamente il trattamento con cui la fattura era stata emessa, anche se
    // nel frattempo la regola IVA e' cambiata.
    righe.forEach((r) => insRiga.run(
      notaId, r.prodotto_id, r.descrizione, r.quantita, r.prezzo_unitario, r.sconto,
      r.imponibile, r.aliquota_iva, r.natura_iva, r.importo_iva, r.totale_riga,
      r.regola_iva_id, r.codice_iva, r.riferimento_normativo
    ));

    const insIva = db.prepare(`
      INSERT INTO fatture_iva_riepilogo (fattura_id, aliquota_iva, natura_iva, imponibile, imposta, riferimento_normativo)
      VALUES (?,?,?,?,?,?)
    `);
    riepilogo.forEach((r) => insIva.run(notaId, r.aliquota_iva, r.natura_iva, r.imponibile, r.imposta, r.riferimento_normativo));
    db.exec('COMMIT');

    writeAudit({
      utente_id: req.user.id,
      azione: 'nota_credito_creata',
      entita_tipo: 'fattura',
      entita_id: notaId,
      dettagli: { numero, storna: originale.numero_documento || originale.numero, fattura_id: originale.id, totale: originale.totale }
    });
    res.json({ ok: true, fattura_id: notaId, numero });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    res.status(400).json({ error: e.message });
  }
});

// Prossimo numero libero della serie dell'anno, per precompilare il modale.
router.get('/numerazione/prossimo', requirePermesso('fatture', 'read'), (req, res) => {
  res.json(nextNumeroFattura({ data: req.query.data || null }));
});

router.get('/:id/xml', requirePermesso('fatture', 'read'), (req, res) => {
  const f = db.prepare('SELECT id, xml_path FROM fatture WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Non trovata' });
  if (!f.xml_path) return res.status(404).json({ error: 'XML non disponibile' });
  const root = path.resolve(__dirname, '../../');
  const cleanRelativePath = String(f.xml_path).replace(/^[/\\]+/, '');
  const absolutePath = path.resolve(root, cleanRelativePath);
  const uploadsRoot = path.resolve(root, 'uploads');
  if (!absolutePath.startsWith(uploadsRoot + path.sep) || !fs.existsSync(absolutePath)) {
    return res.status(404).json({ error: 'XML non trovato' });
  }
  res.type('application/xml').send(fs.readFileSync(absolutePath, 'utf8'));
});

// Crea fattura manuale
router.post('/', requirePermesso('fatture', 'edit'), (req, res) => {
  const { numero, tipo, direzione, tipo_documento, anagrafica_id, ordine_id, data, scadenza, data_ricezione, imponibile, iva, totale, sdi_id, stato, stato_pagamento, valuta, partita_iva, codice_fiscale, note, righe, riepilogo_iva, cig, cup, esigibilita_iva } = req.body;
  try {
    const hashDocumento = buildDocumentHash({ numero, data, partita_iva, totale });
    const duplicate = db.prepare(`
      SELECT id, numero, data, partita_iva, totale
      FROM fatture
      WHERE hash_documento = ?
         OR (numero = ? AND COALESCE(data,'') = COALESCE(?, '') AND COALESCE(partita_iva,'') = COALESCE(?, '') AND COALESCE(totale,0) = COALESCE(?,0))
      LIMIT 1
    `).get(hashDocumento, numero, data, partita_iva, totale);
    if (duplicate) return res.status(400).json({ error: 'Fattura duplicata o gia importata' });
    const r = db.prepare(`INSERT INTO fatture (
      numero, numero_documento, tipo, direzione, tipo_documento, anagrafica_id, ordine_id, data, scadenza, data_ricezione,
      imponibile, iva, totale, sdi_id, stato, stato_pagamento, valuta, partita_iva, codice_fiscale, note, hash_documento, origine_importazione,
      cig, cup, esigibilita_iva
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      sqlNullable(numero), sqlNullable(numero), sqlNullable(tipo), direzione || (tipo === 'emessa' ? 'attiva' : 'passiva'), tipo_documento || 'fattura',
      sqlNullable(anagrafica_id), sqlNullable(ordine_id), sqlNullable(data), sqlNullable(scadenza), data_ricezione || null,
      sqlNullable(imponibile), sqlNullable(iva), sqlNullable(totale), sqlNullable(sdi_id), stato || 'ricevuta', stato_pagamento || 'da_pagare', valuta || 'EUR',
      partita_iva || null, codice_fiscale || null, sqlNullable(note), hashDocumento, 'manuale',
      sqlNullable(cig), sqlNullable(cup), sqlNullable(esigibilita_iva)
    );
    const id = r.lastInsertRowid;
    const prepared = prepareInvoiceLines(righe, esigibilita_iva);
    if (prepared.righe.length) {
      const ins = db.prepare(`INSERT INTO fatture_righe (
        fattura_id,prodotto_id,descrizione,quantita,prezzo_unitario,sconto,imponibile,aliquota_iva,natura_iva,importo_iva,totale_riga,
        regola_iva_id,codice_iva,riferimento_normativo
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      prepared.righe.forEach(riga => ins.run(
        id,
        riga.prodotto_id||null,
        sqlNullable(riga.descrizione),
        sqlNullable(riga.quantita),
        sqlNullable(riga.prezzo_unitario),
        riga.sconto || 0,
        riga.imponibile ?? null,
        riga.aliquota_iva ?? null,
        riga.natura_iva || null,
        riga.importo_iva ?? null,
        sqlNullable(riga.totale_riga),
        riga.regola_iva_id ?? null,
        riga.codice_iva || null,
        riga.riferimento_normativo || null
      ));
    }
    saveVatSummary(id, riepilogo_iva?.length ? riepilogo_iva : prepared.totali.riepilogo);
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', requirePermesso('fatture', 'edit'), (req, res) => {
  const { numero, tipo, direzione, tipo_documento, anagrafica_id, ordine_id, data, scadenza, data_ricezione, imponibile, iva, totale, sdi_id, stato, stato_pagamento, valuta, partita_iva, codice_fiscale, note, righe, riepilogo_iva, cig, cup, esigibilita_iva } = req.body;
  try {
    const hashDocumento = buildDocumentHash({ numero, data, partita_iva, totale });
    // I valori si normalizzano a null: un campo assente dal corpo della
    // richiesta arriva come undefined, che SQLite non sa legare, e la modifica
    // falliva con un errore che parlava di "parametro 5".
    const duplicate = db.prepare(`
      SELECT id FROM fatture
      WHERE id <> ?
        AND (hash_documento = ?
          OR (numero = ? AND COALESCE(data,'') = COALESCE(?, '') AND COALESCE(partita_iva,'') = COALESCE(?, '') AND COALESCE(totale,0) = COALESCE(?,0)))
      LIMIT 1
    `).get(req.params.id, sqlNullable(hashDocumento), sqlNullable(numero), sqlNullable(data), sqlNullable(partita_iva), sqlNullable(totale));
    if (duplicate) return res.status(400).json({ error: 'Esiste gia una fattura con gli stessi riferimenti' });
    // Il collegamento all'ordine non e' un campo del modale: se non arriva
    // nella richiesta va conservato, non azzerato. Rinumerare la fattura 6
    // dall'interfaccia le aveva staccato l'ordine di origine, e con quello il
    // riferimento che finisce in DatiOrdineAcquisto.
    const attuale = db.prepare('SELECT ordine_id FROM fatture WHERE id = ?').get(req.params.id);
    const ordineCollegato = ordine_id === undefined ? (attuale?.ordine_id ?? null) : sqlNullable(ordine_id);
    db.prepare(`UPDATE fatture SET
      numero=?, numero_documento=?, tipo=?, direzione=?, tipo_documento=?, anagrafica_id=?, ordine_id=?, data=?, scadenza=?, data_ricezione=?,
      imponibile=?, iva=?, totale=?, sdi_id=?, stato=?, stato_pagamento=?, valuta=?, partita_iva=?, codice_fiscale=?, note=?, hash_documento=?,
      cig=?, cup=?, esigibilita_iva=?
      WHERE id=?
    `).run(
      sqlNullable(numero), sqlNullable(numero), sqlNullable(tipo), direzione || (tipo === 'emessa' ? 'attiva' : 'passiva'), tipo_documento || 'fattura',
      sqlNullable(anagrafica_id), ordineCollegato, sqlNullable(data), sqlNullable(scadenza), data_ricezione || null,
      sqlNullable(imponibile), sqlNullable(iva), sqlNullable(totale), sqlNullable(sdi_id), stato || 'ricevuta', stato_pagamento || 'da_pagare', valuta || 'EUR',
      partita_iva || null, codice_fiscale || null, sqlNullable(note), hashDocumento,
      sqlNullable(cig), sqlNullable(cup), sqlNullable(esigibilita_iva), req.params.id
    );
    db.prepare('DELETE FROM fatture_righe WHERE fattura_id = ?').run(req.params.id);
    db.prepare('DELETE FROM fatture_iva_riepilogo WHERE fattura_id = ?').run(req.params.id);
    const prepared = prepareInvoiceLines(righe, esigibilita_iva);
    if (prepared.righe.length) {
      const ins = db.prepare(`INSERT INTO fatture_righe (
        fattura_id,prodotto_id,descrizione,quantita,prezzo_unitario,sconto,imponibile,aliquota_iva,natura_iva,importo_iva,totale_riga,
        regola_iva_id,codice_iva,riferimento_normativo
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      prepared.righe.forEach(riga => ins.run(
        req.params.id,
        riga.prodotto_id||null,
        sqlNullable(riga.descrizione),
        sqlNullable(riga.quantita),
        sqlNullable(riga.prezzo_unitario),
        riga.sconto || 0,
        riga.imponibile ?? null,
        riga.aliquota_iva ?? null,
        riga.natura_iva || null,
        riga.importo_iva ?? null,
        sqlNullable(riga.totale_riga),
        riga.regola_iva_id ?? null,
        riga.codice_iva || null,
        riga.riferimento_normativo || null
      ));
    }
    saveVatSummary(req.params.id, riepilogo_iva?.length ? riepilogo_iva : prepared.totali.riepilogo);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Upload PDF fattura
router.post('/:id/pdf', requirePermesso('fatture', 'edit'), upload.single('file'), (req, res) => {
  const path = `/uploads/fatture/${req.file.filename}`;
  db.prepare('UPDATE fatture SET pdf_path = ? WHERE id = ?').run(path, req.params.id);
  res.json({ path });
});

// Upload e parsing XML FatturaPA
router.post('/import/xml', requirePermesso('fatture', 'edit'), upload.single('file'), (req, res) => {
  try {
    const xml = fs.readFileSync(req.file.path, 'utf8');
    const result = importInvoiceXml(xml, {
      xmlPath: `/uploads/fatture/${req.file.filename}`,
      source: 'xml'
    });
    if (result.duplicate) return res.status(400).json({ error: 'Fattura duplicata o gia importata' });
    res.json({ id: result.id, parsed: result.parsed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/import/spreadsheet', requirePermesso('fatture', 'edit'), upload.single('file'), (req, res) => {
  try {
    const workbook = XLSX.readFile(req.file.path, { cellDates: true });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
    const imported = [];
    const skipped = [];
    rows.forEach((row, index) => {
      const numero = String(getRowValue(row, ['numero', 'Numero documento', 'Numero', 'numero_documento']) || '').trim();
      if (!numero) { skipped.push({ row: index + 2, reason: 'Numero mancante' }); return; }
      const totale = parseDecimal(getRowValue(row, ['totale', 'Totale documento', 'Totale', 'importo_totale'])) || 0;
      const data = normalizeDate(getRowValue(row, ['data', 'Data documento', 'Data', 'data_documento']));
      const partitaIva = sanitizeVatNumber(getRowValue(row, ['piva', 'Partita IVA', 'partita_iva', 'P.IVA'])) || null;
      const hashDocumento = buildDocumentHash({ numero, data, partita_iva: partitaIva, totale });
      const duplicate = db.prepare('SELECT id FROM fatture WHERE hash_documento = ? LIMIT 1').get(hashDocumento);
      if (duplicate) { skipped.push({ row: index + 2, reason: 'Duplicato' }); return; }
      const tipo = inferInvoiceType(row);
      const label = String(getRowValue(row, ['cliente', 'fornitore', 'Cliente/Fornitore', 'Ragione sociale', 'ragione_sociale']) || '').trim();
      const anagrafica = partitaIva
        ? db.prepare('SELECT id FROM anagrafiche WHERE piva = ?').get(partitaIva)
        : (label ? db.prepare('SELECT id FROM anagrafiche WHERE lower(ragione_sociale) = lower(?)').get(label) : null);
      const result = db.prepare(`INSERT INTO fatture (
        numero,numero_documento,tipo,direzione,tipo_documento,anagrafica_id,data,data_ricezione,imponibile,iva,totale,valuta,stato,stato_pagamento,partita_iva,codice_fiscale,cliente_fornitore_label,hash_documento,origine_importazione
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        numero, numero, tipo.tipo, tipo.direzione, tipo.tipo_documento,
        anagrafica?.id || null, data, normalizeDate(getRowValue(row, ['data_ricezione', 'Data ricezione'])) || null,
        parseDecimal(getRowValue(row, ['imponibile', 'Imponibile'])) || 0,
        parseDecimal(getRowValue(row, ['iva', 'IVA', 'imposta'])) || 0,
        totale,
        String(getRowValue(row, ['valuta', 'Valuta']) || 'EUR').trim() || 'EUR',
        String(getRowValue(row, ['stato', 'Stato']) || 'ricevuta').trim() || 'ricevuta',
        String(getRowValue(row, ['stato_pagamento', 'Stato pagamento']) || 'da_pagare').trim() || 'da_pagare',
        partitaIva,
        sanitizeFiscalCode(getRowValue(row, ['cf', 'Codice fiscale', 'codice_fiscale'])) || null,
        label || null,
        hashDocumento,
        'spreadsheet'
      );
      imported.push({ id: result.lastInsertRowid, numero });
    });
    res.json({ imported, skipped, totale: rows.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Aggiorna stato fattura
router.patch('/:id/stato', requirePermesso('fatture', 'edit'), (req, res) => {
  db.prepare('UPDATE fatture SET stato = ? WHERE id = ?').run(req.body.stato, req.params.id);
  res.json({ ok: true });
});

// Parser XML FatturaPA semplificato
function parseFatturaPA(xml) {
  const normalizedXml = stripXmlNamespaces(xml);
  const tag = (name, source = normalizedXml) => {
    const m = source.match(new RegExp(`<${name}[^>]*>([^<]*)<\/${name}>`, 'i'));
    return m ? m[1].trim() : null;
  };
  const supplierBlock = firstBlock(normalizedXml, 'CedentePrestatore');
  const supplierVatBlock = firstBlock(supplierBlock, 'IdFiscaleIVA');
  const fornitorePaese = tag('IdPaese', supplierVatBlock);
  const fornitoreCodice = tag('IdCodice', supplierVatBlock);
  const fornitorePiva = joinVatNumber(fornitorePaese, fornitoreCodice);
  const supplierName = firstNonEmpty([
    tag('Denominazione', supplierBlock),
    [tag('Nome', supplierBlock), tag('Cognome', supplierBlock)].filter(Boolean).join(' ').trim()
  ]);
  const righe = [];
  const righeMatch = normalizedXml.matchAll(/<DettaglioLinee>([\s\S]*?)<\/DettaglioLinee>/gi);
  for (const m of righeMatch) {
    const r = m[1];
    const qtag = (n) => { const x = r.match(new RegExp(`<${n}>([^<]*)<\/${n}>`, 'i')); return x ? x[1].trim() : null; };
    const quantita = parseDecimal(qtag('Quantita')) || 1;
    const prezzoUnitario = parseDecimal(qtag('PrezzoUnitario')) || 0;
    const totaleRiga = parseDecimal(qtag('PrezzoTotale')) || 0;
    const aliquotaIva = parseDecimal(qtag('AliquotaIVA')) || 0;
    righe.push({
      descrizione: qtag('Descrizione'),
      quantita,
      prezzo_unitario: prezzoUnitario,
      imponibile: totaleRiga,
      aliquota_iva: aliquotaIva,
      natura_iva: qtag('Natura'),
      importo_iva: null,
      totale_riga: totaleRiga,
    });
  }
  const riepilogo_iva = [];
  const riepiloghi = normalizedXml.matchAll(/<DatiRiepilogo>([\s\S]*?)<\/DatiRiepilogo>/gi);
  for (const m of riepiloghi) {
    const r = m[1];
    const qtag = (n) => { const x = r.match(new RegExp(`<${n}>([^<]*)<\/${n}>`, 'i')); return x ? x[1].trim() : null; };
    riepilogo_iva.push({
      aliquota_iva: parseDecimal(qtag('AliquotaIVA')) || 0,
      natura_iva: qtag('Natura'),
      imponibile: parseDecimal(qtag('ImponibileImporto')) || 0,
      imposta: parseDecimal(qtag('Imposta')) || 0,
      riferimento_normativo: qtag('RiferimentoNormativo')
    });
  }
  const imponibile = riepilogo_iva.length
    ? riepilogo_iva.reduce((sum, row) => sum + Number(row.imponibile || 0), 0)
    : righe.reduce((sum, row) => sum + Number(row.imponibile || 0), 0);
  const iva = riepilogo_iva.reduce((sum, row) => sum + Number(row.imposta || 0), 0);
  const totaleDocumento = parseDecimal(tag('ImportoTotaleDocumento')) || (imponibile + iva);
  const rawTipoDocumento = tag('TipoDocumento');
  return {
    numero: tag('Numero'),
    data: tag('Data'),
    totale: totaleDocumento,
    imponibile, iva,
    sdi_id: tag('ProgressivoInvio'),
    tipo_documento: mapFatturaPaDocumentType(rawTipoDocumento),
    tipo_esteso: rawTipoDocumento,
    fornitore_piva: fornitorePiva,
    fornitore_paese: fornitorePaese,
    fornitore_codice_fiscale: sanitizeFiscalCode(tag('CodiceFiscale', supplierBlock)),
    fornitore_nome: supplierName,
    righe,
    riepilogo_iva,
    documento_meta: {
      progressivo_invio: tag('ProgressivoInvio'),
      formato_trasmissione: tag('FormatoTrasmissione'),
      pec_destinatario: tag('PECDestinatario'),
      codice_destinatario: tag('CodiceDestinatario')
    }
  };
}

function buildDocumentHash({ numero, data, partita_iva, totale }) {
  const raw = [numero || '', data || '', partita_iva || '', Number(totale || 0).toFixed(2)].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function fileHash(filePath) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

function saveVatSummary(fatturaId, rows) {
  if (!fatturaId || !Array.isArray(rows) || !rows.length) return;
  const ins = db.prepare(`
    INSERT INTO fatture_iva_riepilogo (fattura_id, aliquota_iva, natura_iva, imponibile, imposta, riferimento_normativo)
    VALUES (?,?,?,?,?,?)
  `);
  rows.forEach(row => ins.run(
    fatturaId,
    row.aliquota_iva ?? null,
    row.natura_iva || null,
    row.imponibile ?? null,
    row.imposta ?? row.importo_iva ?? null,
    row.riferimento_normativo || null
  ));
}

function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const dmy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const dt = new Date(str);
  if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return null;
}

function inferInvoiceType(row) {
  const label = String(getRowValue(row, ['tipo_documento', 'Tipo documento', 'tipo', 'Tipo', 'TD']) || '').toLowerCase();
  if (label.includes('td04') || label.includes('credito')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'nota_credito' };
  if (label.includes('td05') || label.includes('debito')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'nota_debito' };
  if (label.includes('td16') || label.includes('auto')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'autofattura' };
  if (label.includes('td17') || label.includes('td18') || label.includes('td19') || label.includes('integraz')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'integrazione_estero' };
  if (label.includes('credito')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'nota_credito' };
  if (label.includes('debito')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'nota_debito' };
  if (label.includes('auto')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'autofattura' };
  if (label.includes('integraz')) return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'integrazione_estero' };
  const direction = String(getRowValue(row, ['direzione', 'Attiva/Passiva', 'attiva_passiva']) || '').toLowerCase();
  if (direction.includes('att')) return { tipo: 'emessa', direzione: 'attiva', tipo_documento: 'fattura' };
  return { tipo: 'ricevuta', direzione: 'passiva', tipo_documento: 'fattura' };
}

function getRowValue(row, keys = []) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') return row[key];
  }
  return null;
}

function parseDecimal(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let str = String(value).trim();
  if (!str) return null;
  str = str.replace(/[€\s]/g, '');
  if (str.includes(',') && str.includes('.')) {
    str = str.replace(/\./g, '').replace(',', '.');
  } else if (str.includes(',')) {
    str = str.replace(',', '.');
  }
  const parsed = Number(str);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeVatNumber(value) {
  if (!value) return null;
  return String(value).trim().replace(/\s+/g, '').toUpperCase() || null;
}

function sanitizeFiscalCode(value) {
  if (!value) return null;
  return String(value).trim().replace(/\s+/g, '').toUpperCase() || null;
}

function stripXmlNamespaces(xml) {
  return String(xml || '').replace(/<(\/?)(?:\w+:)/g, '<$1');
}

function firstBlock(source, tagName) {
  if (!source) return '';
  const match = source.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? match[1] : '';
}

function firstNonEmpty(values = []) {
  return values.find(value => value && String(value).trim()) || null;
}

function joinVatNumber(country, code) {
  const cleanCountry = sanitizeVatNumber(country);
  const cleanCode = sanitizeVatNumber(code);
  if (!cleanCode) return null;
  return cleanCountry ? `${cleanCountry}${cleanCode}` : cleanCode;
}

function mapFatturaPaDocumentType(value) {
  const code = String(value || '').trim().toUpperCase();
  if (code === 'TD04') return 'nota_credito';
  if (code === 'TD05') return 'nota_debito';
  if (code === 'TD16') return 'autofattura';
  if (['TD17', 'TD18', 'TD19'].includes(code)) return 'integrazione_estero';
  return 'fattura';
}

function stripVatCountryPrefix(value) {
  const normalized = sanitizeVatNumber(value);
  if (!normalized) return null;
  return /^[A-Z]{2}\d+$/.test(normalized) ? normalized.slice(2) : normalized;
}

module.exports = router;
