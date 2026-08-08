// game.cfg-/PersistedSettings-Verwaltung für passgenaue Replays.
//
// Für die Dauer eines Replays wird die Spielauflösung exakt auf die
// Bühnen-Größe gesetzt und der Fenstermodus erzwungen (WindowMode=1),
// damit das Spielbild 1:1 und unskaliert in der Bühne liegt — nur dann
// sitzen Mausklicks pixelgenau, und nur ein Fenster (kein Vollbild)
// lässt sich überhaupt andocken.
//
// Gepatcht werden BEIDE Settings-Dateien in <League>/Config, weil je nach
// Startweg unterschiedlich gelesen wird:
//   * game.cfg               (INI, [General] Width/Height/WindowMode)
//   * PersistedSettings.json (JSON-Spiegel derselben Werte)
//
// Vorher werden Originale als *.loltv-bak gesichert. Die Wiederherstellung
// passiert erst NACH Ende des Replays (der Replay-Client schreibt beim
// Beenden seine Werte zurück in die Dateien); ein beim Start vorgefundenes
// Backup wird ebenfalls wiederhergestellt (Absturz-Schutz).

const fs = require("fs");
const path = require("path");

function cfgDir(installDir) {
  return path.join(installDir, "Config");
}

function backupOnce(file) {
  // Ein vorhandenes Backup ist das echte Original (früherer Lauf/Absturz).
  if (fs.existsSync(file) && !fs.existsSync(file + ".loltv-bak")) {
    fs.copyFileSync(file, file + ".loltv-bak");
  }
}

function patchGameCfg(installDir, width, height) {
  const file = path.join(cfgDir(installDir), "game.cfg");
  if (!fs.existsSync(file)) return;
  backupOnce(file);
  let text = fs.readFileSync(file, "utf8");
  const set = (key, value) => {
    // CRLF-sicher: nur den Wert bis zum Zeilenende ersetzen, \r erhalten.
    const re = new RegExp(`^${key}=[^\\r\\n]*`, "m");
    if (re.test(text)) text = text.replace(re, `${key}=${value}`);
    else text = text.replace(/^\[General\]/m, `[General]\r\n${key}=${value}`);
  };
  set("Width", Math.round(width));
  set("Height", Math.round(height));
  set("WindowMode", 1);
  fs.writeFileSync(file, text);
}

function patchPersisted(installDir, width, height) {
  const file = path.join(cfgDir(installDir), "PersistedSettings.json");
  if (!fs.existsSync(file)) return;
  backupOnce(file);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const gameCfg = (data.files || []).find(
    (f) => String(f.name).toLowerCase() === "game.cfg"
  );
  if (!gameCfg) return;
  let general = (gameCfg.sections || []).find((s) => s.name === "General");
  if (!general) {
    general = { name: "General", settings: [] };
    gameCfg.sections = gameCfg.sections || [];
    gameCfg.sections.push(general);
  }
  const upsert = (name, value) => {
    const hit = general.settings.find((s) => s.name === name);
    if (hit) hit.value = String(value);
    else general.settings.push({ name, value: String(value) });
  };
  upsert("Width", Math.round(width));
  upsert("Height", Math.round(height));
  upsert("WindowMode", 1);
  fs.writeFileSync(file, JSON.stringify(data, null, 4));
}

function applyStageResolution(installDir, width, height) {
  patchGameCfg(installDir, width, height);
  patchPersisted(installDir, width, height);
}

// Originale zurückschreiben, falls Backups existieren.
function restoreIfNeeded(installDir) {
  let restored = false;
  for (const name of ["game.cfg", "PersistedSettings.json"]) {
    const file = path.join(cfgDir(installDir), name);
    const bak = file + ".loltv-bak";
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, file);
      fs.unlinkSync(bak);
      restored = true;
    }
  }
  return restored;
}

module.exports = { applyStageResolution, restoreIfNeeded };
