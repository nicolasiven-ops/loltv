"""LoLTV — Overlay-Steuerung für den League-of-Legends-Replay-Client.

Baseline des LoLTV-Projekts: Läuft ein Replay (.rofl), verbindet sich dieses
Panel mit Riots lokaler Replay-API (siehe replay_api.py) und macht die
Spectator-Optik per Klick einstellbar — Fog of War, Beobachter-Scoreboard,
einzelne HUD-Elemente, Kamera sowie Playback (Pause/Speed/Spulen).

Der Button „Esports-Look“ stellt in einem Rutsch die Broadcast-Optik her:
Karte aufgedeckt, Team-Frames beider Seiten, Objective-Timer, freie Kamera.

Voraussetzung: In `<League-Install>/Config/game.cfg` unter `[General]` die
Zeile `EnableReplayApi=1` ergänzen und den Replay-Client neu starten. Ohne
laufendes Replay wartet das Panel einfach und verbindet sich automatisch.
"""

import threading
import time
import tkinter as tk
from tkinter import ttk

from replay_api import ESPORTS_PRESET, ReplayApi, ReplayApiError

POLL_SECONDS = 1.0
SPEEDS = (0.5, 1.0, 2.0, 4.0, 8.0)

# (Anzeigename, Render-Property) in Anzeige-Reihenfolge. fogOfWar ist als
# einziger Schalter invertiert gedacht („aufdecken“), das regelt die UI.
TOGGLES = [
    ("Karte aufdecken (Fog of War aus)", "fogOfWar"),
    ("Beobachter-Scoreboard (Team-Frames, Taste O)", "interfaceScoreboard"),
    ("HUD komplett (Taste H)", "interfaceAll"),
    ("Zeitleiste", "interfaceTimeline"),
    ("Objective-Timer", "interfaceNeutralTimers"),
    ("Replay-Steuerleiste", "interfaceReplay"),
    ("Minimap", "interfaceMinimap"),
    ("Schadenszahlen", "floatingText"),
    ("Lebensbalken Vasallen", "healthBarMinions"),
    ("Kamera an Auswahl heften", "cameraAttached"),
]
INVERTED = {"fogOfWar"}  # Häkchen gesetzt == Property False


def fmt_time(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


class LoLTVApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.api = ReplayApi()
        self.connected = False
        self.length = 0.0
        self.dragging = False  # Slider wird gerade gezogen — nicht überschreiben

        root.title("LoLTV — Replay-Overlay")
        root.resizable(False, False)

        main = ttk.Frame(root, padding=12)
        main.grid(sticky="nsew")

        self.status_var = tk.StringVar(value="Warte auf Replay-Client …")
        ttk.Label(main, textvariable=self.status_var).grid(
            row=0, column=0, columnspan=3, sticky="w", pady=(0, 8)
        )

        ttk.Button(main, text="✨ Esports-Look", command=self.apply_esports).grid(
            row=1, column=0, columnspan=3, sticky="ew", pady=(0, 8)
        )

        # Render-Schalter
        box = ttk.LabelFrame(main, text="Overlay", padding=8)
        box.grid(row=2, column=0, columnspan=3, sticky="ew")
        self.toggle_vars: dict[str, tk.BooleanVar] = {}
        for i, (label, prop) in enumerate(TOGGLES):
            var = tk.BooleanVar(value=False)
            self.toggle_vars[prop] = var
            ttk.Checkbutton(
                box, text=label, variable=var,
                command=lambda p=prop: self.on_toggle(p),
            ).grid(row=i, column=0, sticky="w")

        # Playback
        play = ttk.LabelFrame(main, text="Playback", padding=8)
        play.grid(row=3, column=0, columnspan=3, sticky="ew", pady=(8, 0))
        play.columnconfigure(1, weight=1)

        self.pause_btn = ttk.Button(play, text="⏸", width=4, command=self.on_pause)
        self.pause_btn.grid(row=0, column=0)

        self.time_var = tk.DoubleVar(value=0.0)
        self.slider = ttk.Scale(
            play, variable=self.time_var, from_=0.0, to=1.0, orient="horizontal"
        )
        self.slider.grid(row=0, column=1, sticky="ew", padx=6)
        self.slider.bind("<ButtonPress-1>", lambda e: setattr(self, "dragging", True))
        self.slider.bind("<ButtonRelease-1>", self.on_seek)

        self.clock_var = tk.StringVar(value="–:–– / –:––")
        ttk.Label(play, textvariable=self.clock_var, width=13).grid(row=0, column=2)

        speed_row = ttk.Frame(play)
        speed_row.grid(row=1, column=0, columnspan=3, pady=(6, 0))
        ttk.Label(speed_row, text="Tempo:").pack(side="left", padx=(0, 4))
        for s in SPEEDS:
            ttk.Button(
                speed_row, text=f"{s:g}×", width=4,
                command=lambda s=s: self.call_api(self.api.set_speed, s),
            ).pack(side="left", padx=2)

        threading.Thread(target=self.poll_loop, daemon=True).start()

    # -- API-Aufrufe (immer im Hintergrund-Thread, UI nie blockieren) --------

    def call_api(self, fn, *args, **kwargs):
        def worker():
            try:
                fn(*args, **kwargs)
            except ReplayApiError:
                pass  # Verbindungsverlust meldet der Poll-Loop
        threading.Thread(target=worker, daemon=True).start()

    def on_toggle(self, prop: str):
        checked = self.toggle_vars[prop].get()
        value = (not checked) if prop in INVERTED else checked
        self.call_api(self.api.set_render, **{prop: value})

    def apply_esports(self):
        self.call_api(self.api.apply_preset, ESPORTS_PRESET)

    def on_pause(self):
        paused = self.pause_btn["text"] == "⏸"
        self.call_api(self.api.set_playback, paused=paused)

    def on_seek(self, _event):
        self.dragging = False
        self.call_api(self.api.seek, self.time_var.get())

    # -- Poll-Loop: Verbindung + Zustand vom Client in die UI spiegeln ------

    def poll_loop(self):
        while True:
            try:
                playback = self.api.get_playback()
                render = self.api.get_render()
            except ReplayApiError:
                self.root.after(0, self.show_disconnected)
                time.sleep(POLL_SECONDS)
                continue
            self.root.after(0, self.show_state, playback, render)
            time.sleep(POLL_SECONDS)

    def show_disconnected(self):
        self.connected = False
        self.status_var.set(
            "Warte auf Replay-Client … (Replay starten; EnableReplayApi=1 nötig)"
        )

    def show_state(self, playback: dict, render: dict):
        if not self.connected:
            self.connected = True
        self.status_var.set("Verbunden mit Replay-Client ✔")

        self.length = playback.get("length", 0.0) or 0.0
        current = playback.get("time", 0.0) or 0.0
        self.slider.configure(to=max(self.length, 1.0))
        if not self.dragging:
            self.time_var.set(current)
        self.clock_var.set(f"{fmt_time(current)} / {fmt_time(self.length)}")
        self.pause_btn.configure(text="▶" if playback.get("paused") else "⏸")

        for _label, prop in TOGGLES:
            if prop in render:
                value = render[prop]
                self.toggle_vars[prop].set((not value) if prop in INVERTED else value)


def main():
    root = tk.Tk()
    LoLTVApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
