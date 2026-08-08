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

// Wert aus der Originaldatei lesen (Backup, falls vorhanden) — so bezieht
// sich die Minimap-Prozentzahl immer auf die echte Nutzer-Einstellung und
// nicht auf einen bereits von uns geschriebenen Wert.
function originalValue(installDir, key) {
  const file = path.join(cfgDir(installDir), "game.cfg");
  const source = fs.existsSync(file + ".loltv-bak") ? file + ".loltv-bak" : file;
  try {
    const hit = new RegExp(`^${key}=([^\\r\\n]*)`, "m").exec(fs.readFileSync(source, "utf8"));
    return hit ? parseFloat(hit[1]) : null;
  } catch {
    return null;
  }
}

function patchGameCfg(installDir, width, height, opts) {
  const file = path.join(cfgDir(installDir), "game.cfg");
  if (!fs.existsSync(file)) return;
  backupOnce(file);
  let text = fs.readFileSync(file, "utf8");
  const set = (key, value, section = "General") => {
    // CRLF-sicher: nur den Wert bis zum Zeilenende ersetzen, \r erhalten.
    const re = new RegExp(`^${key}=[^\\r\\n]*`, "m");
    if (re.test(text)) text = text.replace(re, `${key}=${value}`);
    else if (new RegExp(`^\\[${section}\\]`, "m").test(text)) {
      text = text.replace(new RegExp(`^\\[${section}\\]`, "m"), `[${section}]\r\n${key}=${value}`);
    } else {
      text += `\r\n[${section}]\r\n${key}=${value}\r\n`;
    }
  };
  set("Width", Math.round(width));
  set("Height", Math.round(height));
  set("WindowMode", 1);

  // Minimap-Größe relativ zur Original-Einstellung (100 % = unverändert).
  const pct = opts && opts.minimapScale;
  if (pct && pct !== 100) {
    const base = originalValue(installDir, "MinimapScale") ?? 0.55;
    const scaled = Math.min(1, Math.max(0.05, base * (pct / 100)));
    set("MinimapScale", scaled.toFixed(3), "HUD");
  }
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

function applyStageResolution(installDir, width, height, opts) {
  patchGameCfg(installDir, width, height, opts);
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
