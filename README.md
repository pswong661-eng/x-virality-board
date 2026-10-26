# Eric's X Virality Score

Personal dashboard for Eric Wong ([@poh_sang62631](https://x.com/poh_sang62631)). GitHub Pages serves `index.html` and `data.json` from the root of `main`. After each daily digest the board shows the X score, day target, watchlist hits, and week and month leaderboards.

https://monkeyteamvip.github.io/kiosa-board/ is only the demo. It is a filled-in case study, not this watchlist, and it does not update when this board does.

Live board (after Pages is enabled on `main` / root):

https://pswong661-eng.github.io/x-virality-board/

`data.json` is committed on purpose so Pages can serve it. It ships empty — no sample hits, roster, drafts, or leaderboard rows — until the first digest. Day targets stay at the defaults in `index.html`: 12 hits, 100,000 views, a 5,000-view hit floor, and a 10,000-view star line. `config/watchlist.json` uses the same floors (`min_views` 5000, `star_views` 10000) and timezone `Asia/Vientiane`.

## Daily refresh

Put a day's scrape at `digests/YYYY-MM-DD/composed.json` (or `watchlist_merged.json`), then:

```bash
python3 enrich_leaderboards.py
```

The script reads the operator from `data.json` and the account list from `config/watchlist.json`. Commit the updated `data.json`.

## Local preview

```bash
python3 -m http.server 8765
```

Open http://127.0.0.1:8765/. Opening `index.html` as a file blocks the `data.json` fetch. Before the first digest the page shows the empty state.
