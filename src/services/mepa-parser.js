const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const db = require('../db/database');

// ═══════════════════════════════════════════════
// CPV HORYGON — mappa completa con target
// ═══════════════════════════════════════════════
const CPV_HORYGON = {
  // MONOUSO
  '18410000': { desc: 'Abbigliamento monouso per mensa', categoria: 'Monouso', priorita: 'media' },
  '18424300': { desc: 'Guanti monouso', categoria: 'Monouso', priorita: 'alta' },
  '39220000': { desc: 'Avvolgenti e accessori per alimenti', categoria: 'Monouso', priorita: 'alta' },
  '39222110': { desc: 'Stoviglie e contenitori monouso', categoria: 'Monouso', priorita: 'alta' },
  '33772000': { desc: 'Tovaglie, tovaglioli e articoli igienici monouso', categoria: 'Monouso', priorita: 'alta' },

  // PULIZIE E ATTREZZATURE
  '31124000': { desc: 'Generatori di vapore per pulizia', categoria: 'Pulizie', priorita: 'media' },
  '34144431': { desc: 'Spazzatrici esterno/interno non stradale', categoria: 'Pulizie', priorita: 'media' },
  '42995000': { desc: 'Monospazzole e macchine lavasuperfici', categoria: 'Pulizie', priorita: 'media' },
  '42999100': { desc: 'Apparecchiature per aspirazione', categoria: 'Pulizie', priorita: 'media' },
  '39300000': { desc: 'Attrezzature per pulizia e lavaggio', categoria: 'Pulizie', priorita: 'alta' },
  '39224350': { desc: 'Palette alza immondizia', categoria: 'Pulizie', priorita: 'media' },
  '39224310': { desc: 'Ragnatori e scopini WC', categoria: 'Pulizie', priorita: 'media' },
  '42996300': { desc: 'Raschietti e attrezzi specifici', categoria: 'Pulizie', priorita: 'media' },
  '39224100': { desc: 'Scope', categoria: 'Pulizie', priorita: 'alta' },
  '39224330': { desc: 'Secchi', categoria: 'Pulizie', priorita: 'media' },
  '34911100': { desc: 'Carrelli per pulizia e raccolta', categoria: 'Pulizie', priorita: 'alta' },
  '33711900': { desc: 'Saponi e detergenti mani', categoria: 'Pulizie', priorita: 'media' },
  '33760000': { desc: 'Carta tissue, asciugamani e igienica', categoria: 'Pulizie', priorita: 'alta' },
  '33761000': { desc: 'Carta igienica', categoria: 'Pulizie', priorita: 'alta' },
  '33763000': { desc: 'Asciugamani di carta', categoria: 'Pulizie', priorita: 'alta' },
  '33770000': { desc: 'Prodotti tissue', categoria: 'Pulizie', priorita: 'media' },
  '39800000': { desc: 'Detergenti, protettori e prodotti chimici per pulizia', categoria: 'Pulizie', priorita: 'alta' },
  '39811000': { desc: 'Profumatori e deodoranti', categoria: 'Pulizie', priorita: 'bassa' },
  '39812500': { desc: 'Sigillanti e protettori', categoria: 'Pulizie', priorita: 'bassa' },
  '39830000': { desc: 'Prodotti per la pulizia', categoria: 'Pulizie', priorita: 'alta' },
  '39831000': { desc: 'Preparati per la pulizia', categoria: 'Pulizie', priorita: 'alta' },
  '39831200': { desc: 'Detergenti per pulizia giornaliera e di fondo', categoria: 'Pulizie', priorita: 'alta' },
  '39831300': { desc: 'Decalcificanti', categoria: 'Pulizie', priorita: 'media' },
  '39831700': { desc: 'Dispenser sapone', categoria: 'Pulizie', priorita: 'media' },
  '39832000': { desc: 'Prodotti lavastoviglie', categoria: 'Pulizie', priorita: 'media' },
  '24455000': { desc: 'Disinfettanti e sanificanti', categoria: 'Pulizie', priorita: 'alta' },
  '42933100': { desc: 'Dispenser carta e sacchetti', categoria: 'Pulizie', priorita: 'media' },
  '14810000': { desc: 'Abrasivi, panni e spugne', categoria: 'Pulizie', priorita: 'media' },
  '39514200': { desc: 'Panni per pulizia', categoria: 'Pulizie', priorita: 'media' },
  '44523300': { desc: 'Accessori e ricambi per pulizie', categoria: 'Pulizie', priorita: 'media' },
  '03142400': { desc: 'Cere protettive', categoria: 'Pulizie', priorita: 'bassa' },
  '39530000': { desc: 'Tappeti per interno ed esterno', categoria: 'Pulizie', priorita: 'media' },

  // RACCOLTA RIFIUTI
  '44613800': { desc: 'Contenitori e apparati per raccolta rifiuti', categoria: 'Rifiuti', priorita: 'alta' },
  '42968000': { desc: 'Cestini e dispenser sacchetti deiezioni canine', categoria: 'Rifiuti', priorita: 'media' },
  '22853000': { desc: 'Pinze per raccolta rifiuti', categoria: 'Rifiuti', priorita: 'bassa' },
  '19640000': { desc: 'Sacchi e attivatori per compostaggio', categoria: 'Rifiuti', priorita: 'media' },

  // FERRAMENTA / EDILIZIA / TERMOIDRAULICA
  '44510000': { desc: 'Utensili, trapani e accessori', categoria: 'Ferramenta', priorita: 'media' },
  '44423220': { desc: 'Scale', categoria: 'Ferramenta', priorita: 'media' },
  '38300000': { desc: 'Strumenti di misura', categoria: 'Ferramenta', priorita: 'media' },
  '44800000': { desc: 'Vernici, additivi e impermeabilizzanti', categoria: 'Ferramenta', priorita: 'media' },
  '44421721': { desc: 'Casseforti e cassette portavalori', categoria: 'Ferramenta', priorita: 'bassa' },
  '44520000': { desc: 'Maniglie e serramenti', categoria: 'Ferramenta', priorita: 'bassa' },
  '44100000': { desc: 'Materiali da costruzione', categoria: 'Edilizia', priorita: 'media' },
  '44111700': { desc: 'Pavimentazioni', categoria: 'Edilizia', priorita: 'media' },
  '42512100': { desc: 'Condizionatori e climatizzatori', categoria: 'Clima', priorita: 'media' },
  '44115200': { desc: 'Idraulica', categoria: 'Termoidraulica', priorita: 'media' },
  '39715300': { desc: 'Termoidraulica', categoria: 'Termoidraulica', priorita: 'media' },
  '44411000': { desc: 'Sanitari e accessori bagno', categoria: 'Termoidraulica', priorita: 'media' },

  // ELETTRICO
  '31200000': { desc: 'Apparecchi di efficienza energetica e misuratori', categoria: 'Elettrico', priorita: 'media' },
  '31214000': { desc: 'Interruttori differenziali magnetotermici', categoria: 'Elettrico', priorita: 'media' },
  '31224000': { desc: 'Adattatori e spine', categoria: 'Elettrico', priorita: 'bassa' },
  '31224100': { desc: 'Adattatori, prese e spine', categoria: 'Elettrico', priorita: 'media' },
  '31224800': { desc: 'Prolunghe e avvolgicavo', categoria: 'Elettrico', priorita: 'media' },
  '31410000': { desc: 'Pile elettriche', categoria: 'Elettrico', priorita: 'alta' },
  '31440000': { desc: 'Pile e batterie', categoria: 'Elettrico', priorita: 'alta' },
  '31500000': { desc: 'Apparecchi di illuminazione', categoria: 'Elettrico', priorita: 'media' },
  '31521300': { desc: 'Lampade', categoria: 'Elettrico', priorita: 'media' },
  '31531000': { desc: 'Lampadine', categoria: 'Elettrico', priorita: 'media' },
  '31532000': { desc: 'Lampade e corpi illuminanti', categoria: 'Elettrico', priorita: 'media' },
  '31532900': { desc: 'Componenti per lampade', categoria: 'Elettrico', priorita: 'bassa' },
  '31155000': { desc: 'Inverter', categoria: 'Elettrico', priorita: 'media' },
  '31170000': { desc: 'Trasformatori elettrici', categoria: 'Elettrico', priorita: 'media' },
  '31600000': { desc: 'Materiale elettrico', categoria: 'Elettrico', priorita: 'media' },
  '44530000': { desc: 'Basette, canaline e fascette', categoria: 'Elettrico', priorita: 'media' },
  '39540000': { desc: 'Catene, corde e accessori', categoria: 'Elettrico', priorita: 'bassa' },
  '42113161': { desc: 'Deumidificatori portatili', categoria: 'Elettrico', priorita: 'media' },

  // CANCELLERIA
  '30141000': { desc: 'Calcolatrici', categoria: 'Cancelleria', priorita: 'media' },
  '30192000': { desc: 'Marcatori, penne e materiale per ufficio', categoria: 'Cancelleria', priorita: 'alta' },
  '30192100': { desc: 'Gomme', categoria: 'Cancelleria', priorita: 'bassa' },
  '30192110': { desc: 'Penne, ricariche e tappetini sottotimbro', categoria: 'Cancelleria', priorita: 'media' },
  '30192111': { desc: 'Cuscinetti per timbri', categoria: 'Cancelleria', priorita: 'bassa' },
  '30192122': { desc: 'Penne e ricariche', categoria: 'Cancelleria', priorita: 'media' },
  '30192124': { desc: 'Pennarelli in fibra', categoria: 'Cancelleria', priorita: 'media' },
  '30192125': { desc: 'Evidenziatori', categoria: 'Cancelleria', priorita: 'media' },
  '30192130': { desc: 'Matite di grafite', categoria: 'Cancelleria', priorita: 'bassa' },
  '30192131': { desc: 'Matite portamine', categoria: 'Cancelleria', priorita: 'bassa' },
  '30192132': { desc: 'Mine di ricambio', categoria: 'Cancelleria', priorita: 'bassa' },
  '30192133': { desc: 'Temperamatite', categoria: 'Cancelleria', priorita: 'bassa' },
  '30192150': { desc: 'Datari e timbri', categoria: 'Cancelleria', priorita: 'bassa' },
  '30192152': { desc: 'Timbri', categoria: 'Cancelleria', priorita: 'bassa' },
  '30192153': { desc: 'Timbri', categoria: 'Cancelleria', priorita: 'bassa' },
  '30192160': { desc: 'Correttori', categoria: 'Cancelleria', priorita: 'media' },
  '30192300': { desc: 'Nastri per etichettatrici', categoria: 'Cancelleria', priorita: 'bassa' },
  '30192330': { desc: 'Nastri e rulli', categoria: 'Cancelleria', priorita: 'bassa' },
  '30192500': { desc: 'Lucidi per retroproiezione', categoria: 'Cancelleria', priorita: 'bassa' },
  '30192800': { desc: 'Etichette', categoria: 'Cancelleria', priorita: 'media' },
  '30195700': { desc: 'Pulizia per lavagne bianche', categoria: 'Cancelleria', priorita: 'bassa' },
  '30195920': { desc: 'Lavagne magnetiche e magneti', categoria: 'Cancelleria', priorita: 'media' },
  '30197000': { desc: 'Accessori e attrezzatura ufficio', categoria: 'Cancelleria', priorita: 'alta' },
  '30197321': { desc: 'Levapunti', categoria: 'Cancelleria', priorita: 'bassa' },
  '30197330': { desc: 'Perforatori e accessori', categoria: 'Cancelleria', priorita: 'bassa' },
  '30197500': { desc: 'Ceralacca', categoria: 'Cancelleria', priorita: 'bassa' },
  '30197600': { desc: 'Carta e cartoncino per stampa e disegno', categoria: 'Cancelleria', priorita: 'alta' },
  '30197621': { desc: 'Blocchi per lavagne a fogli mobili', categoria: 'Cancelleria', priorita: 'media' },
  '30197641': { desc: 'Carta termica e chimica', categoria: 'Carta', priorita: 'media' },
  '30197642': { desc: 'Carta bianca in risme 80gr', categoria: 'Carta', priorita: 'alta' },
  '30199000': { desc: 'Agende, calendari e articoli di cancelleria', categoria: 'Cancelleria', priorita: 'alta' },
  '30199110': { desc: 'Carta carbone', categoria: 'Carta', priorita: 'bassa' },
  '30199230': { desc: 'Buste in plastica', categoria: 'Cancelleria', priorita: 'media' },
  '30199340': { desc: 'Carta in modulo continuo', categoria: 'Carta', priorita: 'bassa' },
  '30199731': { desc: 'Portabiglietti da visita', categoria: 'Cancelleria', priorita: 'bassa' },
  '35121400': { desc: 'Buste di sicurezza', categoria: 'Cancelleria', priorita: 'media' },
  '35121500': { desc: 'Sigilli', categoria: 'Cancelleria', priorita: 'bassa' },
  '35123400': { desc: 'Badge, portanomi e accessori', categoria: 'Cancelleria', priorita: 'media' },
  '22461000': { desc: 'Portalistini', categoria: 'Cancelleria', priorita: 'bassa' },
  '22600000': { desc: 'Inchiostri per timbri', categoria: 'Cancelleria', priorita: 'bassa' },
  '22800000': { desc: 'Registri e raccoglitori', categoria: 'Cancelleria', priorita: 'media' },
  '22810000': { desc: 'Registri', categoria: 'Cancelleria', priorita: 'media' },
  '22816100': { desc: 'Blocchi', categoria: 'Cancelleria', priorita: 'media' },
  '22816300': { desc: 'Foglietti riposizionabili', categoria: 'Cancelleria', priorita: 'media' },
  '22817000': { desc: 'Scadenzari', categoria: 'Cancelleria', priorita: 'bassa' },
  '22819000': { desc: 'Rubriche telefoniche', categoria: 'Cancelleria', priorita: 'bassa' },
  '22830000': { desc: 'Quaderni e ricambi', categoria: 'Cancelleria', priorita: 'media' },
  '22832000': { desc: 'Carta protocollo', categoria: 'Carta', priorita: 'media' },
  '22852000': { desc: 'Cartelle, cartelline e supporti archivio', categoria: 'Cancelleria', priorita: 'alta' },
  '22852100': { desc: 'Copertine e accessori per rilegatura', categoria: 'Cancelleria', priorita: 'media' },
  '24910000': { desc: 'Colla', categoria: 'Cancelleria', priorita: 'media' },
  '30237220': { desc: 'Tappetini per mouse', categoria: 'Cancelleria', priorita: 'bassa' },
  '30237250': { desc: 'Pulizia per computer', categoria: 'Cancelleria', priorita: 'bassa' },
  '30237251': { desc: 'Pulizia per computer', categoria: 'Cancelleria', priorita: 'bassa' },
  '30237252': { desc: 'Pulizia per computer', categoria: 'Cancelleria', priorita: 'bassa' },
  '37820000': { desc: 'Calchi, colori a dita e materiali tecnici', categoria: 'Cancelleria', priorita: 'bassa' },
  '37822100': { desc: 'Matite colorate in legno', categoria: 'Cancelleria', priorita: 'bassa' },
  '37822300': { desc: 'Gessi per lavagne', categoria: 'Cancelleria', priorita: 'bassa' },
  '37822400': { desc: 'Paste modellabili e pastelli a cera', categoria: 'Cancelleria', priorita: 'bassa' },
  '37823200': { desc: 'Carta lucida acetata', categoria: 'Carta', priorita: 'bassa' },
  '37823600': { desc: 'Cartoncini, album e carta millimetrata', categoria: 'Cancelleria', priorita: 'media' },
  '39130000': { desc: 'Cassettiere in plastica', categoria: 'Cancelleria', priorita: 'bassa' },
  '39132200': { desc: 'Schedari e schede', categoria: 'Cancelleria', priorita: 'bassa' },
  '39224210': { desc: 'Pennelli', categoria: 'Cancelleria', priorita: 'bassa' },
  '39263000': { desc: 'Cucitrici, punti e tappetini taglio', categoria: 'Cancelleria', priorita: 'media' },
  '39263100': { desc: 'Set da scrivania', categoria: 'Cancelleria', priorita: 'bassa' },
  '39264000': { desc: 'Dorsetti, pettini e spirali', categoria: 'Cancelleria', priorita: 'bassa' },
  '39292000': { desc: 'Lavagne a fogli mobili', categoria: 'Cancelleria', priorita: 'media' },
  '44424000': { desc: 'Dispenser per nastri adesivi', categoria: 'Cancelleria', priorita: 'bassa' },
  '44424200': { desc: 'Nastri adesivi', categoria: 'Cancelleria', priorita: 'media' },
  '44425100': { desc: 'Elastici', categoria: 'Cancelleria', priorita: 'bassa' },

  // CONSUMABILI STAMPA
  '30124000': { desc: 'Accessori per stampa', categoria: 'Consumabili stampa', priorita: 'media' },
  '30124110': { desc: 'Accessori per stampa', categoria: 'Consumabili stampa', priorita: 'media' },
  '30124120': { desc: 'Accessori per stampa', categoria: 'Consumabili stampa', priorita: 'media' },
  '30124130': { desc: 'Accessori per stampa', categoria: 'Consumabili stampa', priorita: 'media' },
  '30124300': { desc: 'Accessori per stampa', categoria: 'Consumabili stampa', priorita: 'media' },
  '30124400': { desc: 'Accessori per stampa', categoria: 'Consumabili stampa', priorita: 'media' },
  '30125000': { desc: 'Componenti consumabili stampa', categoria: 'Consumabili stampa', priorita: 'media' },
  '30125100': { desc: 'Cartucce e toner', categoria: 'Consumabili stampa', priorita: 'alta' },

  // RESTAURO
  '37800000': { desc: 'Materiali e accessori per restauro', categoria: 'Restauro', priorita: 'bassa' },
  '37810000': { desc: 'Prodotti di legatoria per restauro', categoria: 'Restauro', priorita: 'bassa' },
  '30194000': { desc: 'Tele per restauro', categoria: 'Restauro', priorita: 'bassa' },
  '44812000': { desc: 'Tempere, colori e pigmenti', categoria: 'Restauro', priorita: 'bassa' },
};

function normalizeCpvCode(value = '', { keepCheckDigit = true } = {}) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (keepCheckDigit && digits.length >= 9) return digits.substring(0, 9);
  return digits.substring(0, 8);
}

function formatCpvCode(value = '') {
  const digits = normalizeCpvCode(value, { keepCheckDigit: true });
  if (digits.length === 9) return `${digits.substring(0, 8)}-${digits.substring(8)}`;
  return digits;
}

function getCpvMatchKey(value = '') {
  const digits = normalizeCpvCode(value, { keepCheckDigit: true });
  if (digits.length >= 8) return digits.substring(0, 8);
  return digits.substring(0, 6);
}

function getCpvCatalogEntries({ activeOnly = false, categoryId = null } = {}) {
  try {
    const where = [];
    const params = [];
    if (activeOnly) where.push('attivo = 1 AND categoria_id IS NOT NULL');
    if (categoryId) {
      where.push('categoria_id = ?');
      params.push(Number(categoryId));
    }
    return db.prepare(`
      SELECT codice_cpv, descrizione as desc, categoria, priorita, attivo, note, categoria_id
      FROM mepa_cpv_catalog
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY categoria, descrizione
    `).all(...params);
  } catch {
    return [];
  }
}

function getActiveCpvPrefixes(categoryId = null) {
  const entries = getCpvCatalogEntries({ activeOnly: true, categoryId });
  return [...new Set(entries.map(entry => getCpvMatchKey(entry.codice_cpv)).filter(Boolean))];
}

function hasActiveGovernance(categoryId = null) {
  try {
    return listEnabledCategories({ activeOnly: true, categoryId }).length > 0
      && getCpvCatalogEntries({ activeOnly: true, categoryId }).length > 0;
  } catch {
    return false;
  }
}

function getCpvMeta(cpv = '') {
  const clean = normalizeCpvCode(cpv, { keepCheckDigit: true });
  if (!clean) return {};
  const matchKey = getCpvMatchKey(clean);
  const catalogMatch = getCpvCatalogEntries()
    .find(entry => getCpvMatchKey(entry.codice_cpv) === matchKey);
  if (catalogMatch) return {
    desc: catalogMatch.desc,
    target_desc: catalogMatch.desc,
    categoria: catalogMatch.categoria,
    priorita: catalogMatch.priorita,
    attivo: catalogMatch.attivo,
    codice_cpv_display: formatCpvCode(catalogMatch.codice_cpv),
  };
  return {};
}

function getActiveCpvFilter(alias = '', categoryId = null) {
  const column = alias ? `${alias}.codice_cpv` : 'codice_cpv';
  const activePrefixes = getActiveCpvPrefixes(categoryId);
  if (!activePrefixes.length) return { where: '1=0', params: [] };
  const placeholders = activePrefixes.map(() => '?').join(', ');
  return {
    where: `substr(${column}, 1, 8) IN (${placeholders})`,
    params: activePrefixes.map(prefix => prefix.substring(0, 8)),
  };
}

function saveCpvCatalogEntry(input = {}) {
  const codice = normalizeCpvCode(input.codice_cpv, { keepCheckDigit: true });
  if (codice.length < 6) throw new Error('Codice CPV non valido');
  const descrizione = String(input.descrizione || input.desc || '').trim();
  if (!descrizione) throw new Error('Descrizione CPV obbligatoria');
  const categoria = String(input.categoria || 'Da classificare').trim();
  const priorita = String(input.priorita || 'media').trim();
  const attivo = input.attivo === false || input.attivo === 0 ? 0 : 1;
  const note = String(input.note || '').trim();

  db.prepare(`
    INSERT INTO mepa_cpv_catalog (codice_cpv, descrizione, categoria, priorita, attivo, note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(codice_cpv) DO UPDATE SET
      descrizione = excluded.descrizione,
      categoria = excluded.categoria,
      priorita = excluded.priorita,
      attivo = excluded.attivo,
      note = excluded.note,
      updated_at = datetime('now')
  `).run(codice, descrizione, categoria, priorita, attivo, note);

  return db.prepare('SELECT * FROM mepa_cpv_catalog WHERE codice_cpv = ?').get(codice);
}

function listEnabledCategories({ activeOnly = false, categoryId = null } = {}) {
  const where = [];
  const params = [];
  if (activeOnly) where.push('c.attiva = 1');
  if (categoryId) {
    where.push('c.id = ?');
    params.push(Number(categoryId));
  }
  return db.prepare(`
    SELECT c.*,
      COUNT(cat.codice_cpv) as cpv_count,
      SUM(CASE WHEN cat.attivo = 1 THEN 1 ELSE 0 END) as cpv_attivi
    FROM mepa_categorie_abilitate c
    LEFT JOIN mepa_cpv_catalog cat ON cat.categoria_id = c.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY c.id
    ORDER BY c.attiva DESC, c.nome ASC
  `).all(...params);
}

function saveEnabledCategory(input = {}) {
  const nome = String(input.nome || input.categoria || '').trim();
  if (!nome) throw new Error('Nome categoria obbligatorio');
  const descrizione = String(input.descrizione || '').trim();
  const fonte = String(input.fonte || '').trim();
  const attiva = input.attiva === false || input.attiva === 0 ? 0 : 1;
  const existingId = input.id ? Number(input.id) : null;

  if (existingId) {
    db.prepare(`
      UPDATE mepa_categorie_abilitate
      SET nome = ?, descrizione = ?, fonte = ?, attiva = ?, aggiornato_il = datetime('now')
      WHERE id = ?
    `).run(nome, descrizione, fonte, attiva, existingId);
    return db.prepare('SELECT * FROM mepa_categorie_abilitate WHERE id = ?').get(existingId);
  }

  db.prepare(`
    INSERT INTO mepa_categorie_abilitate (nome, descrizione, fonte, attiva, aggiornato_il)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(nome) DO UPDATE SET
      descrizione = excluded.descrizione,
      fonte = excluded.fonte,
      attiva = excluded.attiva,
      aggiornato_il = datetime('now')
  `).run(nome, descrizione, fonte, attiva);

  return db.prepare('SELECT * FROM mepa_categorie_abilitate WHERE nome = ?').get(nome);
}

function setEnabledCategoryState(id, attiva) {
  const categoryId = Number(id);
  if (!categoryId) throw new Error('Categoria non valida');
  db.prepare(`
    UPDATE mepa_categorie_abilitate
    SET attiva = ?, aggiornato_il = datetime('now')
    WHERE id = ?
  `).run(attiva ? 1 : 0, categoryId);
  return db.prepare('SELECT * FROM mepa_categorie_abilitate WHERE id = ?').get(categoryId);
}

function deleteEnabledCategory(id) {
  const categoryId = Number(id);
  if (!categoryId) throw new Error('Categoria non valida');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM mepa_cpv_catalog WHERE categoria_id = ?').run(categoryId);
    db.prepare('DELETE FROM mepa_categorie_abilitate WHERE id = ?').run(categoryId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, id: categoryId };
}

function parseImportedCpvLines(rawText = '') {
  const text = String(rawText || '').replace(/\r/g, '\n');
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const rows = [];
  const seen = new Set();

  for (const line of lines) {
    const match = line.match(/(\d{8}\s*-\s*\d|\d{8})/);
    if (!match) continue;
    const codice = normalizeCpvCode(match[1], { keepCheckDigit: true });
    if (codice.length < 6 || seen.has(codice)) continue;

    let descrizione = line
      .replace(/^.*?CPV\s*/i, '')
      .replace(/^\d{8}-\d\s*[–-]?\s*/u, '')
      .replace(/^\d{8}\s*[–-]?\s*/u, '')
      .replace(/\s+\d+\s*$/u, '')
      .replace(/^Prodotto:\s*/i, '')
      .trim();

    descrizione = descrizione.replace(/^\d{8}\s*-\s*\d\s*[-–]?\s*/u, '');
    descrizione = descrizione.replace(/^\d{8}\s*[-–]?\s*/u, '').trim();

    if (!descrizione) {
      const fallback = CPV_HORYGON[codice];
      descrizione = fallback?.desc || `CPV ${codice}`;
    }

    rows.push({ codice_cpv: codice, codice_cpv_display: formatCpvCode(codice), descrizione });
    seen.add(codice);
  }

  return rows;
}

function previewCpvCatalogText(rawText = '', options = {}) {
  const categoria = String(options.categoria || 'Da classificare').trim() || 'Da classificare';
  const rows = parseImportedCpvLines(rawText).map(row => {
    const existing = db.prepare(`
      SELECT codice_cpv, descrizione, categoria, categoria_id, attivo
      FROM mepa_cpv_catalog
      WHERE codice_cpv = ?
    `).get(row.codice_cpv);
    return {
      ...row,
      categoria,
      esistente: !!existing,
      codice_cpv_display: formatCpvCode(row.codice_cpv),
      categoria_esistente: existing?.categoria || '',
      descrizione_esistente: existing?.descrizione || '',
      attivo_esistente: existing?.attivo ?? null,
    };
  });

  return {
    categoria,
    totaleLetti: rows.length,
    nuovi: rows.filter(row => !row.esistente).length,
    esistenti: rows.filter(row => row.esistente).length,
    rows,
  };
}

function importCpvCatalogText(rawText = '', options = {}) {
  const categoria = String(options.categoria || 'Da classificare').trim() || 'Da classificare';
  const fonte = String(options.fonte || '').trim();
  const priorita = String(options.priorita || 'media').trim() || 'media';
  const attivo = options.attivo === false || options.attivo === 0 ? 0 : 1;
  const categoriaRow = saveEnabledCategory({
    id: options.categoria_id,
    nome: categoria,
    descrizione: options.descrizione_categoria || '',
    fonte,
    attiva: 1,
  });

  const rows = parseImportedCpvLines(rawText);
  if (!rows.length) throw new Error('Nessun codice CPV valido trovato nel file');

  let inseriti = 0;
  let aggiornati = 0;
  const codici = [];

  for (const row of rows) {
    const existing = db.prepare('SELECT codice_cpv FROM mepa_cpv_catalog WHERE codice_cpv = ?').get(row.codice_cpv);
    db.prepare(`
      INSERT INTO mepa_cpv_catalog (codice_cpv, descrizione, categoria, categoria_id, priorita, attivo, note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(codice_cpv) DO UPDATE SET
        descrizione = excluded.descrizione,
        categoria = excluded.categoria,
        categoria_id = excluded.categoria_id,
        priorita = excluded.priorita,
        attivo = excluded.attivo,
        note = CASE
          WHEN mepa_cpv_catalog.note IS NULL OR mepa_cpv_catalog.note = '' THEN excluded.note
          ELSE mepa_cpv_catalog.note
        END,
        updated_at = datetime('now')
    `).run(
      row.codice_cpv,
      row.descrizione,
      categoria,
      categoriaRow.id,
      priorita,
      attivo,
      fonte ? `Fonte: ${fonte}` : ''
    );
    if (existing) aggiornati += 1;
    else inseriti += 1;
    codici.push(row.codice_cpv);
  }

  inactiveOppCache = null;
  return {
    categoria: categoriaRow,
    totaleLetti: rows.length,
    inseriti,
    aggiornati,
    codici,
  };
}

let inactiveOppCache = null;

function parseMepaRows(csvData) {
  const rawHeader = csvData.split('\n')[0].replace(/^#/, '').trim();
  const dataWithoutHeader = csvData.split('\n').slice(1).join('\n');
  return parse(dataWithoutHeader, {
    columns: rawHeader.split(','),
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true,
    encoding: 'latin1',
  });
}

function computeContentHash(content) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'latin1')).digest('hex');
}

function getImportedHashRow(contentHash) {
  if (!contentHash) return null;
  try {
    return db.prepare('SELECT * FROM mepa_import_log WHERE content_hash = ? LIMIT 1').get(contentHash);
  } catch {
    return null;
  }
}

function listUniqueMepaFiles() {
  const dataDir = path.join(process.cwd(), 'data', 'mepa');
  if (!fs.existsSync(dataDir)) return [];
  const unique = [];
  const seenHashes = new Set();
  for (const name of fs.readdirSync(dataDir).filter(file => file.endsWith('.csv'))) {
    const fullPath = path.join(dataDir, name);
    const content = fs.readFileSync(fullPath);
    const contentHash = computeContentHash(content);
    const duplicateOf = getImportedHashRow(contentHash);
    const duplicateInFolder = seenHashes.has(contentHash);
    unique.push({
      name,
      fullPath,
      content,
      contentHash,
      duplicateInFolder,
      alreadyImported: !!duplicateOf,
      importedAs: duplicateOf?.file_nome || null,
    });
    if (!duplicateInFolder) seenHashes.add(contentHash);
  }
  return unique;
}

function getInactiveOpportunityCacheKey(files) {
  return files
    .map(file => {
      const stat = fs.statSync(file.fullPath);
      return `${file.name}:${file.contentHash || ''}:${stat.size}:${stat.mtimeMs}`;
    })
    .join('|');
}

function getMepaInactiveOpportunities(limit = 50) {
  const dataDir = path.join(process.cwd(), 'data', 'mepa');
  if (!fs.existsSync(dataDir)) return { anni: [], items: [], summary: { totalItems: 0, totalValue: 0 } };
  if (!hasActiveGovernance()) return { anni: [], items: [], summary: { totalItems: 0, totalValue: 0 }, scannedRows: 0, duplicateFiles: 0 };

  const files = listUniqueMepaFiles().filter(file => !file.duplicateInFolder);

  const cacheKey = getInactiveOpportunityCacheKey(files);
  if (inactiveOppCache && inactiveOppCache.key === cacheKey) {
    return {
      ...inactiveOppCache.data,
      items: inactiveOppCache.data.items.slice(0, limit),
    };
  }

  const byCpv = new Map();
  const years = new Set();
  let scannedRows = 0;
  let duplicateFiles = 0;
  const activePrefixes = getActiveCpvPrefixes();

  for (const file of files) {
    if (file.alreadyImported && file.importedAs && file.importedAs !== file.name) duplicateFiles += 1;
    const records = parseMepaRows(file.content.toString('latin1'));

    for (const r of records) {
      scannedRows++;
      const anno = parseInt(r['Anno_Riferimento'] || r['anno_riferimento'] || '0', 10);
      const cpv = normalizeCpvCode(r['codice_CPV'] || r['codice_cpv'] || '', { keepCheckDigit: true });
      if (!anno || !cpv || cpv.length < 6) continue;

      const alreadyActive = activePrefixes.some(prefix => cpv.startsWith(prefix));
      if (alreadyActive) continue;

      years.add(anno);
      const descrizione = (r['descrizione_CPV'] || r['descrizione_cpv'] || '').toUpperCase().trim();
      const valore = parseFloat((r['Valore_economico_Ordini'] || '0').replace(',', '.')) || 0;
      const ordini = parseInt((r['N_Ordini'] || '0').replace(',', '.'), 10) || 1;
      const pa = parseInt((r['N_PA'] || '0').replace(',', '.'), 10) || 0;
      const fornitori = parseInt((r['N_fornitori'] || '0').replace(',', '.'), 10) || 0;

      if (!byCpv.has(cpv)) {
        byCpv.set(cpv, {
          codice_cpv: cpv,
          descrizione_cpv: descrizione,
          valore_totale: 0,
          ordini_totali: 0,
          pa_totali: 0,
          fornitori_totali: 0,
          anni: {},
        });
      }

      const item = byCpv.get(cpv);
      item.valore_totale += valore;
      item.ordini_totali += ordini;
      item.pa_totali += pa;
      item.fornitori_totali += fornitori;
      item.anni[anno] = item.anni[anno] || { valore: 0, ordini: 0 };
      item.anni[anno].valore += valore;
      item.anni[anno].ordini += ordini;
    }
  }

  const sortedYears = [...years].sort((a, b) => a - b);
  const firstYear = sortedYears[0] || new Date().getFullYear() - 2;
  const middleYear = sortedYears[1] || firstYear + 1;
  const lastYear = sortedYears[sortedYears.length - 1] || middleYear + 1;

  const items = [...byCpv.values()]
    .map(item => {
      const vPrimo = item.anni[firstYear]?.valore || 0;
      const vMedio = item.anni[middleYear]?.valore || 0;
      const vUltimo = item.anni[lastYear]?.valore || 0;
      const crescita = vPrimo > 0 ? ((vUltimo - vPrimo) / vPrimo * 100) : null;
      const crescitaScore = Math.max(-60, Math.min(crescita || 0, 120));
      const score = (vUltimo * 0.6) + (item.valore_totale * 0.25) + (item.ordini_totali * 160) + (crescitaScore * 6000);
      return {
        ...item,
        v_primo: vPrimo,
        v_medio: vMedio,
        v_ultimo: vUltimo,
        crescita_pct: crescita === null ? null : parseFloat(crescita.toFixed(1)),
        score: parseFloat(score.toFixed(2)),
        suggerimento: crescita !== null && crescita > 25 ? 'Da valutare subito' : vUltimo > 500000 ? 'Mercato rilevante' : 'Monitorare',
      };
    })
    .filter(item => item.valore_totale > 0 && item.v_ultimo >= 10000)
    .sort((a, b) => b.score - a.score);

  const data = {
    anni: sortedYears,
    scannedRows,
    duplicateFiles,
    items,
    summary: {
      totalItems: items.length,
      totalValue: items.reduce((sum, item) => sum + item.valore_totale, 0),
      firstYear,
      middleYear,
      lastYear,
    },
  };

  inactiveOppCache = { key: cacheKey, data };
  return { ...data, items: items.slice(0, limit) };
}

// ═══════════════════════════════════════════════
// INIT DB
// ═══════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS mepa_ordini (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anno INTEGER NOT NULL,
    tipologia_pa TEXT,
    regione_pa TEXT,
    provincia_pa TEXT,
    regione_fornitore TEXT,
    bando_mepa TEXT,
    categoria_mepa TEXT,
    codice_cpv TEXT,
    descrizione_cpv TEXT,
    n_ordini INTEGER DEFAULT 0,
    valore_economico REAL DEFAULT 0,
    n_pa INTEGER DEFAULT 0,
    n_fornitori INTEGER DEFAULT 0,
    file_fonte TEXT,
    UNIQUE(anno, codice_cpv, tipologia_pa, regione_pa, provincia_pa, categoria_mepa)
  );

  CREATE TABLE IF NOT EXISTS mepa_import_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_nome TEXT,
    anno INTEGER,
    righe_totali INTEGER,
    righe_horygon INTEGER,
    valore_horygon REAL,
    content_hash TEXT,
    data_import TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mepa_categorie_abilitate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    descrizione TEXT,
    fonte TEXT,
    attiva INTEGER DEFAULT 1,
    creato_il TEXT DEFAULT (datetime('now')),
    aggiornato_il TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mepa_cpv_catalog (
    codice_cpv TEXT PRIMARY KEY,
    descrizione TEXT NOT NULL,
    categoria TEXT,
    priorita TEXT DEFAULT 'media',
    attivo INTEGER DEFAULT 1,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_mepa_anno ON mepa_ordini(anno);
  CREATE INDEX IF NOT EXISTS idx_mepa_cpv ON mepa_ordini(codice_cpv);
  CREATE INDEX IF NOT EXISTS idx_mepa_regione ON mepa_ordini(regione_pa);
`);

try { db.exec(`ALTER TABLE mepa_import_log ADD COLUMN content_hash TEXT`); } catch {}
try { db.exec(`ALTER TABLE mepa_cpv_catalog ADD COLUMN categoria_id INTEGER`); } catch {}


// ═══════════════════════════════════════════════
// PARSER CSV MEPA
// ═══════════════════════════════════════════════
function parseMepaCSV(csvData, nomeFile, options = {}) {
  const { force = false } = options;
  const contentHash = computeContentHash(csvData);
  const existingHash = getImportedHashRow(contentHash);
  if (existingHash && !force) {
    return {
      totale: existingHash.righe_totali || 0,
      horygon: existingHash.righe_horygon || 0,
      valoreHorygon: existingHash.valore_horygon || 0,
      skipped: true,
      duplicateOf: existingHash.file_nome || null,
      contentHash
    };
  }
  let records;
  try {
    records = parseMepaRows(csvData);
  } catch (e) {
    throw new Error(`Parse error: ${e.message}`);
  }

  const upsert = db.prepare(`
    INSERT INTO mepa_ordini
    (anno,tipologia_pa,regione_pa,provincia_pa,regione_fornitore,bando_mepa,
     categoria_mepa,codice_cpv,descrizione_cpv,n_ordini,valore_economico,n_pa,n_fornitori,file_fonte)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(anno, codice_cpv, tipologia_pa, regione_pa, provincia_pa, categoria_mepa)
    DO UPDATE SET
      n_ordini = n_ordini + excluded.n_ordini,
      valore_economico = valore_economico + excluded.valore_economico,
      n_pa = n_pa + excluded.n_pa,
      n_fornitori = n_fornitori + excluded.n_fornitori,
      descrizione_cpv = COALESCE(NULLIF(excluded.descrizione_cpv, ''), descrizione_cpv),
      regione_fornitore = COALESCE(NULLIF(excluded.regione_fornitore, ''), regione_fornitore),
      bando_mepa = COALESCE(NULLIF(excluded.bando_mepa, ''), bando_mepa),
      file_fonte = excluded.file_fonte
  `);

  let totale = 0;
  let horygon = 0;
  let valoreHorygon = 0;
  const activePrefixes = getActiveCpvPrefixes();
  db.exec('BEGIN');
  try {
    for (const r of records) {
      totale++;
      const anno = parseInt(r['Anno_Riferimento'] || r['anno_riferimento'] || '0');
      const cpv = normalizeCpvCode(r['codice_CPV'] || r['codice_cpv'] || '', { keepCheckDigit: true });
      const descCpv = (r['descrizione_CPV'] || r['descrizione_cpv'] || '').toUpperCase().trim();
      const tipPa = (r['Tipologia_Amministrazione'] || '').trim();
      const regPa = (r['Regione_PA'] || '').trim();
      const provPa = (r['Provincia_PA'] || '').trim();
      const regFor = (r['Regione_Fornitore'] || '').trim();
      const bando = (r['Bando_Mepa'] || '').trim();
      const cat = (r['Categoria_Abilitazione'] || '').trim();
      const nOrd = parseInt((r['N_Ordini'] || '0').replace(',', '.')) || 1;
      const nPa = parseInt((r['N_PA'] || '0').replace(',', '.')) || 0;
      const nFor = parseInt((r['N_fornitori'] || '0').replace(',', '.')) || 0;
      const valore = parseFloat((r['Valore_economico_Ordini'] || '0').replace(',', '.')) || 0;

      if (!cpv || cpv.length < 6) continue;

      const isHorygon = activePrefixes.some(p => cpv.startsWith(p));
      if (isHorygon) {
        horygon++;
        valoreHorygon += valore;
      }

      upsert.run(anno, tipPa, regPa, provPa, regFor, bando, cat, cpv, descCpv, nOrd, valore, nPa, nFor, nomeFile);
    }

    db.prepare(`INSERT OR REPLACE INTO mepa_import_log (file_nome,anno,righe_totali,righe_horygon,valore_horygon,content_hash)
      VALUES (?,?,?,?,?,?)`).run(nomeFile, records[0]?.Anno_Riferimento || 0, totale, horygon, valoreHorygon, contentHash);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { totale, horygon, valoreHorygon, contentHash };
}

// ═══════════════════════════════════════════════
// AUTO-SCAN CARTELLA data/mepa/
// ═══════════════════════════════════════════════
function scanAndImportAll() {
  const dataDir = path.join(process.cwd(), 'data', 'mepa');
  if (!fs.existsSync(dataDir)) { fs.mkdirSync(dataDir, { recursive: true }); return []; }

  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv'));
  const results = [];

  for (const file of files) {
    const already = db.prepare('SELECT id FROM mepa_import_log WHERE file_nome = ?').get(file);
    if (already) { results.push({ file, status: 'già importato' }); continue; }

    try {
      const content = fs.readFileSync(path.join(dataDir, file), 'latin1');
      const result = parseMepaCSV(content, file);
      results.push({ file, status: 'importato', ...result });
      console.log(`[MEPA] Importato ${file}: ${result.horygon} righe Horygon, €${result.valoreHorygon.toLocaleString('it')}`);
    } catch (e) {
      results.push({ file, status: 'errore', errore: e.message });
      console.error(`[MEPA] Errore ${file}: ${e.message}`);
    }
  }

  return results;
}

// ═══════════════════════════════════════════════
// ANALYTICS MEPA
// ═══════════════════════════════════════════════
function getMepaAnalytics(categoryId = null) {
  if (!hasActiveGovernance(categoryId)) {
    return {
      anni: [],
      kpiAnni: [],
      topCpv: [],
      topRegioni: [],
      topTipologie: [],
      topCategorie: [],
      serieAnni: [],
      opportunita: [],
      declino: [],
      regioniTarget: [],
      predizioni: [],
      cpvHorygon: {},
    };
  }
  const activeFilter = getActiveCpvFilter('', categoryId);
  // Anni disponibili
  const anni = db.prepare(`SELECT DISTINCT anno FROM mepa_ordini WHERE ${activeFilter.where} ORDER BY anno ASC`).all(...activeFilter.params).map(r => r.anno);

  // KPI per anno
  const kpiAnni = anni.map(anno => {
    const row = db.prepare(`
      SELECT anno, COUNT(DISTINCT codice_cpv) as num_cpv,
        SUM(n_ordini) as tot_ordini, SUM(valore_economico) as tot_valore
      FROM mepa_ordini WHERE anno = ? AND ${activeFilter.where}
    `).get(anno, ...activeFilter.params);
    return row;
  });

  // Top CPV con trend 3 anni
  const topCpv = db.prepare(`
    SELECT codice_cpv, descrizione_cpv,
      SUM(CASE WHEN anno = ${anni[0] || 2023} THEN valore_economico ELSE 0 END) as v_primo,
      SUM(CASE WHEN anno = ${anni[1] || 2024} THEN valore_economico ELSE 0 END) as v_medio,
      SUM(CASE WHEN anno = ${anni[anni.length-1] || 2025} THEN valore_economico ELSE 0 END) as v_ultimo,
      SUM(CASE WHEN anno = ${anni[0] || 2023} THEN n_ordini ELSE 0 END) as n_primo,
      SUM(CASE WHEN anno = ${anni[anni.length-1] || 2025} THEN n_ordini ELSE 0 END) as n_ultimo,
      SUM(valore_economico) as tot_valore,
      SUM(n_ordini) as tot_ordini
    FROM mepa_ordini WHERE ${activeFilter.where}
    GROUP BY codice_cpv
    ORDER BY tot_valore DESC LIMIT 100
  `).all(...activeFilter.params);

  // Aggiungi metadati CPV Horygon e calcola crescita
  const topCpvArricchiti = topCpv.map(c => {
    const meta = getCpvMeta(c.codice_cpv);
    const crescita = c.v_primo > 0 ? ((c.v_ultimo - c.v_primo) / c.v_primo * 100) : null;
    return { ...c, ...meta, crescita_pct: crescita ? parseFloat(crescita.toFixed(1)) : null };
  });

  // Top regioni con trend
  const topRegioni = db.prepare(`
    SELECT regione_pa,
      SUM(CASE WHEN anno = ${anni[0]||2023} THEN valore_economico ELSE 0 END) as v_primo,
      SUM(CASE WHEN anno = ${anni[anni.length-1]||2025} THEN valore_economico ELSE 0 END) as v_ultimo,
      SUM(valore_economico) as tot_valore,
      SUM(n_ordini) as tot_ordini,
      COUNT(DISTINCT codice_cpv) as n_cpv
    FROM mepa_ordini WHERE regione_pa != '' AND ${activeFilter.where}
    GROUP BY regione_pa ORDER BY v_ultimo DESC LIMIT 20
  `).all(...activeFilter.params).map(r => ({
    ...r,
    crescita_pct: r.v_primo > 0 ? parseFloat(((r.v_ultimo - r.v_primo) / r.v_primo * 100).toFixed(1)) : null
  }));

  // Top tipologie PA
  const topTipologie = db.prepare(`
    SELECT tipologia_pa,
      SUM(CASE WHEN anno = ${anni[anni.length-1]||2025} THEN valore_economico ELSE 0 END) as v_ultimo,
      SUM(valore_economico) as tot_valore
    FROM mepa_ordini WHERE tipologia_pa != '' AND ${activeFilter.where}
    GROUP BY tipologia_pa ORDER BY v_ultimo DESC LIMIT 15
  `).all(...activeFilter.params);

  // Top categorie MEPA
  const topCategorie = db.prepare(`
    SELECT categoria_mepa,
      SUM(valore_economico) as tot_valore,
      SUM(n_ordini) as tot_ordini
    FROM mepa_ordini WHERE categoria_mepa != '' AND ${activeFilter.where}
    GROUP BY categoria_mepa ORDER BY tot_valore DESC LIMIT 10
  `).all(...activeFilter.params);

  // Serie temporale per anno
  const serieAnni = db.prepare(`
    SELECT anno, SUM(valore_economico) as tot_valore, SUM(n_ordini) as tot_ordini
    FROM mepa_ordini WHERE ${activeFilter.where}
    GROUP BY anno ORDER BY anno ASC
  `).all(...activeFilter.params);

  // Analisi strategica — cosa comprare
  const opportunita = topCpvArricchiti
    .filter(c => c.crescita_pct !== null && c.crescita_pct > 10 && c.v_ultimo > 50000)
    .sort((a, b) => b.crescita_pct - a.crescita_pct)
    .slice(0, 8);

  // Prodotti in declino — da evitare
  const declino = topCpvArricchiti
    .filter(c => c.crescita_pct !== null && c.crescita_pct < -10 && c.v_primo > 100000)
    .sort((a, b) => a.crescita_pct - b.crescita_pct)
    .slice(0, 5);

  // Regioni target (crescita + vicine)
  const regioniTarget = topRegioni
    .filter(r => r.crescita_pct !== null && r.crescita_pct > 0 && r.v_ultimo > 500000)
    .sort((a, b) => b.v_ultimo - a.v_ultimo)
    .slice(0, 5);

  // Predizione anno prossimo per top CPV
  const predizioni = topCpvArricchiti
    .filter(c => c.v_primo > 0 && c.v_medio > 0 && c.v_ultimo > 0)
    .map(c => {
      const valori = [c.v_primo, c.v_medio, c.v_ultimo].filter(v => v > 0);
      const trend = valori.length >= 2 ? (valori[valori.length-1] - valori[0]) / (valori.length - 1) : 0;
      return { ...c, v_pred: Math.max(0, c.v_ultimo + trend) };
    })
    .sort((a, b) => b.v_pred - a.v_pred)
    .slice(0, 10);

  return {
    anni, kpiAnni, topCpv: topCpvArricchiti, topRegioni,
    topTipologie, topCategorie, serieAnni,
    opportunita, declino, regioniTarget, predizioni,
    cpvHorygon: CPV_HORYGON,
  };
}

function scanAndImportAll() {
  const dataDir = path.join(process.cwd(), 'data', 'mepa');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    return [];
  }

  const files = listUniqueMepaFiles();
  const results = [];

  for (const file of files) {
    if (file.duplicateInFolder) {
      results.push({ file: file.name, status: 'duplicato cartella', duplicateOf: file.importedAs || 'contenuto gia visto' });
      continue;
    }
    if (file.alreadyImported) {
      results.push({ file: file.name, status: 'gia importato', duplicateOf: file.importedAs || file.name });
      continue;
    }

    try {
      const result = parseMepaCSV(file.content.toString('latin1'), file.name);
      results.push({ file: file.name, status: result.skipped ? 'duplicato import' : 'importato', ...result });
    } catch (e) {
      results.push({ file: file.name, status: 'errore', errore: e.message });
    }
  }

  inactiveOppCache = null;
  return results;
}

function rebuildMepaFromFiles() {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM mepa_ordini');
    db.exec('DELETE FROM mepa_import_log');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  inactiveOppCache = null;
  return scanAndImportAll();
}

module.exports = {
  parseMepaCSV,
  scanAndImportAll,
  rebuildMepaFromFiles,
  getMepaAnalytics,
  getMepaInactiveOpportunities,
  getCpvCatalogEntries,
  getActiveCpvPrefixes,
  getActiveCpvFilter,
  hasActiveGovernance,
  saveCpvCatalogEntry,
  listEnabledCategories,
  saveEnabledCategory,
  setEnabledCategoryState,
  deleteEnabledCategory,
  previewCpvCatalogText,
  importCpvCatalogText,
  listUniqueMepaFiles,
  normalizeCpvCode,
  formatCpvCode,
  CPV_HORYGON,
};
