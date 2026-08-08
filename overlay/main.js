// LoLTV — Electron-Host.
//
// Standardmodus „Studio“: eigenes Fenster mit Titelleiste und Playback-Leiste;
// das laufende Replay-Spielfenster wird per Win32 SetParent in die Bühne
// eingebettet (embed.js), und das Broadcast-HUD (overlay.html) liegt als
// transparentes, klickdurchlässiges Kind-Fenster über der Bühne.
//
// Legacy-Modus: `npm run fullscreen` legt das HUD wie früher als
// Vollbild-Overlay über den ganzen Bildschirm (ohne Einbettung).
//
// Hotkeys (global):
//   Strg+F12      HUD ein-/ausblenden
//   Strg+Alt+F12  beenden

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require("electron");
const embed = require("./embed");

// Replay-/Live-Client-API antwortet mit selbstsigniertem Zertifikat.
app.commandLine.appendSwitch("ignore-certificate-errors");

// Muss zu den Höhen in studio.html passen (CSS-Pixel).
const TOPBAR = 44;
const BOTTOMBAR = 56;
const EMBED_POLL_MS = 2000;

const FULLSCREEN_MODE = process.argv.includes("--fullscreen-overlay");

let studio = null;
let hud = null;
let gameHwnd = 0n;

// ---------------------------------------------------------------- Studio

function stageRect() {
  const [w, h] = studio.getContentSize();
  return { x: 0, y: TOPBAR, width: w, height: Math.max(0, h - TOPBAR - BOTTOMBAR) };
}

// Bühne, HUD-Fenster und eingebettetes Spielfenster deckungsgleich halten.
function layout() {
  if (!studio || studio.isDestroyed() || studio.isMinimized()) return;
  const cb = studio.getContentBounds();
  const stage = stageRect();
  if (hud && !hud.isDestroyed()) {
    hud.setBounds({
      x: cb.x + stage.x, y: cb.y + stage.y,
      width: stage.width, height: stage.height,
    });
  }
  if (gameHwnd && embed.isAlive(gameHwnd)) {
    const scale = screen.getDisplayMatching(studio.getBounds()).scaleFactor;
    embed.moveTo(
      gameHwnd,
      Math.round(stage.x * scale), Math.round(stage.y * scale),
      Math.round(stage.width * scale), Math.round(stage.height * scale)
    );
  }
}

function sendStatus() {
  if (studio && !studio.isDestroyed()) {
    studio.webContents.send("embed-status", { embedded: gameHwnd !== 0n });
  }
}

// Spielfenster suchen und einbetten; Verlust (Replay beendet) erkennen.
function embedTick() {
  if (!embed.available() || !studio || studio.isDestroyed()) return;
  if (gameHwnd && !embed.isAlive(gameHwnd)) {
    gameHwnd = 0n;
    sendStatus();
  }
  if (!gameHwnd) {
    const found = embed.findGame();
    if (found) {
      const host = studio.getNativeWindowHandle().readBigUInt64LE(0);
      embed.embed(found, host);
      gameHwnd = found;
      layout();
      sendStatus();
    }
  }
}

function createStudio() {
  studio = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 650,
    frame: false,
    backgroundColor: "#0a0d13",
    webPreferences: {
      webSecurity: false, // lokale Riot-API ohne CORS-Header
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  studio.loadFile("studio.html");

  hud = new BrowserWindow({
    parent: studio,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { webSecurity: false, backgroundThrottling: false },
  });
  hud.setIgnoreMouseEvents(true);
  hud.loadFile("overlay.html");

  for (const ev of ["resize", "move", "maximize", "unmaximize", "restore"]) {
    studio.on(ev, layout);
  }
  studio.on("minimize", () => hud.hide());
  studio.on("restore", () => hud.showInactive());
  studio.on("closed", () => app.quit());
  hud.once("ready-to-show", layout);

  setInterval(embedTick, EMBED_POLL_MS);
  embedTick();
}

// ---------------------------------------------- Legacy: Vollbild-Overlay

function createFullscreenOverlay() {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  hud = new BrowserWindow({
    x: 0, y: 0, width, height,
    transparent: true, frame: false, resizable: false, movable: false,
    hasShadow: false, skipTaskbar: true, fullscreenable: false,
    webPreferences: { webSecurity: false, backgroundThrottling: false },
  });
  hud.setAlwaysOnTop(true, "screen-saver");
  hud.setIgnoreMouseEvents(true);
  hud.loadFile("overlay.html");
}

// ------------------------------------------------------------------ App

ipcMain.on("win-control", (_ev, action) => {
  if (!studio) return;
  if (action === "close") studio.close();
  else if (action === "minimize") studio.minimize();
  else if (action === "maximize") {
    if (studio.isMaximized()) studio.unmaximize();
    else studio.maximize();
  }
});

app.whenReady().then(() => {
  if (FULLSCREEN_MODE) createFullscreenOverlay();
  else createStudio();

  globalShortcut.register("Control+F12", () => {
    if (!hud || hud.isDestroyed()) return;
    if (hud.isVisible()) hud.hide();
    else hud.showInactive();
  });
  globalShortcut.register("Control+Alt+F12", () => app.quit());
});

app.on("before-quit", () => embed.detach());
app.on("will-quit", () => globalShortcut.unregisterAll());
