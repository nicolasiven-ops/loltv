// LoLTV Studio — Fenstersteuerung + Playback-Leiste.
//
// Pollt /replay/playback und steuert Pause/Spulen/Tempo über die Replay-API.
// Der Einbettungs-Status kommt per IPC aus dem Main-Prozess (embed-status).

const API = "https://127.0.0.1:2999";
const POLL_MS = 500;

// In Electron vorhanden; beim Öffnen im normalen Browser (Design-Vorschau)
// fehlt require — dann laufen nur die UI-Teile ohne IPC.
const ipc = typeof require === "function" ? require("electron").ipcRenderer : null;

const $ = (id) => document.getElementById(id);

let apiConnected = false;
let gameEmbedded = false;
let seeking = false;

function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function setStatus() {
  const el = $("embed-status");
  if (gameEmbedded) el.textContent = "Replay eingebettet ✔";
  else if (apiConnected) el.textContent = "Replay läuft — Fenster wird eingebettet …";
  else el.textContent = "Warte auf Replay-Client …";
  $("stage-hint").style.display = gameEmbedded ? "none" : "";
}

// ------------------------------------------------------------- Replay-API

async function post(path, body) {
  try {
    await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch { /* Poll meldet den Verbindungsverlust */ }
}

async function poll() {
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
  setStatus();
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

if (ipc) {
  ipc.on("embed-status", (_ev, { embedded }) => {
    gameEmbedded = embedded;
    setStatus();
  });
  for (const [id, action] of [["btn-min", "minimize"], ["btn-max", "maximize"], ["btn-close", "close"]]) {
    $(id).addEventListener("click", () => ipc.send("win-control", action));
  }
}

setStatus();
poll();
setInterval(poll, POLL_MS);
