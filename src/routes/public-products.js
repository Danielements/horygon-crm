const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const { createPreventivoPdfBuffer } = require('../services/document-pdf');

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

function getPublicMediaUrl(productId, mediaId) {
  return `/prodotto/${productId}/media/${mediaId}`;
}

function normalizeCpvValue(value) {
  return String(value || '').replace(/\D/g, '');
}

function formatCpvValue(value) {
  const normalized = normalizeCpvValue(value);
  if (!normalized) return '';
  if (normalized.length === 9) return `${normalized.slice(0, 8)}-${normalized.slice(8)}`;
  return normalized;
}

function buildDocumentPayload(productId, media = []) {
  return media
    .filter((item) => item.tipo !== 'immagine')
    .map((item) => ({
      id: Number(item.id),
      tipo: item.tipo || 'pdf',
      label: renderDocumentLabel(item.tipo),
      nome_file: item.nome_file || 'Allegato',
      url: getPublicMediaUrl(productId, item.id)
    }));
}

function getCatalogProducts() {
  const rows = db.prepare(`
    SELECT p.*, c.nome AS categoria_nome
    FROM prodotti p
    LEFT JOIN categorie c ON c.id = p.categoria_id
    WHERE COALESCE(p.attivo, 1) = 1
    ORDER BY p.nome COLLATE NOCASE, p.id DESC
  `).all();

  const mediaStmt = db.prepare(`
    SELECT id, tipo, nome_file, path, caricato_il
    FROM prodotti_media
    WHERE prodotto_id = ?
    ORDER BY
      CASE WHEN tipo = 'immagine' THEN 0 ELSE 1 END,
      caricato_il DESC,
      id DESC
  `);

  return rows.map((product) => {
    const media = mediaStmt.all(product.id);
    const images = media.filter((item) => item.tipo === 'immagine');
    const documents = buildDocumentPayload(product.id, media);
    const certifications = documents.filter((item) => item.tipo === 'certificazione');
    const technicalDocs = documents.filter((item) => item.tipo === 'scheda_tecnica');
    const genericDocs = documents.filter((item) => !['certificazione', 'scheda_tecnica'].includes(item.tipo));
    const tags = String(product.tags || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    return {
      id: Number(product.id),
      entityType: 'product',
      codice: product.codice_interno || '',
      nome: product.nome || 'Prodotto',
      descrizione: product.descrizione || '',
      categoria: product.categoria_nome || '',
      cpv: product.cpv_mepa || '',
      cpv_display: formatCpvValue(product.cpv_mepa),
      tags,
      imageUrl: images[0] ? getPublicMediaUrl(product.id, images[0].id) : '',
      gallery: images.map((item) => ({
        id: Number(item.id),
        nome_file: item.nome_file || product.nome || 'Immagine',
        url: getPublicMediaUrl(product.id, item.id)
      })),
      certifications,
      technicalDocs,
      genericDocs,
      documentCount: documents.length,
      publicUrl: `/prodotto/${product.id}`
    };
  });
}

function getCatalogKits() {
  const rows = db.prepare(`
    SELECT k.*, c.nome AS categoria_nome
    FROM kit k
    LEFT JOIN categorie c ON c.id = k.categoria_id
    WHERE COALESCE(k.attivo, 1) = 1
    ORDER BY k.nome COLLATE NOCASE, k.id DESC
  `).all();

  const componentStmt = db.prepare(`
    SELECT kc.quantita, kc.note,
      p.id AS prodotto_id,
      p.nome AS prodotto_nome,
      p.codice_interno,
      p.cpv_mepa
    FROM kit_componenti kc
    JOIN prodotti p ON p.id = kc.prodotto_id
    WHERE kc.kit_id = ? AND COALESCE(p.attivo, 1) = 1
    ORDER BY kc.ordine ASC, kc.id ASC
  `);

  return rows.map((kit) => {
    const components = componentStmt.all(kit.id);
    const cpvValues = Array.from(new Set(
      components
        .map((item) => formatCpvValue(item.cpv_mepa))
        .filter(Boolean)
    ));

    return {
      id: Number(kit.id),
      entityType: 'kit',
      codice: kit.codice_kit || '',
      nome: kit.nome || 'Kit',
      descrizione: kit.descrizione || '',
      categoria: kit.categoria_nome || '',
      cpvList: cpvValues,
      tags: [],
      imageUrl: '',
      gallery: [],
      certifications: [],
      technicalDocs: [],
      genericDocs: [],
      documentCount: 0,
      components: components.map((item) => ({
        prodotto_id: Number(item.prodotto_id),
        codice: item.codice_interno || '',
        nome: item.prodotto_nome || 'Prodotto',
        quantita: Number(item.quantita || 0),
        cpv_display: formatCpvValue(item.cpv_mepa),
        note: item.note || ''
      }))
    };
  });
}

function getPublicCatalogData(options = {}) {
  const search = String(options.search || '').trim().toLowerCase();
  const requestedCpv = formatCpvValue(options.cpv || '');
  const products = getCatalogProducts();
  const kits = getCatalogKits();
  const items = [];

  products.forEach((product) => {
    const cpvList = product.cpv_display ? [product.cpv_display] : ['Senza CPV'];
    const haystack = [
      product.nome,
      product.codice,
      product.descrizione,
      product.categoria,
      product.cpv_display,
      ...(product.tags || [])
    ].join(' ').toLowerCase();
    if (search && !haystack.includes(search)) return;
    if (requestedCpv && !cpvList.includes(requestedCpv)) return;
    items.push({ ...product, cpvList });
  });

  kits.forEach((kit) => {
    const cpvList = kit.cpvList.length ? kit.cpvList : ['Senza CPV'];
    const haystack = [
      kit.nome,
      kit.codice,
      kit.descrizione,
      kit.categoria,
      ...cpvList,
      ...kit.components.map((item) => `${item.codice} ${item.nome} ${item.cpv_display}`)
    ].join(' ').toLowerCase();
    if (search && !haystack.includes(search)) return;
    if (requestedCpv && !cpvList.includes(requestedCpv)) return;
    items.push({ ...kit, cpvList });
  });

  const groupsMap = new Map();
  items.forEach((item) => {
    item.cpvList.forEach((cpv) => {
      if (!groupsMap.has(cpv)) {
        groupsMap.set(cpv, {
          cpv,
          cpvLabel: cpv === 'Senza CPV' ? 'Senza CPV assegnato' : `CPV ${cpv}`,
          items: []
        });
      }
      groupsMap.get(cpv).items.push(item);
    });
  });

  const groups = Array.from(groupsMap.values())
    .sort((a, b) => {
      if (a.cpv === 'Senza CPV') return 1;
      if (b.cpv === 'Senza CPV') return -1;
      return a.cpv.localeCompare(b.cpv, 'it');
    })
    .map((group) => ({
      ...group,
      items: group.items.sort((a, b) => a.nome.localeCompare(b.nome, 'it')),
      itemCount: group.items.length,
      productCount: group.items.filter((item) => item.entityType === 'product').length,
      kitCount: group.items.filter((item) => item.entityType === 'kit').length
    }));

  return {
    filters: {
      search,
      cpv: requestedCpv
    },
    totals: {
      groups: groups.length,
      items: items.length,
      products: items.filter((item) => item.entityType === 'product').length,
      kits: items.filter((item) => item.entityType === 'kit').length,
      certifications: items.reduce((sum, item) => sum + (item.certifications?.length || 0), 0),
      technicalDocs: items.reduce((sum, item) => sum + (item.technicalDocs?.length || 0), 0)
    },
    availableCpvs: Array.from(new Set(
      items.flatMap((item) => item.cpvList)
    )).sort((a, b) => {
      if (a === 'Senza CPV') return 1;
      if (b === 'Senza CPV') return -1;
      return a.localeCompare(b, 'it');
    }),
    groups
  };
}

function renderLandingItemCard(item) {
  const badge = item.entityType === 'kit' ? 'Kit' : 'Articolo';
  const tagsHtml = (item.tags || []).length
    ? `<div class="landing-tag-row">${item.tags.map((tag) => `<span class="landing-tag">${escapeHtml(tag)}</span>`).join('')}</div>`
    : '';
  const docs = [
    ...(item.certifications || []),
    ...(item.technicalDocs || []),
    ...(item.genericDocs || [])
  ];
  const docsHtml = docs.length
    ? docs.map((doc) => `
        <a class="landing-doc" href="${escapeHtml(doc.url)}" target="_blank" rel="noopener">
          <strong>${escapeHtml(doc.label)}</strong>
          <span>${escapeHtml(doc.nome_file)}</span>
        </a>
      `).join('')
    : '<div class="landing-empty">Nessuna documentazione pubblicata</div>';
  const componentsHtml = item.entityType === 'kit'
    ? `
      <div class="landing-kit-box">
        <div class="landing-subtitle">Componenti kit</div>
        ${(item.components || []).length
          ? `<div class="landing-component-list">${item.components.map((component) => `
              <div class="landing-component">
                <strong>${escapeHtml(component.codice || '-')} · ${escapeHtml(component.nome)}</strong>
                <span>Qtà ${escapeHtml(component.quantita)}${component.cpv_display ? ` · CPV ${escapeHtml(component.cpv_display)}` : ''}</span>
              </div>
            `).join('')}</div>`
          : '<div class="landing-empty">Nessun componente associato</div>'}
      </div>
    `
    : '';
  const galleryHtml = item.imageUrl
    ? `<img class="landing-card-image" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.nome)}">`
    : '<div class="landing-card-image landing-card-image-empty">Nessuna immagine</div>';
  const productLinkHtml = item.publicUrl
    ? `<a class="landing-link-btn" href="${escapeHtml(item.publicUrl)}" target="_blank" rel="noopener">Apri scheda</a>`
    : '';

  return `
    <article class="landing-card">
      <div class="landing-card-media">
        ${galleryHtml}
      </div>
      <div class="landing-card-body">
        <div class="landing-card-top">
          <span class="landing-badge">${badge}</span>
          <span class="landing-code">${escapeHtml(item.codice || '-')}</span>
        </div>
        <h3>${escapeHtml(item.nome)}</h3>
        <p class="landing-description">${escapeHtml(item.descrizione || 'Scheda di presentazione disponibile per il catalogo MEPA.')}</p>
        <div class="landing-meta-grid">
          <div><span>Categoria</span><strong>${escapeHtml(item.categoria || '-')}</strong></div>
          <div><span>CPV</span><strong>${escapeHtml((item.cpvList || []).join(', ') || '-')}</strong></div>
        </div>
        ${tagsHtml}
        ${componentsHtml}
        <div class="landing-docs-wrap">
          <div class="landing-subtitle">Certificazioni e allegati</div>
          <div class="landing-docs">${docsHtml}</div>
        </div>
        ${productLinkHtml}
      </div>
    </article>
  `;
}

function renderCatalogLanding(data, options = {}) {
  const basePath = options.basePath || '/catalogo-mepa';
  const cpvOptionsHtml = [
    '<option value="">Tutti i CPV</option>',
    ...data.availableCpvs.map((cpv) => `<option value="${escapeHtml(cpv)}"${data.filters.cpv === cpv ? ' selected' : ''}>${escapeHtml(cpv === 'Senza CPV' ? 'Senza CPV assegnato' : cpv)}</option>`)
  ].join('');
  const groupsHtml = data.groups.length
    ? data.groups.map((group) => `
        <section class="cpv-block" id="cpv-${escapeHtml(group.cpv.replace(/\s+/g, '-'))}">
          <div class="cpv-block-head">
            <div>
              <span class="cpv-label">${escapeHtml(group.cpvLabel)}</span>
              <h2>${escapeHtml(group.itemCount)} referenze pubblicabili</h2>
            </div>
            <div class="cpv-stats">
              <span>${escapeHtml(group.productCount)} articoli</span>
              <span>${escapeHtml(group.kitCount)} kit</span>
            </div>
          </div>
          <div class="landing-grid">
            ${group.items.map(renderLandingItemCard).join('')}
          </div>
        </section>
      `).join('')
    : `
      <section class="cpv-block">
        <div class="empty-state">
          <h2>Nessun elemento da mostrare</h2>
          <p>La landing è pronta, ma per ora non risultano articoli o kit compatibili con i filtri scelti.</p>
        </div>
      </section>
    `;

  return `
    <!doctype html>
    <html lang="it">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Catalogo MEPA | Horygon</title>
        <meta name="description" content="Landing page per prodotti e kit selezionati MEPA, raggruppati per CPV e corredati da certificazioni e documentazione.">
        <style>
          :root {
            color-scheme: light;
            --bg: #f4f1ea;
            --panel: rgba(255,255,255,0.88);
            --panel-strong: #ffffff;
            --text: #1a2233;
            --muted: #667085;
            --line: rgba(26,34,51,0.12);
            --brand: #0d5c63;
            --brand-soft: #dcefeb;
            --accent: #c97b32;
            --shadow: 0 24px 60px rgba(26,34,51,0.10);
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: "Segoe UI", "Trebuchet MS", Arial, sans-serif;
            color: var(--text);
            background:
              radial-gradient(circle at top left, rgba(201,123,50,.20), transparent 28%),
              radial-gradient(circle at top right, rgba(13,92,99,.16), transparent 32%),
              linear-gradient(180deg, #fbf8f2 0%, var(--bg) 100%);
          }
          a { color: inherit; }
          .shell {
            width: min(1280px, calc(100vw - 32px));
            margin: 0 auto;
            padding: 28px 0 52px;
          }
          .hero {
            position: relative;
            overflow: hidden;
            padding: 34px;
            border: 1px solid rgba(255,255,255,0.5);
            border-radius: 32px;
            background:
              linear-gradient(135deg, rgba(255,255,255,.96) 0%, rgba(244,249,248,.88) 55%, rgba(255,248,240,.92) 100%);
            box-shadow: var(--shadow);
          }
          .hero::after {
            content: "";
            position: absolute;
            inset: auto -80px -80px auto;
            width: 260px;
            height: 260px;
            border-radius: 50%;
            background: radial-gradient(circle, rgba(201,123,50,.24), transparent 68%);
            pointer-events: none;
          }
          .eyebrow {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 14px;
            border-radius: 999px;
            background: rgba(13,92,99,.10);
            color: var(--brand);
            font-size: 12px;
            font-weight: 700;
            letter-spacing: .08em;
            text-transform: uppercase;
          }
          h1 {
            margin: 18px 0 14px;
            max-width: 780px;
            font-size: clamp(34px, 5vw, 62px);
            line-height: .98;
          }
          .hero-copy {
            max-width: 840px;
            color: var(--muted);
            font-size: 17px;
            line-height: 1.7;
          }
          .hero-summary {
            display: grid;
            grid-template-columns: repeat(5, minmax(0, 1fr));
            gap: 14px;
            margin-top: 24px;
          }
          .summary-card {
            padding: 16px;
            border-radius: 20px;
            background: rgba(255,255,255,.72);
            border: 1px solid rgba(26,34,51,.08);
            backdrop-filter: blur(8px);
          }
          .summary-card span {
            display: block;
            margin-bottom: 8px;
            color: var(--muted);
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: .06em;
          }
          .summary-card strong {
            font-size: 28px;
            line-height: 1;
          }
          .toolbar {
            display: grid;
            grid-template-columns: minmax(0, 1.5fr) minmax(220px, .7fr) auto;
            gap: 12px;
            align-items: end;
            margin: 24px 0 18px;
            padding: 18px;
            border-radius: 24px;
            background: var(--panel);
            border: 1px solid rgba(255,255,255,.65);
            box-shadow: var(--shadow);
            backdrop-filter: blur(14px);
          }
          .toolbar label {
            display: block;
            margin-bottom: 7px;
            color: var(--muted);
            font-size: 12px;
            font-weight: 700;
            letter-spacing: .06em;
            text-transform: uppercase;
          }
          .toolbar input,
          .toolbar select {
            width: 100%;
            border: 1px solid var(--line);
            border-radius: 16px;
            padding: 13px 15px;
            background: var(--panel-strong);
            color: var(--text);
            font-size: 14px;
          }
          .toolbar button {
            border: 0;
            border-radius: 16px;
            padding: 13px 18px;
            background: var(--brand);
            color: #fff;
            font-weight: 700;
            cursor: pointer;
          }
          .cpv-block {
            margin-top: 18px;
            padding: 22px;
            border-radius: 28px;
            background: rgba(255,255,255,.82);
            border: 1px solid rgba(255,255,255,.72);
            box-shadow: var(--shadow);
            backdrop-filter: blur(12px);
          }
          .cpv-block-head {
            display: flex;
            justify-content: space-between;
            gap: 18px;
            align-items: end;
            margin-bottom: 18px;
          }
          .cpv-label {
            display: inline-flex;
            padding: 7px 12px;
            border-radius: 999px;
            background: var(--brand-soft);
            color: var(--brand);
            font-size: 12px;
            font-weight: 700;
            letter-spacing: .06em;
            text-transform: uppercase;
          }
          .cpv-block-head h2 {
            margin: 10px 0 0;
            font-size: 28px;
          }
          .cpv-stats {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
          }
          .cpv-stats span {
            display: inline-flex;
            align-items: center;
            padding: 9px 12px;
            border-radius: 999px;
            border: 1px solid var(--line);
            color: var(--muted);
            font-size: 13px;
            background: rgba(255,255,255,.8);
          }
          .landing-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 18px;
          }
          .landing-card {
            display: grid;
            grid-template-columns: minmax(160px, 220px) minmax(0, 1fr);
            gap: 18px;
            padding: 18px;
            border-radius: 24px;
            border: 1px solid rgba(26,34,51,.08);
            background: linear-gradient(180deg, rgba(255,255,255,.94) 0%, rgba(248,250,251,.92) 100%);
          }
          .landing-card-media {
            min-height: 180px;
          }
          .landing-card-image {
            width: 100%;
            height: 100%;
            min-height: 180px;
            object-fit: cover;
            border-radius: 18px;
            background: #edf2f7;
            border: 1px solid rgba(26,34,51,.08);
          }
          .landing-card-image-empty {
            display: grid;
            place-items: center;
            padding: 18px;
            color: var(--muted);
            font-size: 14px;
          }
          .landing-card-top {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            align-items: center;
            margin-bottom: 10px;
          }
          .landing-badge {
            display: inline-flex;
            align-items: center;
            padding: 6px 10px;
            border-radius: 999px;
            background: rgba(201,123,50,.14);
            color: #8a4d18;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: .05em;
            text-transform: uppercase;
          }
          .landing-code {
            color: var(--muted);
            font-size: 12px;
            font-weight: 700;
            letter-spacing: .04em;
          }
          .landing-card h3 {
            margin: 0 0 10px;
            font-size: 24px;
            line-height: 1.08;
          }
          .landing-description {
            margin: 0;
            color: var(--muted);
            line-height: 1.65;
          }
          .landing-meta-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 10px;
            margin: 16px 0 12px;
          }
          .landing-meta-grid div,
          .landing-kit-box,
          .landing-docs-wrap {
            padding: 13px 14px;
            border-radius: 16px;
            background: rgba(12, 20, 32, 0.03);
            border: 1px solid rgba(26,34,51,.08);
          }
          .landing-meta-grid span,
          .landing-subtitle {
            display: block;
            margin-bottom: 6px;
            color: var(--muted);
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: .06em;
            font-weight: 700;
          }
          .landing-meta-grid strong {
            display: block;
            font-size: 14px;
            line-height: 1.4;
          }
          .landing-tag-row,
          .landing-component-list,
          .landing-docs {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
          }
          .landing-tag {
            display: inline-flex;
            padding: 6px 10px;
            border-radius: 999px;
            background: rgba(13,92,99,.08);
            color: var(--brand);
            font-size: 12px;
            font-weight: 600;
          }
          .landing-kit-box,
          .landing-docs-wrap {
            margin-top: 12px;
          }
          .landing-component {
            display: grid;
            gap: 4px;
            width: 100%;
            padding: 10px 12px;
            border-radius: 14px;
            background: rgba(255,255,255,.9);
            border: 1px solid rgba(26,34,51,.08);
          }
          .landing-component strong {
            font-size: 13px;
            line-height: 1.35;
          }
          .landing-component span {
            color: var(--muted);
            font-size: 12px;
            line-height: 1.45;
          }
          .landing-doc {
            display: grid;
            gap: 4px;
            width: calc(50% - 4px);
            min-width: 220px;
            padding: 12px;
            border-radius: 14px;
            background: rgba(255,255,255,.92);
            border: 1px solid rgba(26,34,51,.08);
            text-decoration: none;
          }
          .landing-doc strong {
            font-size: 13px;
          }
          .landing-doc span {
            color: var(--muted);
            font-size: 12px;
            line-height: 1.45;
            word-break: break-word;
          }
          .landing-empty,
          .empty-state p {
            color: var(--muted);
          }
          .landing-link-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-top: 14px;
            padding: 11px 14px;
            border-radius: 14px;
            background: var(--brand);
            color: #fff;
            text-decoration: none;
            font-weight: 700;
          }
          .empty-state {
            padding: 26px;
            border-radius: 22px;
            text-align: center;
            background: rgba(255,255,255,.72);
            border: 1px dashed var(--line);
          }
          @media (max-width: 1080px) {
            .hero-summary,
            .landing-grid {
              grid-template-columns: repeat(2, minmax(0, 1fr));
            }
            .toolbar {
              grid-template-columns: 1fr;
            }
          }
          @media (max-width: 760px) {
            .shell {
              width: min(100vw - 20px, 100%);
              padding-top: 14px;
            }
            .hero,
            .cpv-block {
              padding: 18px;
              border-radius: 24px;
            }
            .hero-summary,
            .landing-grid,
            .landing-meta-grid {
              grid-template-columns: 1fr;
            }
            .landing-card {
              grid-template-columns: 1fr;
            }
            .cpv-block-head {
              flex-direction: column;
              align-items: flex-start;
            }
            .landing-doc {
              width: 100%;
              min-width: 0;
            }
          }
        </style>
      </head>
      <body>
        <main class="shell">
          <section class="hero">
            <div class="eyebrow">Catalogo selezionato MEPA</div>
            <h1>Prodotti e kit raggruppati per CPV, con certificazioni sempre visibili.</h1>
            <p class="hero-copy">
              Questa landing raccoglie le referenze pubblicabili del catalogo Horygon e le organizza per codice CPV,
              così puoi presentare in una sola pagina più articoli e più kit, con accesso diretto a certificazioni,
              schede tecniche e documentazione allegata.
            </p>
            <div class="hero-summary">
              <div class="summary-card"><span>Gruppi CPV</span><strong>${escapeHtml(data.totals.groups)}</strong></div>
              <div class="summary-card"><span>Referenze</span><strong>${escapeHtml(data.totals.items)}</strong></div>
              <div class="summary-card"><span>Articoli</span><strong>${escapeHtml(data.totals.products)}</strong></div>
              <div class="summary-card"><span>Kit</span><strong>${escapeHtml(data.totals.kits)}</strong></div>
              <div class="summary-card"><span>Certificazioni</span><strong>${escapeHtml(data.totals.certifications)}</strong></div>
            </div>
          </section>

          <form class="toolbar" method="get" action="${escapeHtml(basePath)}">
            <div>
              <label for="search">Ricerca</label>
              <input id="search" type="text" name="q" placeholder="Cerca per nome, codice, categoria, tag o componente" value="${escapeHtml(data.filters.search || '')}">
            </div>
            <div>
              <label for="cpv">Filtro CPV</label>
              <select id="cpv" name="cpv">${cpvOptionsHtml}</select>
            </div>
            <div>
              <label>&nbsp;</label>
              <button type="submit">Aggiorna vista</button>
            </div>
          </form>

          ${groupsHtml}
        </main>
      </body>
    </html>
  `;
}

router.get('/api/public/preventivi/:token/pdf', async (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(404).json({ error: 'Preventivo non trovato' });

  const preventivo = db.prepare('SELECT id FROM preventivi WHERE public_token = ? LIMIT 1').get(token);
  if (!preventivo?.id) return res.status(404).json({ error: 'Preventivo non trovato' });

  try {
    const pdf = await createPreventivoPdfBuffer(preventivo.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=${pdf.filename}`);
    res.send(pdf.buffer);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

router.get('/api/public/prodotti/:id', (req, res) => {
  const product = getPublicProduct(Number(req.params.id));
  if (!product) return res.status(404).json({ error: 'Prodotto non trovato' });
  res.json(product);
});

router.get('/api/public/catalogo-mepa', (req, res) => {
  const data = getPublicCatalogData({
    search: req.query.q,
    cpv: req.query.cpv
  });
  res.json(data);
});

router.get('/catalogo-mepa', (req, res) => {
  const data = getPublicCatalogData({
    search: req.query.q,
    cpv: req.query.cpv
  });
  res.type('html').send(renderCatalogLanding(data, { basePath: '/catalogo-mepa' }));
});

router.get('/prodotto/:id/media/:mediaId', (req, res) => {
  const productId = Number(req.params.id);
  const mediaId = Number(req.params.mediaId);
  const product = getPublicProduct(productId);
  if (!product) return res.status(404).send('Prodotto non trovato');
  const media = (product.media || []).find((item) => Number(item.id) === mediaId);
  if (!media?.path) return res.status(404).send('Documento non trovato');

  const uploadsRoot = path.resolve(process.cwd(), 'uploads');
  const relativePath = String(media.path || '').replace(/^\/+/, '');
  const absolutePath = path.resolve(process.cwd(), relativePath);
  if (!absolutePath.startsWith(uploadsRoot) || !fs.existsSync(absolutePath)) {
    return res.status(404).send('Documento non disponibile');
  }

  if (media.nome_file) {
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(media.nome_file)}"`);
  }
  res.sendFile(absolutePath);
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
        <a class="gallery-card" href="${escapeHtml(getPublicMediaUrl(product.id, item.id))}" target="_blank" rel="noopener">
          <img src="${escapeHtml(getPublicMediaUrl(product.id, item.id))}" alt="${escapeHtml(item.nome_file || product.nome)}">
        </a>
      `).join('')
    : '<div class="empty-box">Nessuna foto disponibile</div>';
  const docsHtml = documenti.length
    ? documenti.map((item) => `
        <a class="doc-row" href="${escapeHtml(getPublicMediaUrl(product.id, item.id))}" target="_blank" rel="noopener">
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
