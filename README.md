# LoLTV

Spieler eingeben, Match aussuchen, abspielen — mit frei wählbarem Overlay.
Ziel ist eine Art „LoLTV“: Replays beliebiger Spieler direkt in der sauberen
Esports-/Spectator-Optik (LPL-Feed-Look) anschauen statt in der
Standard-Spielerperspektive.

**Status: Baseline.** Dieses Repo enthält den ersten Baustein — die
Overlay-Steuerung für den laufenden Replay-Client. Spielersuche, Match-Liste
und Abspiel-Frontend kommen darauf aufbauend.

## Was die Baseline kann

`app.py` ist ein kleines Steuerpanel, das sich mit Riots lokaler **Replay-API**
(`https://127.0.0.1:2999`) verbindet, sobald ein Replay läuft:

- **„Esports-Look“-Preset**: Karte komplett aufgedeckt (Fog of War aus),
  Beobachter-Scoreboard mit den Team-Frames beider Seiten, Objective-Timer,
  freie Kamera — ein Klick.
- Einzelne Overlay-Schalter: HUD komplett (Taste `H`), Scoreboard (Taste `O`),
  Zeitleiste, Minimap, Schadenszahlen, Lebensbalken, Kamera-Heftung u. a.
- Playback: Pause/Play, Spulen per Slider, Tempo 0,5×–8×.

Die Steuerung läuft über die REST-API, nicht über Tastatur-Eingaben ins
Spielfenster — dieselbe Schnittstelle, an die sich auch LeagueDirector(NG)
hängt (Referenz für spätere tiefere Kamera-/Rendering-Kontrolle).

## Nutzung

1. **Einmalig:** In `<League-Install>/Config/game.cfg` unter `[General]` die
   Zeile `EnableReplayApi=1` ergänzen.
2. Im League-Client ein Replay starten (Reiter „Profil → Match-Verlauf“,
   Download-Symbol, dann Abspielen).
3. Panel starten:

       pip install -r requirements.txt
       python app.py

   Das Panel wartet, bis der Replay-Client läuft, und verbindet sich
   automatisch. „✨ Esports-Look“ klicken — fertig.

## Bekannte Constraints (wichtig fürs Gesamtkonzept)

- **Patch-Bindung:** `.rofl`-Replays laufen nur auf dem Patch, auf dem sie
  aufgenommen wurden. Jedes Archiv-/Abspielkonzept muss damit umgehen
  (Replays altern nach ~2 Wochen aus, sobald der nächste Patch live ist).
- **Replay-Client = Spectator-Client:** Alle Esports-Toggles sind vorhanden,
  nur anders vorbelegt — genau das korrigiert dieses Panel.
- Die Replay-API ist offiziell von Riot dokumentiert
  ([Game Client API → Replay API](https://developer.riotgames.com/docs/lol#game-client-api_replay-api))
  und rein lesend/steuernd am eigenen Client — kein Eingriff ins Spiel.

## Roadmap

1. ✅ **Baseline:** Overlay des laufenden Replays steuern (dieses Panel).
2. ⬜ **Spielersuche:** Riot-ID eingeben → Account/Matches über die Riot-API.
3. ⬜ **Match-Liste:** Spiele mit Champion, KDA, Ergebnis; Replay-Download
   über den League-Client anstoßen (LCU-API — der `lcu.py`-Helper aus
   [pc-tools/lol-autopick](https://github.com/nicolasiven-ops/pc-tools/tree/main/lol-autopick)
   lässt sich dafür übernehmen).
4. ⬜ **Abspiel-Frontend:** Match anklicken → Replay startet automatisch im
   gewünschten Look (Panel-Preset direkt beim Start anwenden).
5. ⬜ **Kamera-Regie:** Auto-Kamera/Regie-Funktionen (Kampf-Fokus, Fahrten) —
   hier lohnt der Blick in LeagueDirectorNG.
