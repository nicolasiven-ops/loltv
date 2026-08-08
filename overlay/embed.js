// Win32-Einbettung des LoL-Spielfensters (nur Windows).
//
// Das Spielfenster wird per SetParent als Kind-Fenster in das Studio
// eingebettet — dadurch bewegt es sich atomar mit dem Studio (kein
// Nachziehen wie beim Owner-Docking). Der Preis: Ein Kind-Fenster eines
// fremden Prozesses bekommt Tastatur-Fokus nicht von allein. Das löst
// focusWindow() über AttachThreadInput + SetFocus; main.js ruft es auf,
// sobald der Cursor über der Bühne steht („Fokus folgt der Maus“).
//
// Voraussetzung fürs Einbetten ist ein echtes Fenster (WindowMode=1 in der
// game.cfg, von gamecfg.js gesetzt) — Vollbild/minimiert/Übergangsfenster
// werden von main.js vorher aussortiert.
//
// Die user32-/kernel32-Aufrufe laufen über koffi. HWNDs sind BigInt.

const GAME_WINDOW_TITLE = "League of Legends (TM) Client";

const GWL_STYLE = -16;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
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
const WM_CLOSE = 0x0010;

let fns = null;
let saved = null; // { hwnd, style } — Zustand vor der Einbettung

function available() {
  return process.platform === "win32";
}

function init() {
  if (!available()) return false;
  if (fns) return true;
  const koffi = require("koffi");
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const RECT = koffi.struct("RECT", {
    left: "int32_t", top: "int32_t", right: "int32_t", bottom: "int32_t",
  });
  const POINT = koffi.struct("POINT", { x: "int32_t", y: "int32_t" });
  fns = {
    FindWindowW: user32.func("FindWindowW", "uint64_t", ["str16", "str16"]),
    IsWindow: user32.func("IsWindow", "bool", ["uint64_t"]),
    IsIconic: user32.func("IsIconic", "bool", ["uint64_t"]),
    GetWindowRect: user32.func("GetWindowRect", "bool",
      ["uint64_t", koffi.out(koffi.pointer(RECT))]),
    GetCursorPos: user32.func("GetCursorPos", "bool",
      [koffi.out(koffi.pointer(POINT))]),
    GetWindowLongW: user32.func("GetWindowLongW", "int32_t", ["uint64_t", "int32_t"]),
    SetWindowLongW: user32.func("SetWindowLongW", "int32_t", ["uint64_t", "int32_t", "int32_t"]),
    SetParent: user32.func("SetParent", "uint64_t", ["uint64_t", "uint64_t"]),
    SetWindowPos: user32.func("SetWindowPos", "bool",
      ["uint64_t", "uint64_t", "int32_t", "int32_t", "int32_t", "int32_t", "uint32_t"]),
    ShowWindow: user32.func("ShowWindow", "bool", ["uint64_t", "int32_t"]),
    GetForegroundWindow: user32.func("GetForegroundWindow", "uint64_t", []),
    PostMessageW: user32.func("PostMessageW", "bool",
      ["uint64_t", "uint32_t", "uint64_t", "int64_t"]),
    ClipCursor: user32.func("ClipCursor", "bool", ["void*"]),
    GetWindowThreadProcessId: user32.func("GetWindowThreadProcessId", "uint32_t",
      ["uint64_t", "void*"]),
    AttachThreadInput: user32.func("AttachThreadInput", "bool",
      ["uint32_t", "uint32_t", "bool"]),
    SetFocus: user32.func("SetFocus", "uint64_t", ["uint64_t"]),
    GetFocus: user32.func("GetFocus", "uint64_t", []),
    GetCurrentThreadId: kernel32.func("GetCurrentThreadId", "uint32_t", []),
  };
  return true;
}

function findGame() {
  if (!init()) return 0n;
  return BigInt(fns.FindWindowW(null, GAME_WINDOW_TITLE));
}

function isAlive(hwnd) {
  return Boolean(hwnd && init() && fns.IsWindow(hwnd));
}

function isIconic(hwnd) {
  return Boolean(isAlive(hwnd) && fns.IsIconic(hwnd));
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

// Cursor-Position in physischen Bildschirm-Pixeln (oder null).
function cursorPos() {
  if (!init()) return null;
  const out = {};
  return fns.GetCursorPos(out) ? { x: out.x, y: out.y } : null;
}

// Fensterstil (für Diagnose-Logging).
function windowStyle(hwnd) {
  return isAlive(hwnd) ? (fns.GetWindowLongW(hwnd, GWL_STYLE) >>> 0).toString(16) : "0";
}

// Spielfenster als Kind-Fenster ins Studio einbetten. Die Input-Queues
// beider Threads werden dauerhaft verbunden — nur so funktionieren Fokus,
// Maus-Capture und damit KLICKS im fremden Kind-Fenster zuverlässig
// (Hover ginge auch ohne, Button-Klicks nicht).
function attach(gameHwnd, hostHwnd) {
  const style = fns.GetWindowLongW(gameHwnd, GWL_STYLE);
  const gameThread = fns.GetWindowThreadProcessId(gameHwnd, null);
  const ownThread = fns.GetCurrentThreadId();
  saved = { hwnd: gameHwnd, style, gameThread, ownThread };
  const childStyle = (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME
    | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)) | WS_CHILD;
  fns.SetWindowLongW(gameHwnd, GWL_STYLE, childStyle | 0);
  fns.SetParent(gameHwnd, hostHwnd);
  fns.AttachThreadInput(ownThread, gameThread, true);
  fns.ShowWindow(gameHwnd, SW_SHOW);
}

// Kind-Fenster positionieren: x/y relativ zur Client-Fläche des Studios,
// alles in physischen Pixeln.
function moveTo(hwnd, x, y, w, h) {
  fns.SetWindowPos(hwnd, 0n, x, y, w, h,
    SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
}

// Dem eingebetteten Spiel Tastatur-Fokus geben — aber nur, wenn er nicht
// schon dort liegt: ständiges Neu-Setzen würde laufende Klick-Sequenzen
// unterbrechen (Button-Down ohne -Up = kein Klick).
function focusWindow(hwnd) {
  if (!isAlive(hwnd)) return;
  if (BigInt(fns.GetFocus()) === hwnd) return;
  fns.SetFocus(hwnd);
}

// Fenster höflich schließen (WM_CLOSE) — für den Live-Game-Vorrang.
function closeWindow(hwnd) {
  if (isAlive(hwnd)) fns.PostMessageW(hwnd, WM_CLOSE, 0n, 0n);
}

// Maus-Fessel des Spiels lösen (League sperrt den Cursor auf sein Fenster;
// die Maus soll aber an Titel- und Playback-Leiste kommen).
function releaseCursorClip() {
  if (init()) fns.ClipCursor(null);
}

function detach() {
  if (!saved) return;
  fns.AttachThreadInput(saved.ownThread, saved.gameThread, false);
  if (!isAlive(saved.hwnd)) {
    saved = null;
    return;
  }
  fns.SetWindowLongW(saved.hwnd, GWL_STYLE, saved.style | 0);
  fns.SetParent(saved.hwnd, 0n);
  fns.SetWindowPos(saved.hwnd, 0n, 100, 100, 1600, 900, SWP_NOZORDER | SWP_FRAMECHANGED);
  fns.ShowWindow(saved.hwnd, SW_SHOW);
  saved = null;
}

module.exports = {
  available, findGame, isAlive, isIconic, foreground, windowRect, cursorPos,
  windowStyle, attach, moveTo, focusWindow, closeWindow, releaseCursorClip, detach,
};
