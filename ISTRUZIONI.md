# FIX v7 — Bug fix + Nuove feature

## SOSTITUISCI questi file (bug fix)
- src/routes/anagrafiche.js  → fix SQLite null/undefined
- src/routes/prodotti.js     → fix param 13 + foto multiple
- src/routes/ordini.js       → foto + tracking corrieri
- src/routes/analytics.js   → fix CIG query + storico CPV

## AGGIUNGI in src/index.js
Assicurati di avere tutte le route:
```javascript
app.use('/api/anagrafiche', require('./routes/anagrafiche'));
app.use('/api/prodotti',    require('./routes/prodotti'));
app.use('/api/ordini',      require('./routes/ordini'));
app.use('/api/analytics',   require('./routes/analytics'));
```

## AGGIUNGI public/js/patches.js
Contiene: salvaAnagrafica fix, editProdotto con foto, tracking, storico CPV

## In public/index.html — aggiunte
Vedi HTML-AGGIUNTE.html per:
1. Sezione storico CPV (aggiungere in section-analytics)
2. Modal tracking ordine
3. Pulsanti azioni ordini (🚚 tracking, 📎 allegati)

## Prima di </body> in index.html
```html
<script src="/js/patches.js"></script>
```

## Aggiorna loadAnalytics in analytics.js
Alla fine della funzione aggiungi:
```javascript
loadStoricoCPV();
```

## FIX BUG 1 — Clienti/Fornitori non si inseriscono
Il problema era undefined/null nei campi SQLite.
Fix: anagrafiche.js sanitizza tutto con s(), n(), i()

## FIX BUG 2 — SQLite param 13
Il problema era categoria_id = "" invece di null.
Fix: prodotti.js usa i() per tutti i campi numerici

## FIX BUG 3 — CIG dati non visibili in Analytics
Il problema era il cpvFilter che usava la stringa sbagliata.
Fix: analytics.js usa CPV_PREFISSI inline, verifica tabelle prima di query

## FEATURE — Tracking corrieri
- 17track.net API gratuita (registra su 17track.net/en/api)
- Aggiungi TRACK17_API_KEY nel .env
- Per GLS, BRT, SDA, Poste → link diretto al sito
- Per DHL/FedEx → link diretto

## FEATURE — Storico CPV
- Menù a tendina CPV (tutti o specifico)
- Filtro 1/2/3 anni
- Grafico MEPA annuale + CIG mensile per anno
- Tabella YoY con variazioni percentuali
