// Einstellungs-Fenster: liest den Store (config.js), schreibt Änderungen
// sofort zurück und meldet sie dem Main-Prozess, der HUD und Studio
// aktualisiert.

const { ipcRenderer } = require("electron");
const config = require("./config");

const $ = (id) => document.getElementById(id);

function apply(patch) {
  config.save(patch);
  ipcRenderer.send("settings-changed");
}

function render(s) {
  for (const el of document.querySelectorAll(".layout")) {
    el.classList.toggle("active", el.dataset.layout === s.playerLayout);
  }
  for (const box of document.querySelectorAll("input[data-key]")) {
    const value = s[box.dataset.key];
    box.checked = box.dataset.invert ? !value : Boolean(value);
  }
  $("scale").value = s.hudScale;
  $("scale-val").textContent = `${s.hudScale} %`;
}

for (const el of document.querySelectorAll(".layout")) {
  el.addEventListener("click", () => {
    apply({ playerLayout: el.dataset.layout });
    render(config.load());
  });
}

for (const box of document.querySelectorAll("input[data-key]")) {
  box.addEventListener("change", () => {
    const value = box.dataset.invert ? !box.checked : box.checked;
    apply({ [box.dataset.key]: value });
  });
}

$("scale").addEventListener("input", () => {
  $("scale-val").textContent = `${$("scale").value} %`;
  apply({ hudScale: Number($("scale").value) });
});

$("reset").addEventListener("click", () => {
  // Suchverlauf ist keine Einstellung — der bleibt beim Zurücksetzen stehen.
  const { recentAccounts } = config.load();
  config.save({ ...config.DEFAULTS, recentAccounts });
  ipcRenderer.send("settings-changed");
  render(config.load());
});

$("btn-close").addEventListener("click", () => ipcRenderer.send("close-settings"));

render(config.load());
