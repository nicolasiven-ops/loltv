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
  // MinimapMinScale wird mitskaliert, sonst klemmt das Spiel kleinere Werte
  // auf diese Untergrenze fest und der Regler bliebe wirkungslos.
  const pct = opts && opts.minimapScale;
  if (pct && pct !== 100) {
    const factor = pct / 100;
    const base = originalValue(installDir, "MinimapScale") ?? 0.55;
    set("MinimapScale", Math.min(1, Math.max(0.05, base * factor)).toFixed(3), "HUD");
    const min = originalValue(installDir, "MinimapMinScale");
    if (min !== null) {
      set("MinimapMinScale", Math.min(1, Math.max(0.02, min * factor)).toFixed(3), "HUD");
    }
  }
  fs.writeFileSync(file, text);
}

function patchPersisted(installDir, width, height, opts) {
  const file = path.join(cfgDir(installDir), "PersistedSettings.json");
  if (!fs.existsSync(file)) return;
  backupOnce(file);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const gameCfg = (data.files || []).find(
    (f) => String(f.name).toLowerCase() === "game.cfg"
  );
  if (!gameCfg) return;
  gameCfg.sections = gameCfg.sections || [];

  const section = (name) => {
    let hit = gameCfg.sections.find((s) => s.name === name);
    if (!hit) {
      hit = { name, settings: [] };
      gameCfg.sections.push(hit);
    }
    hit.settings = hit.settings || [];
    return hit;
  };
  const upsert = (sec, name, value) => {
    const hit = sec.settings.find((s) => s.name === name);
    if (hit) hit.value = String(value);
    else sec.settings.push({ name, value: String(value) });
  };

  const general = section("General");
  upsert(general, "Width", Math.round(width));
  upsert(general, "Height", Math.round(height));
  upsert(general, "WindowMode", 1);

  // Minimap-Größe: League liest den Wert bevorzugt aus dieser Datei, deshalb
  // wird sie zusätzlich zur game.cfg gepatcht.
  const pct = opts && opts.minimapScale;
  if (pct && pct !== 100) {
    const base = originalValue(installDir, "MinimapScale") ?? 0.55;
    const scaled = Math.min(1, Math.max(0.05, base * (pct / 100))).toFixed(3);
    upsert(section("HUD"), "MinimapScale", scaled);
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 4));
}

// Diagnose: alle HUD-/Minimap-bezogenen Schlüssel beider Dateien auflisten,
// damit sich der richtige Schlüsselname belegen lässt.
function inspectHud(installDir) {
  const out = [];
  try {
    const text = fs.readFileSync(path.join(cfgDir(installDir), "game.cfg"), "utf8");
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === "[HUD]");
    if (start === -1) {
      out.push("game.cfg [HUD]: (Sektion fehlt)");
    } else {
      const body = [];
      for (let i = start + 1; i < lines.length && !lines[i].startsWith("["); i++) {
        if (lines[i].trim()) body.push(lines[i].trim());
      }
      out.push("game.cfg [HUD]: " + (body.join(" | ") || "(leer)"));
    }
    const loose = lines.filter((l) => /minimap/i.test(l));
    if (loose.length) out.push("game.cfg Minimap-Zeilen: " + loose.join(" | "));
  } catch (err) {
    out.push("game.cfg nicht lesbar: " + err.message);
  }
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(cfgDir(installDir), "PersistedSettings.json"), "utf8"));
    for (const f of data.files || []) {
      for (const s of f.sections || []) {
        const hits = (s.settings || []).filter((x) => /minimap/i.test(x.name));
        for (const h of hits) out.push(`persisted ${f.name}/${s.name}: ${h.name}=${h.value}`);
      }
    }
  } catch (err) {
    out.push("PersistedSettings nicht lesbar: " + err.message);
  }
  return out.join("\n");
}

function applyStageResolution(installDir, width, height, opts) {
  patchGameCfg(installDir, width, height, opts);
  patchPersisted(installDir, width, height, opts);
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

module.exports = { applyStageResolution, restoreIfNeeded, inspectHud };
