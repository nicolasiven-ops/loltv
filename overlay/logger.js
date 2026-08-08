// Mini-Logger für die Fehlersuche: schreibt Zeilen mit Zeitstempel nach
// loltv.log neben den Sourcen. Der Main-Prozess leert die Datei beim Start.

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "loltv.log");

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map(String).join(" ")}\n`;
  try { fs.appendFileSync(FILE, line); } catch { /* Logging darf nie stören */ }
}

function reset() {
  try { fs.writeFileSync(FILE, ""); } catch { /* s. o. */ }
}

module.exports = { log, reset, FILE };
