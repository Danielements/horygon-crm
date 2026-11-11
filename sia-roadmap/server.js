// Piccolo server per la pagina "Stato della roadmap": serve public/ e salva stati e note
// in un file JSON (data/revisione.json). Nessuna dipendenza esterna.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORTA = parseInt(process.env.PORT || "8090", 10);
const DATI = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DATI, "revisione.json");
const PUBBLICO = path.join(__dirname, "public");
const STATI = ["Approvato", "Non approvato", "Da revisionare", "Da aggiornare", ""];

fs.mkdirSync(DATI, { recursive: true });
let revisione = {};
try { revisione = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) { revisione = {}; }

function salva() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(revisione, null, 2));
  fs.renameSync(tmp, FILE); // scrittura atomica
}

function json(res, codice, corpo) {
  res.writeHead(codice, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(corpo));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p === "/api/revisione" && req.method === "GET") return json(res, 200, revisione);

  const m = p.match(/^\/api\/revisione\/([A-Za-z0-9_-]{1,64})$/);
  if (m && req.method === "PUT") {
    let corpo = "";
    req.on("data", (c) => { corpo += c; if (corpo.length > 20000) req.destroy(); });
    req.on("end", () => {
      let d;
      try { d = JSON.parse(corpo); } catch (e) { return json(res, 400, { errore: "JSON non valido" }); }
      const stato = typeof d.stato === "string" ? d.stato : "";
      const note = typeof d.note === "string" ? d.note.slice(0, 5000) : "";
      if (!STATI.includes(stato)) return json(res, 400, { errore: "Stato non valido" });
      revisione[m[1]] = { stato, note, quando: Date.now() };
      try { salva(); } catch (e) { return json(res, 500, { errore: "Salvataggio non riuscito" }); }
      return json(res, 200, revisione[m[1]]);
    });
    return;
  }

  if (req.method !== "GET") return json(res, 405, { errore: "Metodo non ammesso" });
  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(PUBBLICO, "index.html")).pipe(res);
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Non trovato");
});

server.listen(PORTA, () => console.log(`Stato roadmap su http://0.0.0.0:${PORTA}`));
