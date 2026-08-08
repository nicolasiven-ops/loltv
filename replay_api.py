"""Client für Riots lokale Replay-API.

Der Replay-Client (das Programm, das eine .rofl-Datei abspielt) ist der
Spectator-Client und bietet — sofern in der `game.cfg` aktiviert — eine lokale
REST-API auf https://127.0.0.1:2999 an. Darüber lassen sich Rendering
(Fog of War, HUD-Elemente, Kamera) und Playback (Pause, Speed, Zeitpunkt)
steuern, ohne Hotkeys ins Spielfenster zu schicken.

Aktivierung (einmalig): in `<League-Install>/Config/game.cfg` unter
`[General]` die Zeile `EnableReplayApi=1` ergänzen, dann den Replay-Client
neu starten.

Die API antwortet mit einem selbstsignierten Zertifikat (gleiches Muster wie
die LCU-API des League-Clients), daher verify=False.

Referenz: https://developer.riotgames.com/docs/lol#game-client-api_replay-api
LeagueDirector(NG) nutzt exakt dieselben Endpunkte.
"""

from __future__ import annotations

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_URL = "https://127.0.0.1:2999"
TIMEOUT = 4.0

# Alle bekannten Schalter von GET/POST /replay/render. Werte sind die
# jeweiligen Defaults der Spieler-Perspektive; der "Esports-Look" weicht
# davon gezielt ab (siehe ESPORTS_PRESET).
RENDER_TOGGLES = {
    "fogOfWar": True,             # False = Karte komplett aufgedeckt
    "interfaceAll": True,         # Master-Schalter fürs gesamte HUD (Hotkey H)
    "interfaceScoreboard": False, # Team-Frames links/rechts (Hotkey O)
    "interfaceTimeline": True,    # Zeitleiste unten
    "interfaceFrames": True,      # Champion-Frames
    "interfaceMinimap": True,
    "interfaceScore": True,       # Kills/Gold oben
    "interfaceNeutralTimers": True,  # Objective-Timer (Drache/Baron)
    "interfaceKillCallouts": True,
    "interfaceAnnounce": True,
    "interfaceChat": True,
    "interfaceQuests": True,
    "interfaceTarget": True,
    "interfaceReplay": True,      # Replay-Steuerleiste
    "healthBarChampions": True,
    "healthBarMinions": True,
    "healthBarStructures": True,
    "healthBarWards": True,
    "healthBarPets": True,
    "outlineHover": True,
    "outlineSelect": True,
    "floatingText": True,         # Schadenszahlen etc.
    "cameraAttached": False,      # Kamera an ausgewählte Einheit geheftet
}

# Der Broadcast-/LPL-Look: Fog of War aus, Beobachter-Scoreboard mit den
# Team-Frames beider Seiten an, Rest des HUDs an, Kamera frei.
ESPORTS_PRESET = {
    "fogOfWar": False,
    "interfaceAll": True,
    "interfaceScoreboard": True,
    "interfaceTimeline": True,
    "interfaceNeutralTimers": True,
    "interfaceReplay": False,
    "cameraAttached": False,
}


class ReplayApiError(Exception):
    """Replay-API nicht erreichbar oder Anfrage fehlgeschlagen."""


class ReplayApi:
    """Dünner Wrapper um die Replay-REST-API des laufenden Replay-Clients."""

    def __init__(self, base_url: str = BASE_URL):
        self.base_url = base_url
        self._session = requests.Session()
        self._session.verify = False

    def _request(self, method: str, path: str, payload: dict | None = None) -> dict:
        try:
            resp = self._session.request(
                method, self.base_url + path, json=payload, timeout=TIMEOUT
            )
            resp.raise_for_status()
            return resp.json() if resp.content else {}
        except requests.RequestException as exc:
            raise ReplayApiError(str(exc)) from exc

    # -- Verbindung ---------------------------------------------------------

    def is_available(self) -> bool:
        """True, sobald ein Replay-Client mit aktivierter API läuft."""
        try:
            self.get_playback()
            return True
        except ReplayApiError:
            return False

    def game_stats(self) -> dict:
        """Basisdaten des laufenden Spiels (Spielzeit etc.)."""
        return self._request("GET", "/liveclientdata/gamestats")

    # -- Rendering (Overlay/Optik) ------------------------------------------

    def get_render(self) -> dict:
        return self._request("GET", "/replay/render")

    def set_render(self, **properties) -> dict:
        """Einzelne Render-Eigenschaften setzen, z. B. set_render(fogOfWar=False)."""
        return self._request("POST", "/replay/render", properties)

    def apply_preset(self, preset: dict) -> dict:
        return self.set_render(**preset)

    # -- Playback -----------------------------------------------------------

    def get_playback(self) -> dict:
        """{'length': …, 'paused': …, 'seeking': …, 'speed': …, 'time': …}"""
        return self._request("GET", "/replay/playback")

    def set_playback(self, **properties) -> dict:
        """z. B. set_playback(paused=True), set_playback(time=930.0, speed=2.0)"""
        return self._request("POST", "/replay/playback", properties)

    def pause(self) -> dict:
        return self.set_playback(paused=True)

    def play(self) -> dict:
        return self.set_playback(paused=False)

    def seek(self, seconds: float) -> dict:
        return self.set_playback(time=float(seconds))

    def set_speed(self, speed: float) -> dict:
        return self.set_playback(speed=float(speed))
