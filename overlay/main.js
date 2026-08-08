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
const { log, reset: resetLog } = require("./logger");

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
let fullscreenBlocked = false; // Replay läuft im Vollbild → nicht andockbar
// Wird vom Studio-Renderer gemeldet (IPC "replay-api"): antwortet die
// Replay-API auf Port 2999? Nur dann ist das Spielfenster ein Replay —
// ein Live-Game (gleicher Fenstertitel!) darf nie angedockt werden.
let replayApiUp = false;

// ---------------------------------------------------------------- Studio

function stageRect() {
  const [w, h] = studio.getContentSize();
  return { x: 0, y: TOPBAR, width: w, height: Math.max(0, h - TOPBAR - BOTTOMBAR) };
}

// Physische Bildschirm-Koordinaten der Bühne (für Cursor-Vergleiche).
function stageScreenPhys() {
  const cb = studio.getContentBounds();
  const stage = stageRect();
  return screen.dipToScreenRect(studio, {
    x: cb.x + stage.x, y: cb.y + stage.y,
    width: stage.width, height: stage.height,
  });
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
    // Kind-Fenster: Koordinaten relativ zur Studio-Client-Fläche, in
    // physischen Pixeln (DPI-Skalierung des Monitors berücksichtigen).
    const scale = screen.getDisplayMatching(studio.getBounds()).scaleFactor;
    const phys = stageScreenPhys();
    embed.moveTo(
      gameHwnd,
      Math.round(stage.x * scale), Math.round(stage.y * scale),
      phys.width, phys.height
    );
  }
}

function sendStatus() {
  if (studio && !studio.isDestroyed()) {
    studio.webContents.send("embed-status", {
      embedded: gameHwnd !== 0n,
      fullscreenBlocked,
    });
  }
}

// Deckt das Fenster einen kompletten Monitor ab? Dann läuft das Spiel im
// Vollbild/randlosen Vollbild — Andocken würde nur einen Glitch-Kampf mit
// dem Spiel auslösen (Vollbild-Reassert vs. SetWindowPos).
function coversADisplay(rect) {
  if (!rect) return false;
  for (const d of screen.getAllDisplays()) {
    const w = Math.round(d.bounds.width * d.scaleFactor);
    const h = Math.round(d.bounds.height * d.scaleFactor);
    if (rect.width >= w - 2 && rect.height >= h - 2) return true;
  }
  return false;
}

// Spielfenster suchen und andocken; Verlust (Replay beendet) erkennen.
function embedTick() {
  if (!embed.available() || !studio || studio.isDestroyed()) return;
  if (gameHwnd && !embed.isAlive(gameHwnd)) {
    gameHwnd = 0n;
    studio.setResizable(true);
    studio.setMaximizable(true);
    sendStatus();
  }
  if (!gameHwnd && replayApiUp) {
    const found = embed.findGame();
    if (found) {
      const rect = embed.windowRect(found);
      const iconic = embed.isIconic(found);
      log("embedTick: gefunden hwnd=", found, "rect=", JSON.stringify(rect),
        "style=0x" + embed.windowStyle(found), "iconic=", iconic);
      // Vollbild, minimiert (Vollbild-Spiele minimieren sich bei
      // Fokusverlust!) oder im Übergang (winziges Rect, z. B. 1×1 beim
      // Beenden) nie andocken — nur ein echtes, brauchbares Fenster.
      // Im Studio erscheint der Hinweis, im ESC-Menü auf „Fenster“ zu
      // stellen; sobald das passiert, dockt der nächste Tick.
      const tooSmall = !rect || rect.width < 500 || rect.height < 300;
      if (iconic || tooSmall || coversADisplay(rect)) {
        if (!fullscreenBlocked) {
          fullscreenBlocked = true;
          log("embedTick: blockiert (Vollbild/minimiert)");
          sendStatus();
        }
        return;
      }
      fullscreenBlocked = false;
      log("embedTick: docke an");
      const host = studio.getNativeWindowHandle().readBigUInt64LE(0);
      embed.attach(found, host);
      gameHwnd = found;
      // Größe einfrieren: Das Replay rendert exakt in Bühnen-Auflösung
      // (game.cfg); ein Resize würde das Bild skalieren und Mausklicks
      // wieder versetzen.
      studio.setResizable(false);
      studio.setMaximizable(false);
      layout();
      sendStatus();
    }
  } else if (fullscreenBlocked && !replayApiUp) {
    fullscreenBlocked = false;
    sendStatus();
  }
}

// Das HUD ist global „always on top“, damit es über dem angedockten
// Spielfenster liegt. Damit es nicht über fremden Apps schwebt, wird es
// ausgeblendet, sobald weder Studio noch Spiel im Vordergrund sind.
function hudVisibilityTick() {
  if (!studio || studio.isDestroyed() || !hud || hud.isDestroyed()) return;
  // Mit Fokus im eingebetteten Spiel meldet Electron das Studio als
  // unfokussiert — deshalb zählt auch das Vordergrund-Fenster (Studio-HWND).
  const fg = embed.foreground();
  const hostHwnd = studio.getNativeWindowHandle().readBigUInt64LE(0);
  const ours = studio.isFocused() || fg === hostHwnd || (gameHwnd !== 0n && fg === gameHwnd);
  // Erst zeigen, wenn ein Replay eingebettet ist — sonst schwebt der
  // HUD-Status-Chip über der Suchansicht.
  const shouldShow = ours && !studio.isMinimized() && gameHwnd !== 0n;
  if (shouldShow && !hud.isVisible()) hud.showInactive();
  else if (!shouldShow && hud.isVisible()) hud.hide();
}

// „Fokus folgt der Maus“: Steht der Cursor über der Bühne, bekommt das
// eingebettete Spiel echten Tastatur-Fokus (AttachThreadInput + SetFocus) —
// ein fremdes Kind-Fenster bekäme ihn sonst nie. Über den Leisten behält
// das Studio den Fokus. Nebenbei wird die Cursor-Sperre des Spiels gelöst.
function interactionTick() {
  if (!studio || studio.isDestroyed()) return;
  if (!gameHwnd || !embed.isAlive(gameHwnd) || studio.isMinimized()) return;
  embed.releaseCursorClip();
  const fg = embed.foreground();
  const hostHwnd = studio.getNativeWindowHandle().readBigUInt64LE(0);
  if (fg !== hostHwnd && fg !== gameHwnd && !studio.isFocused()) return;
  const pos = embed.cursorPos();
  if (!pos) return;
  const stage = stageScreenPhys();
  const inStage = pos.x >= stage.x && pos.x < stage.x + stage.width
    && pos.y >= stage.y && pos.y < stage.y + stage.height;
  if (inStage) embed.focusWindow(gameHwnd);
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
  setInterval(interactionTick, 150);
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

// Physische Pixelgröße der Bühne — der Renderer schreibt sie vor dem
// Replay-Start als Spielauflösung in die game.cfg.
ipcMain.handle("stage-size", () => {
  if (!studio || studio.isDestroyed()) return null;
  const cb = studio.getContentBounds();
  const stage = stageRect();
  const phys = screen.dipToScreenRect(studio, {
    x: cb.x + stage.x, y: cb.y + stage.y,
    width: stage.width, height: stage.height,
  });
  return { width: phys.width, height: phys.height };
});

// Gameflow-Phase des League-Clients (vom Studio-Renderer gemeldet). Steht
// ein echtes Spiel an, wird das laufende Replay sofort geschlossen — es kann
// nur eine Spielinstanz geben, und das Live-Game hat Vorrang. Dank des
// replayApiUp-Checks beim Andocken ist gameHwnd garantiert ein Replay.
const BUSY_PHASES = new Set(["ChampSelect", "GameStart", "InProgress", "Reconnect"]);

ipcMain.on("gameflow-phase", (_ev, phase) => {
  if (!BUSY_PHASES.has(phase)) return;
  if (gameHwnd && embed.isAlive(gameHwnd)) {
    embed.closeWindow(gameHwnd);
    if (studio && !studio.isDestroyed()) {
      studio.webContents.send("replay-autoclosed");
    }
  }
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
  resetLog();
  log("LoLTV startet, Modus:", FULLSCREEN_MODE ? "fullscreen" : "studio");
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
