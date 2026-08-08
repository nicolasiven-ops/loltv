// LoLTV Studio — Spielersuche, Match-Liste, Replay-Start, Playback-Leiste.
//
// Datenwege:
//   * LCU-API (lcu.js, League-Client im Hintergrund): Spieler nachschlagen,
//     Match-Historie, Replay-Download und -Start. Kein Riot-API-Key nötig.
//   * Replay-API (Port 2999): Playback-Steuerung des laufenden Replays.
//   * Data Dragon (CDN): Champion-Namen und -Icons.
//
// Der Einbettungs-Status kommt per IPC aus dem Main-Prozess (embed-status);
// zurück melden wir, ob die Replay-API antwortet (replay-api), damit der
// Main-Prozess nur echte Replay-Fenster andockt — nie ein Live-Game.

const API = "https://127.0.0.1:2999";
const POLL_MS = 500;
const LCU_RETRY_MS = 2500;

// In Electron vorhanden; beim Öffnen im normalen Browser (Design-Vorschau)
// fehlt require — dann laufen nur die UI-Teile ohne IPC/LCU.
const HAS_NODE = typeof require === "function";
const ipc = HAS_NODE ? require("electron").ipcRenderer : null;
const lcu = HAS_NODE ? require("./lcu") : null;
const gamecfg = HAS_NODE ? require("./gamecfg") : null;

const $ = (id) => document.getElementById(id);

const QUEUES = {
  400: "Normal (Draft)", 420: "Ranked Solo/Duo", 430: "Normal (Blind)",
  440: "Ranked Flex", 450: "ARAM", 490: "Quickplay", 700: "Clash",
  900: "URF", 1700: "Arena", 1900: "URF",
};

let apiConnected = false;
let gameEmbedded = false;
let seeking = false;
let gameflowPhase = "None"; // Phase des League-Clients (ChampSelect, InProgress …)
let currentPatch = null;   // z. B. "15.16" (vom Client)
let ddVersion = null;      // Data-Dragon-Version für Icons
let champById = {};        // championId -> { key, name }
let playBusy = false;

function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------ Statuszeile

function setStatus() {
  const el = $("embed-status");
  if (gameEmbedded) el.textContent = "Replay eingebettet ✔";
  else if (apiConnected) el.textContent = "Replay läuft — Fenster wird angedockt …";
  else if (lcu && lcu.connected()) el.textContent = "Bereit — Spieler suchen oder Replay starten";
  else el.textContent = "Warte auf League-Client …";
  $("searchview").style.display = gameEmbedded ? "none" : "";
}

// --------------------------------------------------------------- Replay-API

async function post(path, body) {
  try {
    await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch { /* Poll meldet den Verbindungsverlust */ }
}

async function pollPlayback() {
  try {
    const resp = await fetch(`${API}/replay/playback`);
    if (!resp.ok) throw new Error(String(resp.status));
    const pb = await resp.json();
    apiConnected = true;
    $("bottombar").classList.remove("disabled");

    $("time-len").textContent = fmtClock(pb.length || 0);
    if (!seeking) {
      $("seek").max = Math.ceil(pb.length || 1);
      $("seek").value = Math.floor(pb.time || 0);
      $("time-now").textContent = fmtClock(pb.time || 0);
    }
    $("btn-play").textContent = pb.paused ? "▶" : "⏸";
    for (const btn of document.querySelectorAll("#speeds button")) {
      btn.classList.toggle("active", Number(btn.dataset.speed) === pb.speed);
    }
  } catch {
    apiConnected = false;
    $("bottombar").classList.add("disabled");
  }
  if (ipc) ipc.send("replay-api", apiConnected);
  setStatus();
}

// ------------------------------------------------------------- Data Dragon

async function loadDdragon() {
  try {
    const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
    ddVersion = versions[0];
    const data = await (await fetch(
      `https://ddragon.leagueoflegends.com/cdn/${ddVersion}/data/de_DE/champion.json`)).json();
    for (const champ of Object.values(data.data)) {
      champById[champ.key] = { key: champ.id, name: champ.name };
    }
  } catch { /* Icons entfallen dann, Liste funktioniert trotzdem */ }
}

// ------------------------------------------------------------------- LCU

async function lcuTick() {
  if (!lcu) return;
  const was = lcu.connected();
  const ok = await lcu.connect();
  $("lcu-status").textContent = ok
    ? "League-Client: verbunden ✔ (darf minimiert bleiben)"
    : "League-Client: nicht gefunden — bitte starten und einloggen";
  if (ok && !was) {
    lcu.request("GET", "/lol-patch/v1/game-version")
      .then((v) => { currentPatch = String(v).split(".").slice(0, 2).join("."); })
      .catch(() => { currentPatch = null; });
    // Absturz-Schutz: Liegt von einem früheren Lauf noch ein game.cfg-Backup
    // herum und läuft gerade kein Replay, Original wiederherstellen.
    if (!apiConnected && gamecfg && lcu.installDir()) {
      try { gamecfg.restoreIfNeeded(lcu.installDir()); } catch { /* beim nächsten Start */ }
    }
  }
  // Gameflow-Phase überwachen: Steht ein eigenes Spiel an, meldet der
  // Main-Prozess sich per "replay-autoclosed", nachdem er das Replay
  // geschlossen hat.
  if (ok) {
    try {
      gameflowPhase = (await lcu.request("GET", "/lol-gameflow/v1/gameflow-phase")) || "None";
    } catch { gameflowPhase = "None"; }
    if (ipc) ipc.send("gameflow-phase", gameflowPhase);
  }
  setStatus();
}

// ------------------------------------------------------------ Spielersuche

function searchStatus(msg, isError) {
  $("search-status").textContent = msg || "";
  $("search-status").classList.toggle("error", Boolean(isError));
}

async function searchPlayer() {
  const raw = $("riot-id").value.trim();
  const m = /^(.+?)\s*#\s*(\S+)$/.exec(raw);
  if (!m) return searchStatus("Bitte vollständige Riot-ID eingeben: Name#TAG", true);
  if (!lcu || !lcu.connected()) return searchStatus("League-Client läuft nicht.", true);

  $("btn-search").disabled = true;
  $("results").innerHTML = "";
  searchStatus("Suche Spieler …");
  try {
    const account = await lcu.request("GET",
      `/lol-summoner/v1/alias/lookup?gameName=${encodeURIComponent(m[1])}&tagLine=${encodeURIComponent(m[2])}`);
    if (!account || !account.puuid) throw new Error("not found");

    searchStatus("Lade Match-Historie …");
    const hist = await lcu.request("GET",
      `/lol-match-history/v1/products/lol/${account.puuid}/matches?begIndex=0&endIndex=20`);
    const games = (hist && hist.games && hist.games.games) || [];
    if (games.length === 0) {
      searchStatus("Keine Spiele gefunden.", true);
    } else {
      games.sort((a, b) => (b.gameCreation || 0) - (a.gameCreation || 0));
      $("results").innerHTML = games.map(matchRow).join("");
      bindPlayButtons();
      searchStatus(`${games.length} Spiele — nur Spiele vom aktuellen Patch${currentPatch ? ` (${currentPatch})` : ""} sind abspielbar.`);
    }
  } catch (err) {
    searchStatus(err.status === 404
      ? "Spieler nicht gefunden — Schreibweise/Tag prüfen (Spieler muss auf deiner Region sein)."
      : `Suche fehlgeschlagen (${err.message}).`, true);
  }
  $("btn-search").disabled = false;
}

function matchRow(g) {
  const p = (g.participants && g.participants[0]) || {};
  const s = p.stats || {};
  const champ = champById[String(p.championId)] || null;
  const icon = champ && ddVersion
    ? `<img src="https://ddragon.leagueoflegends.com/cdn/${ddVersion}/img/champion/${champ.key}.png" onerror="this.remove()" alt="">`
    : "?";
  const gamePatch = String(g.gameVersion || "").split(".").slice(0, 2).join(".");
  const playable = !currentPatch || !gamePatch || gamePatch === currentPatch;
  const when = g.gameCreation
    ? new Date(g.gameCreation).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
  const dur = g.gameDuration ? `${Math.round(g.gameDuration / 60)} min` : "";
  const cs = (s.totalMinionsKilled || 0) + (s.neutralMinionsKilled || 0);

  return `<div class="match ${s.win ? "win" : "loss"} ${playable ? "" : "dud"}">
    <div class="m-champ">${icon}</div>
    <div class="m-main">
      <div class="m-line1">
        ${champ ? champ.name : "Champion " + (p.championId || "?")}
        <span class="${s.win ? "win" : "lose"}">· ${s.win ? "Sieg" : "Niederlage"}</span>
      </div>
      <div class="m-line2">${QUEUES[g.queueId] || "Queue " + g.queueId} · ${when} · ${dur}</div>
    </div>
    <div class="m-kda">${s.kills || 0}/<span class="d">${s.deaths || 0}</span>/${s.assists || 0} · ${cs} CS</div>
    <div class="m-patch">${gamePatch}</div>
    <button class="m-play" data-game="${g.gameId}" data-platform="${g.platformId || ""}"
      ${playable ? "" : "disabled title='Anderer Patch — nicht mehr abspielbar'"}>
      ${playable ? "▶ Ansehen" : "Patch " + gamePatch}
    </button>
  </div>`;
}

function bindPlayButtons() {
  for (const btn of document.querySelectorAll(".m-play[data-game]")) {
    btn.addEventListener("click", () => playReplay(btn, btn.dataset.game, btn.dataset.platform));
  }
}

// ------------------------------------------------- Replay laden & starten

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Warten, bis das Replay wirklich läuft (Replay-API antwortet / angedockt).
async function waitForReplay(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (apiConnected || gameEmbedded) return true;
    await sleep(1000);
  }
  return apiConnected || gameEmbedded;
}

// Fallback: die heruntergeladene .rofl direkt mit der Spiel-Exe starten,
// falls der Start über die LCU-API hängen bleibt.
async function directLaunch(gameId, platformId) {
  const fs = require("fs");
  const path = require("path");
  const { spawn } = require("child_process");

  const replayDir = await lcu.request("GET", "/lol-replays/v1/rofls/path");
  let rofl = path.join(replayDir, `${platformId}-${gameId}.rofl`);
  if (!fs.existsSync(rofl)) {
    const hit = fs.readdirSync(replayDir)
      .find((f) => f.includes(String(gameId)) && f.endsWith(".rofl"));
    if (!hit) throw new Error("Replay-Datei nicht im Replay-Ordner gefunden");
    rofl = path.join(replayDir, hit);
  }
  const install = lcu.installDir();
  if (!install) throw new Error("League-Installationsordner unbekannt");
  const gameDir = path.join(install, "Game");
  const exe = path.join(gameDir, "League of Legends.exe");
  if (!fs.existsSync(exe)) throw new Error(`Spiel-Exe nicht gefunden (${exe})`);
  const child = spawn(exe, [rofl], { cwd: gameDir, detached: true, stdio: "ignore" });
  child.unref();
}

async function playReplay(btn, gameId, platformId) {
  if (playBusy) return;
  if (["ChampSelect", "GameStart", "InProgress", "Reconnect"].includes(gameflowPhase)) {
    return searchStatus("Du bist gerade in einem Spiel — erst fertig spielen 😉", true);
  }
  playBusy = true;
  const oldLabel = btn.textContent;
  const body = { componentType: "replay-button_match-details" };
  try {
    btn.disabled = true;
    btn.textContent = "lädt …";
    searchStatus("Replay wird heruntergeladen …");
    await lcu.request("POST", `/lol-replays/v1/rofls/${gameId}/download`, body).catch(() => {});

    // Auf den Download warten.
    const deadline = Date.now() + 120000;
    let ready = false;
    while (Date.now() < deadline) {
      const md = await lcu.request("GET", `/lol-replays/v1/metadata/${gameId}`).catch(() => null);
      const state = md && md.state;
      if (state === "watch") { ready = true; break; }
      if (state === "incompatible" || state === "unsupported") {
        throw new Error("Replay ist mit dem aktuellen Patch nicht kompatibel");
      }
      if (state === "missing" || state === "missingOnServer") {
        throw new Error("Riot hat für dieses Spiel kein Replay (mehr) auf dem Server");
      }
      if (state === "downloading" && md.downloadProgress != null) {
        searchStatus(`Replay wird heruntergeladen … ${md.downloadProgress} %`);
      }
      await sleep(1000);
    }
    if (!ready) throw new Error("Zeitüberschreitung beim Download");

    // Spielauflösung exakt auf die Bühne setzen (mit Backup), damit das
    // Replay 1:1 hineinpasst und Mausklicks pixelgenau sitzen.
    try {
      const size = ipc ? await ipc.invoke("stage-size") : null;
      if (size && gamecfg && lcu.installDir()) {
        gamecfg.applyStageResolution(lcu.installDir(), size.width, size.height);
      }
    } catch { /* zur Not startet das Replay mit der alten Auflösung */ }

    // Start über den Client; wenn danach nichts passiert, direkt starten.
    searchStatus("Replay-Client startet …");
    await lcu.request("POST", `/lol-replays/v1/rofls/${gameId}/watch`, body).catch(() => {});
    if (!(await waitForReplay(20000))) {
      searchStatus("Start über den Client hakt — starte die .rofl direkt …");
      await directLaunch(gameId, platformId);
      if (!(await waitForReplay(40000))) {
        throw new Error("Replay-Client startet nicht (läuft evtl. schon ein Spiel oder ein anderes Replay?)");
      }
    }
    searchStatus("");
    btn.textContent = "✔ läuft";
  } catch (err) {
    searchStatus(`Abspielen fehlgeschlagen: ${err.message}`, true);
    btn.textContent = oldLabel;
    btn.disabled = false;
    // Replay läuft nicht — Original-Config direkt zurück.
    try { if (gamecfg && lcu.installDir()) gamecfg.restoreIfNeeded(lcu.installDir()); } catch {}
  }
  playBusy = false;
}

// ------------------------------------------------------------------- UI

$("btn-play").addEventListener("click", () => {
  post("/replay/playback", { paused: $("btn-play").textContent === "⏸" });
});

$("seek").addEventListener("pointerdown", () => { seeking = true; });
$("seek").addEventListener("input", () => {
  $("time-now").textContent = fmtClock(Number($("seek").value));
});
$("seek").addEventListener("change", () => {
  seeking = false;
  post("/replay/playback", { time: Number($("seek").value) });
});

for (const btn of document.querySelectorAll("#speeds button")) {
  btn.addEventListener("click", () => post("/replay/playback", { speed: Number(btn.dataset.speed) }));
}

$("btn-search").addEventListener("click", searchPlayer);
$("riot-id").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") searchPlayer();
});

if (ipc) {
  ipc.on("embed-status", (_ev, { embedded }) => {
    const was = gameEmbedded;
    gameEmbedded = embedded;
    setStatus();
    // Replay beendet → Original-game.cfg zurückschreiben. Kurz warten,
    // weil der Replay-Client beim Beenden selbst noch in die Datei schreibt.
    if (was && !embedded && gamecfg && lcu && lcu.installDir()) {
      setTimeout(() => {
        try { gamecfg.restoreIfNeeded(lcu.installDir()); } catch { /* s. Startup-Restore */ }
      }, 3000);
    }
  });
  ipc.on("replay-autoclosed", () => {
    searchStatus("Replay beendet — dein eigenes Spiel startet. Danach einfach wieder ▶ klicken. Viel Erfolg! 🍀");
  });
  for (const [id, action] of [["btn-min", "minimize"], ["btn-max", "maximize"], ["btn-close", "close"]]) {
    $(id).addEventListener("click", () => ipc.send("win-control", action));
  }
}

setStatus();
loadDdragon();
pollPlayback();
setInterval(pollPlayback, POLL_MS);
lcuTick();
setInterval(lcuTick, LCU_RETRY_MS);
