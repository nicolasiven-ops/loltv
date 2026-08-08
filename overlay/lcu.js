// LCU-Anbindung (League-Client-API) für den Studio-Renderer.
//
// Der laufende League-Client bietet eine lokale REST-API auf 127.0.0.1 an,
// gesichert per selbstsigniertem Zertifikat und HTTP-Basic-Auth. Port und
// Token stehen in der Kommandozeile des LeagueClientUx-Prozesses
// (--app-port / --remoting-auth-token) bzw. im `lockfile` im
// Installationsordner. (Gleiches Vorgehen wie lcu.py in pc-tools.)
//
// Über diese API läuft die ganze LoLTV-Logik: Spieler nachschlagen,
// Match-Historie laden, Replays herunterladen und starten.

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

let creds = null; // { port, token }
let leagueDir = null; // League-Installationsordner (für Direktstart der Spiel-Exe)

function fromProcess() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine"],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const port = /--app-port=(\d+)/.exec(stdout);
        const token = /--remoting-auth-token=([\w-]+)/.exec(stdout);
        const exe = /"?([A-Za-z]:\\[^"]*?)\\LeagueClientUx\.exe/.exec(stdout);
        if (exe) leagueDir = exe[1];
        resolve(port && token ? { port: port[1], token: token[1] } : null);
      }
    );
  });
}

function fromLockfile() {
  const candidates = [
    "C:\\Riot Games\\League of Legends\\lockfile",
    path.join(process.env.LOCALAPPDATA || "", "Riot Games", "League of Legends", "lockfile"),
  ];
  for (const file of candidates) {
    try {
      const parts = fs.readFileSync(file, "utf8").trim().split(":");
      if (parts.length >= 5) {
        leagueDir = path.dirname(file);
        return { port: parts[2], token: parts[3] };
      }
    } catch { /* nächster Kandidat */ }
  }
  return null;
}

async function rawRequest(c, method, apiPath, body) {
  const resp = await fetch(`https://127.0.0.1:${c.port}${apiPath}`, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(`riot:${c.token}`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    const err = new Error(`LCU ${resp.status} ${apiPath}`);
    err.status = resp.status;
    throw err;
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

// Verbindung aufbauen bzw. gecachte Credentials validieren.
async function connect() {
  if (creds) {
    try {
      await rawRequest(creds, "GET", "/lol-gameflow/v1/gameflow-phase");
      return true;
    } catch { creds = null; }
  }
  const found = (await fromProcess()) || fromLockfile();
  if (!found) return false;
  try {
    await rawRequest(found, "GET", "/lol-gameflow/v1/gameflow-phase");
    creds = found;
    return true;
  } catch {
    return false;
  }
}

function connected() {
  return creds !== null;
}

async function request(method, apiPath, body) {
  if (!creds) throw new Error("LCU nicht verbunden");
  try {
    return await rawRequest(creds, method, apiPath, body);
  } catch (err) {
    // Bei Verbindungsverlust (Client neu gestartet) Credentials verwerfen.
    if (!err.status) creds = null;
    throw err;
  }
}

function installDir() {
  return leagueDir;
}

module.exports = { connect, connected, request, installDir };
