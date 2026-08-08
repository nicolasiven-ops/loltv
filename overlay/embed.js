// Win32-Einbettung des LoL-Spielfensters (nur Windows).
//
// Das laufende Spielfenster („League of Legends (TM) Client“) wird per
// SetParent zum Kind-Fenster des Studio-Fensters gemacht und dabei von seinen
// Top-Level-Stilen (Rahmen/Popup) befreit. Beim Beenden wird es wieder sauber
// ausgehängt und als normales Fenster wiederhergestellt.
//
// Die user32-Aufrufe laufen über koffi (FFI mit fertigen Binaries, kein
// Compiler nötig). HWNDs werden durchgängig als BigInt behandelt.

const GAME_WINDOW_TITLE = "League of Legends (TM) Client";

const GWL_STYLE = -16;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const SW_SHOW = 5;
const SWP_NOZORDER = 0x0004;
const SWP_FRAMECHANGED = 0x0020;

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
  fns = {
    FindWindowW: user32.func("FindWindowW", "uint64_t", ["str16", "str16"]),
    IsWindow: user32.func("IsWindow", "bool", ["uint64_t"]),
    SetParent: user32.func("SetParent", "uint64_t", ["uint64_t", "uint64_t"]),
    GetWindowLongW: user32.func("GetWindowLongW", "int32_t", ["uint64_t", "int32_t"]),
    SetWindowLongW: user32.func("SetWindowLongW", "int32_t", ["uint64_t", "int32_t", "int32_t"]),
    SetWindowPos: user32.func("SetWindowPos", "bool",
      ["uint64_t", "uint64_t", "int32_t", "int32_t", "int32_t", "int32_t", "uint32_t"]),
    ShowWindow: user32.func("ShowWindow", "bool", ["uint64_t", "int32_t"]),
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

function embed(gameHwnd, hostHwnd) {
  const style = fns.GetWindowLongW(gameHwnd, GWL_STYLE);
  saved = { hwnd: gameHwnd, style };
  const childStyle = (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME)) | WS_CHILD;
  fns.SetWindowLongW(gameHwnd, GWL_STYLE, childStyle | 0);
  fns.SetParent(gameHwnd, hostHwnd);
  fns.ShowWindow(gameHwnd, SW_SHOW);
}

// x/y/w/h in physischen Pixeln, relativ zur Client-Fläche des Studio-Fensters.
function moveTo(hwnd, x, y, w, h) {
  fns.SetWindowPos(hwnd, 0n, x, y, w, h, SWP_NOZORDER | SWP_FRAMECHANGED);
}

function detach() {
  if (!saved || !isAlive(saved.hwnd)) {
    saved = null;
    return;
  }
  fns.SetWindowLongW(saved.hwnd, GWL_STYLE, saved.style | 0);
  fns.SetParent(saved.hwnd, 0n);
  fns.SetWindowPos(saved.hwnd, 0n, 100, 100, 1600, 900, SWP_NOZORDER | SWP_FRAMECHANGED);
  fns.ShowWindow(saved.hwnd, SW_SHOW);
  saved = null;
}

module.exports = { available, findGame, isAlive, embed, moveTo, detach };
