// Win32-Docking des LoL-Spielfensters (nur Windows).
//
// Das Spielfenster wird NICHT per SetParent zum Kind-Fenster gemacht (das
// bricht Tastatur-Fokus, ESC-Menü und Spectator-Navigation), sondern bleibt
// ein eigenständiges Top-Level-Fenster mit nativer Eingabe-Pipeline:
//   * Rahmen/Titelleiste werden entfernt,
//   * das Studio-Fenster wird als Owner gesetzt (Spiel liegt dadurch immer
//     über dem Studio, minimiert sich mit ihm und hat keinen eigenen
//     Taskleisten-Eintrag),
//   * und main.js führt es per SetWindowPos deckungsgleich über der Bühne.
// Beim Beenden wird alles wiederhergestellt.
//
// Die user32-Aufrufe laufen über koffi (FFI mit fertigen Binaries, kein
// Compiler nötig). HWNDs werden durchgängig als BigInt behandelt.

const GAME_WINDOW_TITLE = "League of Legends (TM) Client";

const GWL_STYLE = -16;
const GWLP_HWNDPARENT = -8;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_SYSMENU = 0x00080000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const SW_SHOW = 5;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;

let fns = null;
let RECT = null;
let saved = null; // { hwnd, style, owner } — Zustand vor dem Docking

function available() {
  return process.platform === "win32";
}

function init() {
  if (!available()) return false;
  if (fns) return true;
  const koffi = require("koffi");
  const user32 = koffi.load("user32.dll");
  RECT = koffi.struct("RECT", {
    left: "int32_t", top: "int32_t", right: "int32_t", bottom: "int32_t",
  });
  fns = {
    GetWindowRect: user32.func("GetWindowRect", "bool",
      ["uint64_t", koffi.out(koffi.pointer(RECT))]),
    FindWindowW: user32.func("FindWindowW", "uint64_t", ["str16", "str16"]),
    IsWindow: user32.func("IsWindow", "bool", ["uint64_t"]),
    GetWindowLongW: user32.func("GetWindowLongW", "int32_t", ["uint64_t", "int32_t"]),
    SetWindowLongW: user32.func("SetWindowLongW", "int32_t", ["uint64_t", "int32_t", "int32_t"]),
    GetWindowLongPtrW: user32.func("GetWindowLongPtrW", "int64_t", ["uint64_t", "int32_t"]),
    SetWindowLongPtrW: user32.func("SetWindowLongPtrW", "int64_t", ["uint64_t", "int32_t", "int64_t"]),
    SetWindowPos: user32.func("SetWindowPos", "bool",
      ["uint64_t", "uint64_t", "int32_t", "int32_t", "int32_t", "int32_t", "uint32_t"]),
    ShowWindow: user32.func("ShowWindow", "bool", ["uint64_t", "int32_t"]),
    GetForegroundWindow: user32.func("GetForegroundWindow", "uint64_t", []),
    PostMessageW: user32.func("PostMessageW", "bool",
      ["uint64_t", "uint32_t", "uint64_t", "int64_t"]),
    ClipCursor: user32.func("ClipCursor", "bool", ["void*"]),
    IsIconic: user32.func("IsIconic", "bool", ["uint64_t"]),
  };
  return true;
}

function isIconic(hwnd) {
  return Boolean(isAlive(hwnd) && fns.IsIconic(hwnd));
}

// Fensterstil (für Diagnose-Logging).
function windowStyle(hwnd) {
  return isAlive(hwnd) ? (fns.GetWindowLongW(hwnd, GWL_STYLE) >>> 0).toString(16) : "0";
}

// Maus-Fessel des Spiels lösen: League sperrt den Cursor im Fenstermodus auf
// sein Fenster (fürs Edge-Panning). Im Studio soll die Maus aber jederzeit an
// Titel- und Playback-Leiste kommen — main.js ruft das periodisch auf,
// solange ein Replay angedockt und fokussiert ist.
function releaseCursorClip() {
  if (init()) fns.ClipCursor(null);
}

// Fenster höflich schließen (WM_CLOSE) — der Replay-Client beendet sich dann
// selbst. Wird genutzt, um das Replay freizugeben, bevor ein echtes Spiel
// startet.
const WM_CLOSE = 0x0010;
function closeWindow(hwnd) {
  if (isAlive(hwnd)) fns.PostMessageW(hwnd, WM_CLOSE, 0n, 0n);
}

function findGame() {
  if (!init()) return 0n;
  return BigInt(fns.FindWindowW(null, GAME_WINDOW_TITLE));
}

function isAlive(hwnd) {
  return Boolean(hwnd && init() && fns.IsWindow(hwnd));
}

function foreground() {
  return init() ? BigInt(fns.GetForegroundWindow()) : 0n;
}

// Fenster-Rechteck in physischen Bildschirm-Pixeln (oder null).
function windowRect(hwnd) {
  if (!isAlive(hwnd)) return null;
  const out = {};
  if (!fns.GetWindowRect(hwnd, out)) return null;
  return {
    x: out.left, y: out.top,
    width: out.right - out.left, height: out.bottom - out.top,
  };
}

// Rahmen entfernen und ans Studio-Fenster hängen (Owner, kein Parent!).
function attach(gameHwnd, ownerHwnd) {
  const style = fns.GetWindowLongW(gameHwnd, GWL_STYLE);
  const owner = BigInt(fns.GetWindowLongPtrW(gameHwnd, GWLP_HWNDPARENT));
  saved = { hwnd: gameHwnd, style, owner };
  const borderless = style & ~(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
  fns.SetWindowLongW(gameHwnd, GWL_STYLE, borderless | 0);
  fns.SetWindowLongPtrW(gameHwnd, GWLP_HWNDPARENT, ownerHwnd);
}

// x/y/w/h in physischen Bildschirm-Pixeln.
function moveToScreen(hwnd, x, y, w, h) {
  fns.SetWindowPos(hwnd, 0n, x, y, w, h,
    SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
}

function detach() {
  if (!saved || !isAlive(saved.hwnd)) {
    saved = null;
    return;
  }
  fns.SetWindowLongW(saved.hwnd, GWL_STYLE, saved.style | 0);
  fns.SetWindowLongPtrW(saved.hwnd, GWLP_HWNDPARENT, saved.owner);
  fns.SetWindowPos(saved.hwnd, 0n, 100, 100, 1600, 900, SWP_NOZORDER | SWP_FRAMECHANGED);
  fns.ShowWindow(saved.hwnd, SW_SHOW);
  saved = null;
}

module.exports = {
  available, findGame, isAlive, foreground, windowRect, isIconic, windowStyle,
  attach, moveToScreen, closeWindow, releaseCursorClip, detach,
};
