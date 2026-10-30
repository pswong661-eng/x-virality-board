# Mission Control 3D

A dark, static 3D office for Eric's bot fleet. Open `index.html`. Each bot in `DATA` is a figure at its own desk. The panels read the same object: who is waiting on Eric, recent activity, routines, and the hourly activity grid.

Nothing here is sample data. If a list is missing or empty, the panel says `no data` (a missing count shows `—`). An empty `bots` array leaves the floor empty.

## Open it

From the repo root:

```bash
python3 -m http.server 8765
```

Then open http://127.0.0.1:8765/mission-control-3d/

You can also open `mission-control-3d/index.html` directly. `data.js` and `vendor/three.min.js` are classic scripts, so a file URL works. Three.js r160.1 (MIT) is vendored; the page does not call other services.

Drag to orbit, scroll or pinch to zoom, click a station or a list row for that bot's fields. Arrow keys orbit when focus is not on a button. Escape clears the selection. On a narrow screen the panels sit behind Waiting, Activity, Routines, and Fleet.

## How the refresh updates `data.js`

A refresh job rewrites **only the bytes between the marker lines**. Leave both marker lines, and leave the `window.DATA = DATA;` line that follows the end marker.

```
/* ===== MISSION_CONTROL_DATA_START (hourly refresh replaces everything between these markers) ===== */
const DATA = { ... };
/* ===== MISSION_CONTROL_DATA_END ===== */
window.DATA = DATA;
```

The replacement must stay valid JavaScript and must keep the variable name `DATA`. Do not turn the file into JSON, an ES module, or a different variable. The page loads `data.js` with a normal script tag before `app.js`.

```python
from pathlib import Path

path = Path("mission-control-3d/data.js")
text = path.read_text()
start_line = text.index("MISSION_CONTROL_DATA_START")
start_line = text.index("\n", start_line) + 1
end_line = text.rindex("\n", 0, text.index("MISSION_CONTROL_DATA_END")) + 1
replacement = """const DATA = {
  "generatedAt": "...",
};
"""
# Use a real object literal. Quotes around keys are optional.
path.write_text(text[:start_line] + replacement + text[end_line:])
```

Reload the page. No other file needs an edit. `missionControl.stationCount()` in the console equals `DATA.bots.length`.

### Shape

Same fields the current block uses. Missing keys are shown as empty, not filled in.

| Field | Used for |
| --- | --- |
| `generatedAt` | Clock on the stat card and the wall. Also the reference time for lamp brightness. |
| `windowNote` | The "Window note" disclosure. Empty becomes "Window note: no data". |
| `bots[]` | One desk each. `id`, `name`, `lastSeen`, `now`. |
| `waiting[]` | Count on the stat card, the waiting list, and the wall number. `bot` is a bot id. `at`, `text`, `source`. |
| `timeline[]` | Recent activity. `bot`, `at`, `text`. |
| `routines[]` | Upcoming runs. `bot`, `name`, `cron`, `next`. |
| `observedRoutines[]` | Patterns that were seen, not a next run. `bot`, `name`, `seen`. |
| `routinesNotVisible[]` | Names with no visible schedule. |
| `heatmap` | `days` plus `values` (one row per day). A row of 24 numbers is drawn as hours 0–23. |

`waiting[].bot`, `timeline[].bot`, `routines[].bot`, and `observedRoutines[].bot` match `bots[].id`. An id with no station still appears in the list; the detail card says no station matches.

`lastSeen` values with no timezone use the offset on `generatedAt` (`+07:00` in the current file). If `generatedAt` has no offset, those stamps are read as UTC.

### Lamps and typing

This is display only. It does not add status text.

- `now` is non-empty: the figure types and the screen stays bright.
- Otherwise the lamp follows `lastSeen` minus `generatedAt`: bright within 12 hours, dim within 48 hours, dark after that.
- A blank or unparseable `lastSeen`, with no `now`, stays dark.

Bot accent colors are a stable hash of `id` so neighboring desks are easier to tell apart. They are not a field in `DATA`.
