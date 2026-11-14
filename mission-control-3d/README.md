# Mission Control 3D

A night-time 3D floor of Mission Control for Eric's bot fleet. Open `index.html`. Each bot in `DATA` is a holo figure on a high floor of a glass tower, with the city outside. The panels read the same object: who is waiting on Eric, recent activity, routines, and the hourly activity grid.

Nothing here is sample data. If a list is missing or empty, the panel says `no data` (a missing count shows `—`). An empty `bots` array leaves the floor empty.

## Open it

From the repo root:

```bash
python3 -m http.server 8765
```

Then open http://127.0.0.1:8765/mission-control-3d/

`loader.js` fetches `data.json` (no cache), then loads `vendor/three.min.js` and `app.js`. A `file://` URL cannot fetch `data.json`, so use the local server. Three.js r160.1 (MIT) is vendored; the page does not call other services.

Drag to orbit, scroll or pinch to zoom, click a bot or a list row for that bot's fields. The view keeps turning slowly until you drag, scroll, or use the arrow keys. Arrow keys orbit when focus is not on a button. Escape clears the selection. On a narrow screen the panels sit behind Waiting, Activity, Routines, and Fleet.

**Glow: high** on the header card adds a soft bloom over the neon and screens. **Glow: low** skips that pass and draws fewer pixels, for a laptop that is struggling. The choice is remembered in this browser.

**Tour: off** is the default. **Tour: on** plays a slow lap — wide view, the working board, the executive office, then wide again — and repeats until you turn it off or click a bot. Dragging pauses the lap for a few seconds. The choice is not remembered.

The left-wall **WORKING NOW** board lists every bot whose `now` is non-empty: accent colour, name, and that `now` text, plus the count. It polls `data.json` about every 15 seconds. A `now` change moves that bot between typing and idle without a reload. If bots are added, removed, or renamed, the page reloads so the floor can be rebuilt. An empty busy list shows the count `0` and no rows.

## How the refresh updates `data.json`

Replace `mission-control-3d/data.json` with the same object the page already reads. Keep the field names. Do not add a required field. Missing keys still render as empty.

```python
import json
from pathlib import Path

path = Path("mission-control-3d/data.json")
fresh = {
    "generatedAt": "...",
    "windowNote": "",
    "bots": [],
    "heatmap": {"days": [], "values": []},
    "waiting": [],
    "timeline": [],
    "routines": [],
    "observedRoutines": [],
    "routinesNotVisible": [],
}
path.write_text(json.dumps(fresh, indent=1) + "\n")
```

Use the real payload. Reload the page, or wait for the poll. `missionControl.stationCount()` equals `DATA.bots.length`.

## Zones

Desk neighbourhoods are not in `data.json`. The only map is the `OFFICE` object at the top of `app.js`. Match is case-insensitive on `bots[].name`. A configured name also matches when the bot name starts with that name plus `/` (`Reed` matches `Reed/PannaiGrok`). The first list that contains the name wins. Anyone left over goes to `defaultZone`, and that carpet is drawn only when it has someone. `VILLA VISOUN` is in the list with no names, so the carpet is empty until you add one. `Shelf` is under AKEMI because that is the only list that names Shelf. Al Capone is `executive`, not a business zone: a glass room, and the configured `role` (`CoS`) is the second line of that nameplate only.

### Shape

Same fields the current block uses. Missing keys are shown as empty, not filled in.

| Field | Used for |
| --- | --- |
| `generatedAt` | Clock on the stat card and the wall. Also the reference time for lamp brightness. |
| `windowNote` | The "Window note" disclosure. Empty becomes "Window note: no data". |
| `bots[]` | One figure each. `id`, `name`, `lastSeen`, `now`. |
| `waiting[]` | Count on the stat card, the waiting list, and the wall number. `bot` is a bot id. `at`, `text`, `source`. |
| `timeline[]` | Recent activity. `bot`, `at`, `text`. |
| `routines[]` | Upcoming runs. `bot`, `name`, `cron`, `next`. |
| `observedRoutines[]` | Patterns that were seen, not a next run. `bot`, `name`, `seen`. |
| `routinesNotVisible[]` | Names with no visible schedule. |
| `heatmap` | `days` plus `values` (one row per day). A row of 24 numbers is drawn as hours 0–23. |

`waiting[].bot`, `timeline[].bot`, `routines[].bot`, and `observedRoutines[].bot` match `bots[].id`. An id with no figure still appears in the list; the detail card says no bot matches.

`lastSeen` values with no timezone use the offset on `generatedAt` (`+07:00` in the current file). If `generatedAt` has no offset, those stamps are read as UTC.

### Bots, glow, and the picture

This is display only. It does not add status text.

- `now` is non-empty: the bot sits at its desk and types. The screen stays bright, and a holo bubble shows that `now` text.
- Otherwise the bot idles. A stable mix, from the bot id, either bobs in place, looks around, or walks a short loop on the aisle and returns to the desk. Reduced motion keeps every bot still.
- Glow uses `lastSeen` against `generatedAt`, unless `now` is set (that figure is bright and typing). Bright within 12 hours, dim within 48 hours, dark after that.
- A blank or unparseable `lastSeen`, with no `now`, stays dark.

Bot accent colors are a stable hash of `id` so neighbors are easier to tell apart. They are not a field in `DATA`.

The room is the high floor of a glass tower at night: floor-to-ceiling windows, a lit skyline, a few moving drones and street lights, light fog, and stars. Neon floor lines, emissive screens, and rim light are drawn either way. Bloom is the part the Glow button turns off.
