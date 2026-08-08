// LoLTV Broadcast-Overlay — Datenlogik.
//
// Pollt die lokale Live-Client-Data-API des Replay-Clients (Port 2999, läuft
// auch bei Replays) und rendert daraus Score-Bar und Team-Frames. Beim ersten
// erfolgreichen Kontakt wird das native HUD per Replay-API ausgeblendet
// („Takeover“) — Minimap, Ansagen und Kill-Banner des Spiels bleiben an.
//
// Vorschau ohne Spiel: overlay.html?mock=1 im Browser öffnen.

const API = "https://127.0.0.1:2999";
const POLL_MS = 1000;
const MOCK = new URLSearchParams(location.search).has("mock");

// Diagnose-Logging (nur in Electron verfügbar, nicht in der Browser-Vorschau).
const HAS_NODE = typeof require === "function";
const log = HAS_NODE ? require("./logger").log : () => {};
const config = HAS_NODE ? require("./config") : null;
const ipc = HAS_NODE ? require("electron").ipcRenderer : null;
let eventsLogged = false;
let sampleLogged = false;

// Aktuelle Einstellungen; in der Browser-Vorschau aus den Query-Parametern
// (?layout=sides), sonst aus settings.json.
let settings = config ? config.load() : {
  playerLayout: new URLSearchParams(location.search).get("layout") || "bottom",
  showScorebar: true, showObjectives: true, showGold: true, showItems: true,
  hudScale: 100, fogOfWar: false, nativeMinimap: true, killCallouts: true,
  floatingText: true,
};

// Beim Takeover gesetzte Render-Eigenschaften: eigenes HUD statt Spiel-HUD.
// Die vom Nutzer steuerbaren Teile kommen aus den Einstellungen.
function takeoverProps() {
  return {
    fogOfWar: settings.fogOfWar,
    interfaceScoreboard: false,
    // interfaceFrames steuert BEIDES: die Spectator-Frames an den Seiten und
    // das Champion-Detailpanel unten links. Entweder das Spiel zeichnet die
    // Spieler-Anzeige (dann hält sich LoLTV raus) oder wir — nie beides,
    // sonst überlagern sich die Anzeigen.
    interfaceFrames: settings.playerLayout === "native",
    interfaceScore: false,
    interfaceTimeline: false,
    interfaceReplay: false,
    interfaceMinimap: settings.nativeMinimap,
    interfaceAnnounce: true,
    interfaceKillCallouts: settings.killCallouts,
    interfaceNeutralTimers: !settings.showObjectives, // sonst doppelt
    interfaceTarget: true,         // Champion-Panel unten links (bei Auswahl)
    floatingText: settings.floatingText,
    cameraAttached: false,
  };
}

const DRAKE_COLORS = {
  Fire: "#e06c4b", Ocean: "#4bb7e0", Mountain: "#b08d57", Air: "#a9c1c9",
  Hextech: "#5cd6d0", Chemtech: "#8fd65c", Elder: "#b48ce0", Earth: "#b08d57",
  Cloud: "#a9c1c9", Infernal: "#e06c4b",
};

let ddragonVersion = null; // Data-Dragon-Version für Champion-/Item-Bilder
let takeoverDone = false;
let connected = false;
let lastData = null;       // letzter Datensatz, für sofortiges Neuzeichnen

// ---------------------------------------------------------------- Utilities

const $ = (id) => document.getElementById(id);

function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// "game_character_displayname_MonkeyKing" -> "MonkeyKing" (Data-Dragon-Key)
function champKey(player) {
  const raw = player.rawChampionName || "";
  const key = raw.split("_").pop();
  return key || player.championName || "";
}

async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  if (!resp.ok) throw new Error(`${resp.status} ${url}`);
  return resp.json();
}

// ------------------------------------------------------------ Riot-Anbindung

async function loadDdragonVersion() {
  try {
    const versions = await fetchJson("https://ddragon.leagueoflegends.com/api/versions.json");
    ddragonVersion = versions[0];
  } catch {
    ddragonVersion = null; // offline → Fallback-Kacheln mit Initialen
  }
}

async function takeover() {
  if (takeoverDone || MOCK) return;
  try {
    await fetch(`${API}/replay/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(takeoverProps()),
    });
    takeoverDone = true;
  } catch {
    /* nächster Poll versucht es erneut */
  }
}

// ------------------------------------------------------- Team-Statistiken

// Turm-Namen tragen den Besitzer: _T1_ = blau (ORDER), _T2_ = rot (CHAOS).
// Ein zerstörter T1-Turm zählt also für Rot — und umgekehrt.
// KillerName kommt je nach Patch als Summoner-Name ODER volle Riot-ID
// ("Name#TAG") — das Mapping kennt beide Formen.
const BARON_BUFF_S = 180;
const ELDER_BUFF_S = 150;

function teamStats(players, events, now) {
  const stats = {
    ORDER: { kills: 0, towers: 0, barons: 0, drakes: [], buffs: [] },
    CHAOS: { kills: 0, towers: 0, barons: 0, drakes: [], buffs: [] },
  };
  const teamOf = {};
  for (const p of players) {
    for (const key of [
      p.summonerName, p.riotIdGameName,
      p.riotIdGameName && p.riotIdTagLine ? `${p.riotIdGameName}#${p.riotIdTagLine}` : null,
    ]) {
      if (key) teamOf[key] = p.team;
    }
    stats[p.team].kills += p.scores.kills;
  }
  const resolveTeam = (name) =>
    teamOf[name] || teamOf[String(name || "").split("#")[0]] || null;

  for (const ev of events) {
    if (ev.EventName === "TurretKilled") {
      if (String(ev.TurretKilled).includes("_T1_")) stats.CHAOS.towers += 1;
      else if (String(ev.TurretKilled).includes("_T2_")) stats.ORDER.towers += 1;
    } else if (ev.EventName === "DragonKill") {
      const team = resolveTeam(ev.KillerName);
      if (!team) continue;
      stats[team].drakes.push(ev.DragonType);
      const left = ELDER_BUFF_S - (now - ev.EventTime);
      if (ev.DragonType === "Elder" && left > 0) {
        stats[team].buffs.push({ label: "ELDER", cls: "elder", left });
      }
    } else if (ev.EventName === "BaronKill") {
      const team = resolveTeam(ev.KillerName);
      if (!team) continue;
      stats[team].barons += 1;
      const left = BARON_BUFF_S - (now - ev.EventTime);
      if (left > 0) stats[team].buffs.push({ label: "BARON", cls: "baron", left });
    }
  }
  return stats;
}

// Spawn-Countdowns für die Objective-Anzeige oben rechts. Baron spawnt bei
// 20:00 und 6 min nach jedem Kill; Drachen ab 5:00 im 5-Minuten-Takt, nach
// der Seele (4 Drachen eines Teams) kommt stattdessen der Elder (6 min).
function spawnTimers(stats, events, now) {
  const chips = [];
  const baronKills = events.filter((e) => e.EventName === "BaronKill");
  const baronNext = baronKills.length
    ? baronKills[baronKills.length - 1].EventTime + 360
    : 1200;
  const baronLeft = baronNext - now;
  if (baronLeft > 0 && baronLeft <= 300) {
    chips.push({ label: "BARON", cls: "spawn baron", left: baronLeft });
  }
  const dragonKills = events.filter((e) => e.EventName === "DragonKill");
  const soul = stats.ORDER.drakes.length >= 4 || stats.CHAOS.drakes.length >= 4;
  const dragonNext = dragonKills.length
    ? dragonKills[dragonKills.length - 1].EventTime + (soul ? 360 : 300)
    : 300;
  const dragonLeft = dragonNext - now;
  if (dragonLeft > 0 && dragonLeft <= 360) {
    chips.push({
      label: soul ? "ELDER" : "DRACHE",
      cls: soul ? "spawn elder" : "spawn",
      left: dragonLeft,
    });
  }
  return chips;
}

// Geschätztes Team-Gold (die API gibt im Replay kein echtes Gold her):
// Startgold + passives Einkommen ab 1:50 + grobe Werte je CS/Kill/Assist.
function estimatedGold(players, team, now) {
  let sum = 0;
  for (const p of players) {
    if (p.team !== team) continue;
    const s = p.scores;
    sum += 500
      + Math.max(0, now - 110) * 2.04
      + s.creepScore * 21
      + s.kills * 300
      + s.assists * 95;
  }
  return sum;
}

// ------------------------------------------------------------------ Render

// Eine Spieler-Kachel der unteren Leiste (LPL-Stil): Item-Raster links,
// großes Portrait mit Level-Badge rechts, darunter Name und KDA/CS.
function playerTile(p) {
  const key = champKey(p);
  const name = p.riotIdGameName || p.summonerName || "?";
  const s = p.scores;
  const portrait = ddragonVersion
    ? `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${key}.png"
         onerror="this.remove()" alt="">`
    : "";
  const respawn = p.isDead && p.respawnTimer > 0
    ? `<div class="respawn">${Math.ceil(p.respawnTimer)}</div>` : "";

  // 7 feste Slots (6 Items + Trinket) im 2-spaltigen Raster neben dem Portrait.
  const slots = settings.showItems ? Array.from({ length: 7 }, (_, i) => {
    const item = (p.items || []).find((it) => it.slot === i);
    const img = item && ddragonVersion
      ? `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${item.itemID}.png"
           onerror="this.remove()" alt="">`
      : "";
    return `<div class="item">${img}</div>`;
  }) : [];

  return `<div class="tile ${p.isDead ? "dead" : ""}">
    <div class="tile-top">
      <div class="tile-items">${slots.join("")}</div>
      <div class="portrait-wrap">
        <div class="portrait">${portrait || key.slice(0, 1)}</div>
        ${respawn}
        <div class="level">${p.level}</div>
      </div>
    </div>
    <div class="tile-text">
      <div class="tile-name">${name}</div>
      <div class="tile-stats">
        <span class="kda">${s.kills}/<span class="d">${s.deaths}</span>/${s.assists}</span>
        <span class="cs">${s.creepScore} CS</span>
      </div>
    </div>
  </div>`;
}

function render(data) {
  const players = data.allPlayers || [];
  const events = (data.events && data.events.Events) || [];
  const now = data.gameData ? data.gameData.gameTime : 0;
  const stats = teamStats(players, events, now);

  if (!eventsLogged && events.length > 0) {
    eventsLogged = true;
    log("hud: erste Events:", events.length, JSON.stringify(events.slice(0, 5)));
    log("hud: Event-Typen:", [...new Set(events.map((e) => e.EventName))].join(", "));
  }
  // Einmalige Feld-Inventur (u. a. für die Role-Quest-Datenquelle).
  if (!sampleLogged && players.length > 0) {
    sampleLogged = true;
    log("hud: Spieler-Beispiel:", JSON.stringify(players[0]));
    log("hud: gameData:", JSON.stringify(data.gameData));
  }

  $("clock").textContent = fmtClock(now);
  $("kills-blue").textContent = stats.ORDER.kills;
  $("kills-red").textContent = stats.CHAOS.kills;
  $("towers-blue").textContent = stats.ORDER.towers;
  $("towers-red").textContent = stats.CHAOS.towers;

  // Absolutes Gold (Schätzung, s. estimatedGold) + Differenz unterm Führenden.
  const goldBlue = estimatedGold(players, "ORDER", now);
  const goldRed = estimatedGold(players, "CHAOS", now);
  const diff = goldBlue - goldRed;
  if (settings.showGold) {
    $("gold-blue").textContent = `~${(goldBlue / 1000).toFixed(1)}k`;
    $("gold-red").textContent = `~${(goldRed / 1000).toFixed(1)}k`;
    $("golddiff-blue").textContent = diff >= 300 ? `+${(diff / 1000).toFixed(1)}k` : "";
    $("golddiff-blue").style.color = "var(--blue-bright)";
    $("golddiff-red").textContent = diff <= -300 ? `+${(-diff / 1000).toFixed(1)}k` : "";
    $("golddiff-red").style.color = "var(--red-bright)";
  }

  // Role-Quest-Slots: Layout steht, Datenquelle wird noch verdrahtet —
  // welche Felder die API dafür liefert, zeigt das Diagnose-Log.
  for (const id of ["quests-blue", "quests-red"]) {
    if (!$(id).childElementCount) {
      $(id).innerHTML = '<div class="quest"></div>'.repeat(5);
    }
  }

  for (const [team, el] of [["ORDER", $("drakes-blue")], ["CHAOS", $("drakes-red")]]) {
    el.innerHTML = stats[team].drakes
      .map((t) => `<div class="drake" title="${t}" style="background:${DRAKE_COLORS[t] || "#888"}"></div>`)
      .join("");
  }

  // Objective-Panel oben rechts: aktive Buffs (mit Team-Farbe) + Spawns.
  const chips = [];
  for (const [team, side] of [["ORDER", "blue"], ["CHAOS", "red"]]) {
    for (const b of stats[team].buffs) {
      chips.push(`<div class="chip ${b.cls} ${side}">${b.label} ${fmtClock(b.left)}</div>`);
    }
  }
  for (const c of spawnTimers(stats, events, now)) {
    chips.push(`<div class="chip ${c.cls}">${c.label} ${fmtClock(c.left)}</div>`);
  }
  $("objpanel").innerHTML = chips.join("");

  $("squad-blue").innerHTML = players.filter((p) => p.team === "ORDER")
    .map(playerTile).join("");
  $("squad-red").innerHTML = players.filter((p) => p.team === "CHAOS")
    .map(playerTile).join("");
}

function setConnected(on) {
  connected = on;
  const ownTiles = settings.playerLayout === "bottom";
  $("status").classList.toggle("hidden", on);
  $("bottomstrip").classList.toggle("hidden", !on || !ownTiles);
  $("scorebar").classList.toggle("hidden", !on || !settings.showScorebar);
  $("objpanel").classList.toggle("hidden", !on || !settings.showObjectives);
}

// Einstellungen aufs HUD anwenden: Layout, Sichtbarkeiten, Größe.
function applySettings() {
  document.body.classList.toggle("layout-bottom", settings.playerLayout === "bottom");
  document.body.classList.toggle("no-gold", !settings.showGold);
  applyScale();
  if (connected) setConnected(true);
  takeoverDone = false; // Spiel-Optik (Fog of War etc.) neu setzen
}

// --------------------------------------------------------------- Poll-Loop

async function poll() {
  try {
    const data = MOCK ? mockData() : await fetchJson(`${API}/liveclientdata/allgamedata`);
    if (!data.allPlayers || data.allPlayers.length === 0) throw new Error("noch keine Spieler");
    await takeover();
    if (!connected) setConnected(true);
    lastData = data;
    render(data);
  } catch {
    takeoverDone = false;
    if (connected || !document.body.classList.contains("booted")) setConnected(false);
  }
  document.body.classList.add("booted");
}

// ------------------------------------------------------------------- Mock

let mockStart = null;
function mockData() {
  if (mockStart === null) mockStart = Date.now();
  const t = 1247 + (Date.now() - mockStart) / 1000;
  const P = (team, name, champ, key, level, k, d, a, cs, dead) => ({
    team, summonerName: name, riotIdGameName: name,
    championName: champ, rawChampionName: `game_character_displayname_${key}`,
    level, isDead: !!dead, respawnTimer: dead ? dead : 0,
    scores: { kills: k, deaths: d, assists: a, creepScore: cs },
    items: [0, 1, 2, 3, 6].map((slot) => ({ slot, itemID: 1001 })),
  });
  return {
    gameData: { gameTime: t },
    allPlayers: [
      P("ORDER", "Zeus", "Aatrox", "Aatrox", 14, 2, 1, 5, 187),
      P("ORDER", "Oner", "Lee Sin", "LeeSin", 12, 3, 2, 8, 142),
      P("ORDER", "Faker", "Azir", "Azir", 14, 4, 0, 6, 201, 0),
      P("ORDER", "Gumayusi", "Jinx", "Jinx", 13, 6, 1, 4, 218),
      P("ORDER", "Keria", "Thresh", "Thresh", 11, 0, 2, 13, 38),
      P("CHAOS", "Bin", "Jax", "Jax", 13, 2, 3, 2, 178),
      P("CHAOS", "Xun", "Viego", "Viego", 12, 3, 3, 4, 155, 18),
      P("CHAOS", "knight", "Ahri", "Ahri", 13, 2, 2, 5, 189),
      P("CHAOS", "Elk", "Kai'Sa", "Kaisa", 12, 1, 4, 6, 203),
      P("CHAOS", "ON", "Rakan", "Rakan", 10, 0, 3, 8, 29),
    ],
    events: { Events: [
      { EventName: "TurretKilled", TurretKilled: "Turret_T2_L_03_A", KillerName: "Zeus", EventTime: 840 },
      { EventName: "TurretKilled", TurretKilled: "Turret_T2_C_05_A", KillerName: "Gumayusi", EventTime: 1100 },
      { EventName: "TurretKilled", TurretKilled: "Turret_T1_R_03_A", KillerName: "Bin#LPL", EventTime: 990 },
      { EventName: "DragonKill", DragonType: "Ocean", KillerName: "Xun#LPL", EventTime: 620 },
      { EventName: "DragonKill", DragonType: "Hextech", KillerName: "Xun#LPL", EventTime: 940 },
      { EventName: "DragonKill", DragonType: "Fire", KillerName: "Oner", EventTime: 780 },
      { EventName: "BaronKill", KillerName: "Oner", EventTime: t - 65 },
    ] },
  };
}

// -------------------------------------------------------------------- Start

// HUD mit der Fenstergröße mitskalieren (Design-Referenz: 1920 px Breite),
// zusätzlich die Feinjustierung aus den Einstellungen.
function applyScale() {
  const auto = Math.max(0.55, Math.min(1.6, window.innerWidth / 1920));
  document.body.style.zoom = String(auto * (settings.hudScale || 100) / 100);
}
window.addEventListener("resize", applyScale);

if (ipc) {
  ipc.on("settings-changed", () => {
    settings = config.load();
    applySettings();
    if (connected && lastData) render(lastData);
  });
}

if (MOCK) document.body.classList.add("mock");
applySettings();
loadDdragonVersion();
poll();
setInterval(poll, POLL_MS);
