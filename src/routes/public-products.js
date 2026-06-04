const express = require('express');
const db = require('../db/database');

const router = express.Router();

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getPublicProduct(prodottoId) {
  const product = db.prepare(`
    SELECT p.*, c.nome AS categoria_nome
    FROM prodotti p
    LEFT JOIN categorie c ON c.id = p.categoria_id
    WHERE p.id = ? AND COALESCE(p.attivo, 1) = 1
  `).get(prodottoId);
  if (!product) return null;
  product.media = db.prepare(`
    SELECT id, tipo, nome_file, path, caricato_il
    FROM prodotti_media
    WHERE prodotto_id = ?
    ORDER BY
      CASE WHEN tipo = 'immagine' THEN 0 ELSE 1 END,
      caricato_il DESC,
      id DESC
  `).all(prodottoId);
  return product;
}

function renderDocumentLabel(tipo) {
  if (tipo === 'scheda_tecnica') return 'Scheda tecnica';
  if (tipo === 'certificazione') return 'Certificazione';
  if (tipo === 'pdf') return 'Documento';
  if (tipo === 'immagine') return 'Foto';
  return tipo || 'Allegato';
}

router.get('/api/public/prodotti/:id', (req, res) => {
  const product = getPublicProduct(Number(req.params.id));
  if (!product) return res.status(404).json({ error: 'Prodotto non trovato' });
  res.json(product);
});

router.get('/prodotto/:id', (req, res) => {
  const product = getPublicProduct(Number(req.params.id));
  if (!product) {
    return res.status(404).send(`
      <!doctype html>
      <html lang="it">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Prodotto non trovato</title>
          <style>
            body { font-family: Arial, sans-serif; background:#f4f7fb; color:#14213d; display:grid; place-items:center; min-height:100vh; margin:0; }
            .box { background:#fff; padding:32px; border-radius:18px; box-shadow:0 16px 40px rgba(15,23,42,.08); max-width:480px; text-align:center; }
          </style>
        </head>
        <body>
          <div class="box">
            <h1>Prodotto non trovato</h1>
            <p>Il link o il QR code non puntano a un prodotto attivo.</p>
          </div>
        </body>
      </html>
    `);
  }

  const immagini = (product.media || []).filter((item) => item.tipo === 'immagine');
  const documenti = (product.media || []).filter((item) => item.tipo !== 'immagine');
  const heroImage = immagini[0]?.path || '';
  const galleryHtml = immagini.length
    ? immagini.map((item) => `
        <a class="gallery-card" href="${escapeHtml(item.path)}" target="_blank" rel="noopener">
          <img src="${escapeHtml(item.path)}" alt="${escapeHtml(item.nome_file || product.nome)}">
        </a>
      `).join('')
    : '<div class="empty-box">Nessuna foto disponibile</div>';
  const docsHtml = documenti.length
    ? documenti.map((item) => `
        <a class="doc-row" href="${escapeHtml(item.path)}" target="_blank" rel="noopener">
          <div>
            <strong>${escapeHtml(renderDocumentLabel(item.tipo))}</strong>
            <span>${escapeHtml(item.nome_file || 'Apri allegato')}</span>
          </div>
          <span>Apri</span>
        </a>
      `).join('')
    : '<div class="empty-box">Nessuna documentazione allegata</div>';

  res.type('html').send(`
    <!doctype html>
    <html lang="it">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(product.nome)} | Horygon CRM</title>
        <meta name="description" content="${escapeHtml(product.descrizione || product.nome)}">
        <style>
          :root {
            color-scheme: light;
            --bg: #eef3f8;
            --panel: #ffffff;
            --text: #15304f;
            --muted: #607086;
            --accent: #0f6cbd;
            --border: #dbe5ef;
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: Arial, sans-serif;
            background:
              radial-gradient(circle at top left, rgba(15,108,189,.12), transparent 32%),
              linear-gradient(180deg, #f8fbff 0%, var(--bg) 100%);
            color: var(--text);
          }
          .shell {
            max-width: 1100px;
            margin: 0 auto;
            padding: 28px 18px 48px;
          }
          .hero {
            display: grid;
            grid-template-columns: minmax(0, 1.15fr) minmax(280px, .85fr);
            gap: 22px;
            align-items: stretch;
          }
          .panel {
            background: var(--panel);
            border: 1px solid var(--border);
            border-radius: 24px;
            box-shadow: 0 20px 44px rgba(15, 23, 42, 0.08);
          }
          .hero-copy { padding: 28px; }
          .eyebrow {
            display: inline-flex;
            gap: 8px;
            align-items: center;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: .08em;
            text-transform: uppercase;
            color: var(--accent);
            background: rgba(15,108,189,.08);
            border-radius: 999px;
            padding: 8px 12px;
          }
          h1 {
            margin: 18px 0 10px;
            font-size: clamp(30px, 5vw, 44px);
            line-height: 1.05;
          }
          .subtitle {
            margin: 0 0 18px;
            color: var(--muted);
            font-size: 16px;
            line-height: 1.6;
          }
          .meta-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
            gap: 12px;
            margin-top: 22px;
          }
          .meta-card {
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 14px 16px;
            background: #fbfdff;
          }
          .meta-card span {
            display: block;
            color: var(--muted);
            font-size: 12px;
            margin-bottom: 6px;
            text-transform: uppercase;
            letter-spacing: .06em;
          }
          .meta-card strong {
            font-size: 16px;
            word-break: break-word;
          }
          .hero-image {
            min-height: 320px;
            border-radius: 24px;
            overflow: hidden;
            background: #dce7f2;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .hero-image img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }
          .hero-image .empty-box {
            width: 100%;
            height: 100%;
            display: grid;
            place-items: center;
            color: var(--muted);
            font-size: 15px;
            text-align: center;
            padding: 28px;
          }
          .section {
            margin-top: 22px;
            padding: 24px;
          }
          .section h2 {
            margin: 0 0 14px;
            font-size: 22px;
          }
          .gallery {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
            gap: 14px;
          }
          .gallery-card {
            display: block;
            border-radius: 18px;
            overflow: hidden;
            border: 1px solid var(--border);
            min-height: 160px;
            background: #f3f7fb;
          }
          .gallery-card img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
          }
          .docs {
            display: grid;
            gap: 10px;
          }
          .doc-row {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            align-items: center;
            text-decoration: none;
            color: inherit;
            padding: 16px 18px;
            border: 1px solid var(--border);
            border-radius: 16px;
            background: #fbfdff;
          }
          .doc-row strong {
            display: block;
            margin-bottom: 4px;
          }
          .doc-row span {
            color: var(--muted);
            font-size: 14px;
            word-break: break-word;
          }
          .empty-box {
            border: 1px dashed var(--border);
            border-radius: 16px;
            color: var(--muted);
            padding: 24px;
            text-align: center;
            background: rgba(255,255,255,.55);
          }
          .footer {
            margin-top: 20px;
            color: var(--muted);
            font-size: 13px;
            text-align: center;
          }
          @media (max-width: 840px) {
            .hero { grid-template-columns: 1fr; }
            .hero-copy { padding: 22px; }
            .section { padding: 20px; }
          }
        </style>
      </head>
      <body>
        <main class="shell">
          <section class="hero">
            <div class="panel hero-copy">
              <div class="eyebrow">Horygon CRM · Scheda prodotto</div>
              <h1>${escapeHtml(product.nome || 'Prodotto')}</h1>
              <p class="subtitle">${escapeHtml(product.descrizione || 'Scheda prodotto consultabile da link o QR code.')}</p>
              <div class="meta-grid">
                <div class="meta-card">
                  <span>Codice interno</span>
                  <strong>${escapeHtml(product.codice_interno || '-')}</strong>
                </div>
                <div class="meta-card">
                  <span>Barcode</span>
                  <strong>${escapeHtml(product.barcode || '-')}</strong>
                </div>
                <div class="meta-card">
                  <span>Categoria</span>
                  <strong>${escapeHtml(product.categoria_nome || '-')}</strong>
                </div>
                <div class="meta-card">
                  <span>CPV MEPA</span>
                  <strong>${escapeHtml(product.cpv_mepa || '-')}</strong>
                </div>
              </div>
            </div>
            <div class="panel hero-image">
              ${heroImage ? `<img src="${escapeHtml(heroImage)}" alt="${escapeHtml(product.nome)}">` : '<div class="empty-box">Nessuna foto principale disponibile</div>'}
            </div>
          </section>

          <section class="panel section">
            <h2>Foto prodotto</h2>
            <div class="gallery">${galleryHtml}</div>
          </section>

          <section class="panel section">
            <h2>Documentazione</h2>
            <div class="docs">${docsHtml}</div>
          </section>

          <div class="footer">
            Scheda generata da Horygon CRM
          </div>
        </main>
      </body>
    </html>
  `);
});

module.exports = router;
