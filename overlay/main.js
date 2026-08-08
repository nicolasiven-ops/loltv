// LoLTV — Electron-Host.
//
// Standardmodus „Studio“: eigenes Fenster mit Titelleiste und Playback-Leiste;
// das laufende Replay-Spielfenster wird per Win32-Docking (embed.js) rahmenlos
// und deckungsgleich über die Bühne gelegt — es bleibt ein eigenständiges
// Fenster mit nativer Eingabe-Pipeline (Tastatur, ESC-Menü, Kamera). Das
// Broadcast-HUD (overlay.html) schwebt als transparentes, klickdurchlässiges
// Fenster darüber.
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
// Wird vom Studio-Renderer gemeldet (IPC "replay-api"): antwortet die
// Replay-API auf Port 2999? Nur dann ist das Spielfenster ein Replay —
// ein Live-Game (gleicher Fenstertitel!) darf nie angedockt werden.
let replayApiUp = false;

// ---------------------------------------------------------------- Studio

function stageRect() {
  const [w, h] = studio.getContentSize();
  return { x: 0, y: TOPBAR, width: w, height: Math.max(0, h - TOPBAR - BOTTOMBAR) };
}

// Bühne, HUD-Fenster und angedocktes Spielfenster deckungsgleich halten.
function layout() {
  if (!studio || studio.isDestroyed() || studio.isMinimized()) return;
  const cb = studio.getContentBounds();
  const stage = stageRect();
  const stageScreenDip = {
    x: cb.x + stage.x, y: cb.y + stage.y,
    width: stage.width, height: stage.height,
  };
  if (hud && !hud.isDestroyed()) {
    hud.setBounds(stageScreenDip);
  }
  if (gameHwnd && embed.isAlive(gameHwnd)) {
    // DIP → physische Bildschirm-Pixel (DPI-Skalierung berücksichtigen).
    const phys = screen.dipToScreenRect(studio, stageScreenDip);
    embed.moveToScreen(gameHwnd, phys.x, phys.y, phys.width, phys.height);
  }
}

function sendStatus() {
  if (studio && !studio.isDestroyed()) {
    studio.webContents.send("embed-status", { embedded: gameHwnd !== 0n });
  }
}

// Spielfenster suchen und andocken; Verlust (Replay beendet) erkennen.
function embedTick() {
  if (!embed.available() || !studio || studio.isDestroyed()) return;
  if (gameHwnd && !embed.isAlive(gameHwnd)) {
    gameHwnd = 0n;
    sendStatus();
  }
  if (!gameHwnd && replayApiUp) {
    const found = embed.findGame();
    if (found) {
      const host = studio.getNativeWindowHandle().readBigUInt64LE(0);
      embed.attach(found, host);
      gameHwnd = found;
      layout();
      sendStatus();
    }
  }
}

// Das HUD ist global „always on top“, damit es über dem angedockten
// Spielfenster liegt. Damit es nicht über fremden Apps schwebt, wird es
// ausgeblendet, sobald weder Studio noch Spiel im Vordergrund sind.
function hudVisibilityTick() {
  if (!studio || studio.isDestroyed() || !hud || hud.isDestroyed()) return;
  const fg = embed.foreground();
  const ours = studio.isFocused() || (gameHwnd !== 0n && fg === gameHwnd);
  const shouldShow = ours && !studio.isMinimized();
  if (shouldShow && !hud.isVisible()) hud.showInactive();
  else if (!shouldShow && hud.isVisible()) hud.hide();
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
  hud.setAlwaysOnTop(true, "screen-saver");
  hud.loadFile("overlay.html");

  for (const ev of ["resize", "move", "maximize", "unmaximize", "restore"]) {
    studio.on(ev, layout);
  }
  studio.on("minimize", () => hud.hide());
  studio.on("restore", () => {
    layout();
    hud.showInactive();
  });
  studio.on("closed", () => app.quit());
  hud.once("ready-to-show", layout);

  setInterval(embedTick, EMBED_POLL_MS);
  setInterval(hudVisibilityTick, 400);
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

ipcMain.on("replay-api", (_ev, up) => {
  replayApiUp = Boolean(up);
});

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
