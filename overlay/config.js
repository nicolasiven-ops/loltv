// Einstellungen von LoLTV (gemeinsamer Store für alle Fenster).
//
// Liegt als settings.json neben den Sourcen und wird von Studio-, HUD- und
// Einstellungs-Fenster gelesen; geschrieben wird nur im Einstellungs-Fenster.
// Nach jedem Speichern schickt der Main-Prozess ein "settings-changed" an
// alle Fenster, die sich daraufhin neu aufbauen.

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "settings.json");

const DEFAULTS = {
  // Spieler-Anzeige:
  //   "native" = Frames des Spectator-Clients an den Seiten (mit HP, Mana,
  //              Summoner Spells und Items) plus Champion-Detailpanel unten
  //              links — die Daten dafür gibt die API nicht her, das Spiel
  //              zeichnet sie selbst. LoLTV hält sich dann komplett raus.
  //   "bottom" = eigene LoLTV-Leiste unten Mitte (LPL-Stil), Spiel-Frames aus
  playerLayout: "native",
  showScorebar: true,     // Score-Bar oben Mitte
  showObjectives: true,   // Buff-/Spawn-Timer oben rechts
  showGold: true,         // geschätztes Gold in der Score-Bar
  showItems: true,        // Item-Raster in den Kacheln
  hudScale: 100,          // Feinjustierung der HUD-Größe in Prozent

  // Optik des Spiels selbst (wird per Replay-API gesetzt)
  fogOfWar: false,        // false = Karte komplett aufgedeckt
  nativeMinimap: true,    // Minimap des Spiels
  // Minimap-Größe: Der Schlüssel in der game.cfg ist noch nicht belegt
  // (MinimapScale zeigte keine Wirkung), daher aktuell ohne Bedienelement.
  // gamecfg.inspectHud() loggt die echten Schlüssel beim Replay-Start.
  minimapScale: 100,
  killCallouts: true,     // Kill-Banner des Spiels
  floatingText: true,     // Schadenszahlen

  // Zuletzt gesuchte Riot-IDs (neueste zuerst)
  recentAccounts: [],
};

function load() {
  try {
    const stored = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const merged = { ...load(), ...patch };
  fs.writeFileSync(FILE, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = { DEFAULTS, load, save, FILE };
