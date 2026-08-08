// game.cfg-Verwaltung für passgenaue Replays.
//
// Für die Dauer eines Replays wird die Spielauflösung in
// <League>/Config/game.cfg exakt auf die Bühnen-Größe gesetzt (Fenstermodus),
// damit das Spielbild 1:1 und unskaliert in der Bühne liegt — nur dann sitzen
// Mausklicks pixelgenau (das Spiel mappt Eingaben auf seine interne
// Auflösung, nicht auf die Fenstergröße).
//
// Vorher wird die Originaldatei als game.cfg.loltv-bak gesichert. Die
// Wiederherstellung passiert erst NACH Ende des Replays, weil der
// Replay-Client beim Beenden seine (für normale Spiele falsche) Auflösung
// zurück in die Datei schreibt. Ein beim Start vorgefundenes Backup wird
// ebenfalls wiederhergestellt (Absturz-Schutz).

const fs = require("fs");
const path = require("path");

function cfgPath(installDir) {
  return path.join(installDir, "Config", "game.cfg");
}

function bakPath(installDir) {
  return cfgPath(installDir) + ".loltv-bak";
}

// Auflösung + Fenstermodus (1 = klassisches Fenster) setzen; sichert vorher.
function applyStageResolution(installDir, width, height) {
  const file = cfgPath(installDir);
  let text = fs.readFileSync(file, "utf8");

  // Ein evtl. vorhandenes Backup ist das echte Original (früherer Absturz) —
  // nicht überschreiben.
  if (!fs.existsSync(bakPath(installDir))) {
    fs.writeFileSync(bakPath(installDir), text);
  }

  const set = (key, value) => {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(text)) text = text.replace(re, `${key}=${value}`);
    else text = text.replace(/^\[General\]/m, `[General]\n${key}=${value}`);
  };
  set("Width", Math.round(width));
  set("Height", Math.round(height));
  set("WindowMode", 1);
  fs.writeFileSync(file, text);
}

// Original-Config zurückschreiben, falls ein Backup existiert.
function restoreIfNeeded(installDir) {
  const bak = bakPath(installDir);
  if (!fs.existsSync(bak)) return false;
  fs.copyFileSync(bak, cfgPath(installDir));
  fs.unlinkSync(bak);
  return true;
}

module.exports = { applyStageResolution, restoreIfNeeded };
