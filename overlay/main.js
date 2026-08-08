// LoLTV Broadcast-Overlay — Electron-Host.
//
// Erzeugt ein randloses, transparentes, klickdurchlässiges Fenster über dem
// ganzen Bildschirm und lädt overlay.html hinein. Das Spiel muss im
// Fenstermodus „Randlos“ laufen, damit das Overlay darüber liegen kann.
//
// Hotkeys (global):
//   Strg+F12      Overlay ein-/ausblenden
//   Strg+Alt+F12  Overlay beenden

const { app, BrowserWindow, globalShortcut, screen } = require("electron");

// Replay-/Live-Client-API antwortet mit selbstsigniertem Zertifikat.
app.commandLine.appendSwitch("ignore-certificate-errors");

let win = null;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      // Die lokale Riot-API sendet keine CORS-Header; ohne webSecurity darf
      // der Renderer sie trotzdem per fetch() ansprechen (rein lokales Tool).
      webSecurity: false,
      backgroundThrottling: false,
    },
  });

  // "screen-saver"-Level liegt auch über randlosen Vollbild-Spielen.
  win.setAlwaysOnTop(true, "screen-saver");
  // Mausklicks gehen durchs Overlay hindurch ans Spiel.
  win.setIgnoreMouseEvents(true);
  win.loadFile("overlay.html");
}

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register("Control+F12", () => {
    if (win.isVisible()) win.hide();
    else win.show();
  });
  globalShortcut.register("Control+Alt+F12", () => app.quit());
});

app.on("will-quit", () => globalShortcut.unregisterAll());
