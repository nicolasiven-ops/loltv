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

// Beim Takeover gesetzte Render-Eigenschaften: eigenes HUD statt Spiel-HUD.
const TAKEOVER = {
  fogOfWar: false,
  interfaceScoreboard: false,
  interfaceFrames: false,
  interfaceScore: false,
  interfaceTimeline: false,
  interfaceReplay: false,
  interfaceMinimap: true,
  interfaceAnnounce: true,
  interfaceKillCallouts: true,
  interfaceNeutralTimers: true,
  cameraAttached: false,
};

const DRAKE_COLORS = {
  Fire: "#e06c4b", Ocean: "#4bb7e0", Mountain: "#b08d57", Air: "#a9c1c9",
  Hextech: "#5cd6d0", Chemtech: "#8fd65c", Elder: "#b48ce0", Earth: "#b08d57",
  Cloud: "#a9c1c9", Infernal: "#e06c4b",
};

let ddragonVersion = null; // Data-Dragon-Version für Champion-/Item-Bilder
let takeoverDone = false;
let connected = false;

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
      body: JSON.stringify(TAKEOVER),
    });
    takeoverDone = true;
  } catch {
    /* nächster Poll versucht es erneut */
  }
}

// ------------------------------------------------------- Team-Statistiken

// Turm-Namen tragen den Besitzer: _T1_ = blau (ORDER), _T2_ = rot (CHAOS).
// Ein zerstörter T1-Turm zählt also für Rot — und umgekehrt.
function teamStats(players, events) {
  const stats = {
    ORDER: { kills: 0, towers: 0, barons: 0, drakes: [] },
    CHAOS: { kills: 0, towers: 0, barons: 0, drakes: [] },
  };
  const teamOf = {};
  for (const p of players) {
    teamOf[p.summonerName] = p.team;
    if (p.riotIdGameName) teamOf[p.riotIdGameName] = p.team;
    stats[p.team].kills += p.scores.kills;
  }
  for (const ev of events) {
    if (ev.EventName === "TurretKilled") {
      if (ev.TurretKilled.includes("_T1_")) stats.CHAOS.towers += 1;
      else if (ev.TurretKilled.includes("_T2_")) stats.ORDER.towers += 1;
    } else if (ev.EventName === "DragonKill") {
      const team = teamOf[ev.KillerName];
      if (team) stats[team].drakes.push(ev.DragonType);
    } else if (ev.EventName === "BaronKill") {
      const team = teamOf[ev.KillerName];
      if (team) stats[team].barons += 1;
    }
  }
  return stats;
}

// ------------------------------------------------------------------ Render

function playerCard(p, side) {
  const key = champKey(p);
  const name = p.riotIdGameName || p.summonerName || "?";
  const s = p.scores;
  const portrait = ddragonVersion
    ? `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${key}.png"
         onerror="this.remove()" alt="">`
    : "";
  const respawn = p.isDead && p.respawnTimer > 0
    ? `<div class="respawn">${Math.ceil(p.respawnTimer)}</div>` : "";

  // 7 feste Item-Slots (6 Items + Trinket), in zwei Reihen.
  const slots = Array.from({ length: 7 }, (_, i) => {
    const item = (p.items || []).find((it) => it.slot === i);
    const img = item && ddragonVersion
      ? `<img src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${item.itemID}.png"
           onerror="this.remove()" alt="">`
      : "";
    return `<div class="item">${img}</div>`;
  });

  return `<div class="player ${p.isDead ? "dead" : ""}">
    <div class="portrait-wrap">
      <div class="portrait">${portrait || key.slice(0, 1)}</div>
      ${respawn}
      <div class="level">${p.level}</div>
    </div>
    <div class="pbody">
      <div class="pname">${name}</div>
      <div class="pchamp">${p.championName || key}</div>
      <div class="pstats">
        <span class="kda">${s.kills}/<span class="d">${s.deaths}</span>/${s.assists}</span>
        <span class="cs">${s.creepScore} CS</span>
      </div>
    </div>
    <div class="items">
      <div class="row">${slots.slice(0, 4).join("")}</div>
      <div class="row">${slots.slice(4).join("")}</div>
    </div>
  </div>`;
}

function render(data) {
  const players = data.allPlayers || [];
  const events = (data.events && data.events.Events) || [];
  const stats = teamStats(players, events);

  $("clock").textContent = fmtClock(data.gameData ? data.gameData.gameTime : 0);
  $("kills-blue").textContent = stats.ORDER.kills;
  $("kills-red").textContent = stats.CHAOS.kills;
  $("towers-blue").textContent = stats.ORDER.towers;
  $("towers-red").textContent = stats.CHAOS.towers;
  $("barons-blue").textContent = stats.ORDER.barons;
  $("barons-red").textContent = stats.CHAOS.barons;

  for (const [team, el] of [["ORDER", $("drakes-blue")], ["CHAOS", $("drakes-red")]]) {
    el.innerHTML = stats[team].drakes
      .map((t) => `<div class="drake" title="${t}" style="background:${DRAKE_COLORS[t] || "#888"}"></div>`)
      .join("");
  }

  $("team-blue").innerHTML = players.filter((p) => p.team === "ORDER")
    .map((p) => playerCard(p, "blue")).join("");
  $("team-red").innerHTML = players.filter((p) => p.team === "CHAOS")
    .map((p) => playerCard(p, "red")).join("");
}

function setConnected(on) {
  connected = on;
  $("status").classList.toggle("hidden", on);
  for (const id of ["scorebar", "team-blue", "team-red", "brand"]) {
    $(id).classList.toggle("hidden", !on);
  }
}

// --------------------------------------------------------------- Poll-Loop

async function poll() {
  try {
    const data = MOCK ? mockData() : await fetchJson(`${API}/liveclientdata/allgamedata`);
    if (!data.allPlayers || data.allPlayers.length === 0) throw new Error("noch keine Spieler");
    await takeover();
    if (!connected) setConnected(true);
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
      { EventName: "TurretKilled", TurretKilled: "Turret_T2_L_03_A", KillerName: "Zeus" },
      { EventName: "TurretKilled", TurretKilled: "Turret_T2_C_05_A", KillerName: "Gumayusi" },
      { EventName: "TurretKilled", TurretKilled: "Turret_T1_R_03_A", KillerName: "Bin" },
      { EventName: "DragonKill", DragonType: "Ocean", KillerName: "Xun" },
      { EventName: "DragonKill", DragonType: "Hextech", KillerName: "Xun" },
      { EventName: "DragonKill", DragonType: "Fire", KillerName: "Oner" },
    ] },
  };
}

// -------------------------------------------------------------------- Start

if (MOCK) document.body.classList.add("mock");
loadDdragonVersion();
poll();
setInterval(poll, POLL_MS);
