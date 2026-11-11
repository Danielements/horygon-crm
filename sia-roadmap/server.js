// Piccolo server per la pagina "Stato della roadmap": serve public/ e salva in data/revisione.json
// i valori modificati di ogni voce e lo storico delle modifiche con la motivazione.
// Nessuna dipendenza esterna.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORTA = parseInt(process.env.PORT || "8090", 10);
const DATI = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DATI, "revisione.json");
const PUBBLICO = path.join(__dirname, "public");
const STATI = ["Approvato", "Non approvato", "Da revisionare", "Da aggiornare", "Non più necessario"];
const SVIL = ["Fatto", "Parziale", "Da fare", "Diverso dalla roadmap", "Extra"];
const CAMPI = ["stato", "voce", "svil", "dett", "note"];

fs.mkdirSync(DATI, { recursive: true });
// Formato: { voci: { id: {stato, voce, svil, dett, note, quando} }, storico: { id: [ {quando, campi, motivo} ] } }
let db = { voci: {}, storico: {} };
try {
  const letto = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (letto.voci) db = { voci: letto.voci, storico: letto.storico || {} };
  else {
    // formato della prima versione: { id: {stato, note, quando} } -> riportato nello storico
    for (const [id, x] of Object.entries(letto)) {
      db.voci[id] = { stato: x.stato || "", note: x.note || "", quando: x.quando };
      db.storico[id] = [{ quando: x.quando || Date.now(), campi: { stato: ["", x.stato || ""], ...(x.note ? { note: ["", x.note] } : {}) }, motivo: "Valore impostato prima dello storico" }];
    }
  }
} catch (e) { /* nessun file: si parte vuoti */ }

function salva() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE); // scrittura atomica
}

function json(res, codice, corpo) {
  res.writeHead(codice, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(corpo));
}

const testo = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://localhost").pathname;

  if (p === "/api/revisione" && req.method === "GET") return json(res, 200, db);

  const m = p.match(/^\/api\/revisione\/([A-Za-z0-9_-]{1,64})$/);
  if (m && req.method === "PUT") {
    let corpo = "";
    req.on("data", (c) => { corpo += c; if (corpo.length > 60000) req.destroy(); });
    req.on("end", () => {
      let d;
      try { d = JSON.parse(corpo); } catch (e) { return json(res, 400, { errore: "dati non validi" }); }
      const motivo = testo(d.motivo, 2000);
      if (!motivo) return json(res, 400, { errore: "manca la motivazione" });
      const valori = {};
      for (const c of CAMPI) valori[c] = testo(d.valori && d.valori[c], c === "voce" ? 300 : 5000);
      if (!STATI.includes(valori.stato)) return json(res, 400, { errore: "stato non valido" });
      if (!SVIL.includes(valori.svil)) return json(res, 400, { errore: "stato di sviluppo non valido" });
      if (!valori.voce) return json(res, 400, { errore: "la voce non può essere vuota" });
      const campi = {};
      for (const c of CAMPI) {
        const x = d.campi && d.campi[c];
        if (Array.isArray(x) && x.length === 2) campi[c] = [testo(x[0], 5000), testo(x[1], 5000)];
      }
      if (!Object.keys(campi).length) return json(res, 400, { errore: "nessun campo cambiato" });
      const id = m[1];
      const quando = Date.now();
      db.voci[id] = { ...valori, quando };
      (db.storico[id] = db.storico[id] || []).push({ quando, campi, motivo });
      try { salva(); } catch (e) { return json(res, 500, { errore: "salvataggio non riuscito" }); }
      return json(res, 200, { valori: db.voci[id], storico: db.storico[id] });
    });
    return;
  }

  if (req.method !== "GET") return json(res, 405, { errore: "metodo non ammesso" });
  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(PUBBLICO, "index.html")).pipe(res);
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Non trovato");
});

server.listen(PORTA, () => console.log(`Stato roadmap su http://0.0.0.0:${PORTA}`));
