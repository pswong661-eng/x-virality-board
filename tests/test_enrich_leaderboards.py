#!/usr/bin/env python3
"""CLI regressions for the Bugbot findings on enrich_leaderboards.py."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "enrich_leaderboards.py"
REPO_DATA = REPO / "data.json"
ENV_KEYS = (
    "XVS_DATA",
    "XVS_LEDGER",
    "XVS_DIGEST_ROOT",
    "XVS_WATCHLIST",
    "XVS_TRACKING_START",
    "XVS_OPERATOR_HANDLE",
    "XVS_OPERATOR_NAME",
    "XVS_MIN_VIEWS",
    "XVS_TIMEZONE",
)


def account(handle: str, views: int) -> dict:
    slug = handle.lstrip("@")
    return {
        "handle": handle,
        "display_name": slug,
        "views": views,
        "url": f"https://x.com/{slug}/status/1",
    }


class EnrichLeaderboardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.digests = self.root / "digests"
        self.data_path = self.root / "data.json"
        self.ledger_path = self.root / "ledger.json"
        self.watch_path = self.root / "watchlist-missing.json"
        self.data_path.write_bytes(REPO_DATA.read_bytes())
        self.repo_data = REPO_DATA.read_bytes()

    def tearDown(self) -> None:
        self.tmp.cleanup()
        stray = REPO / "leaderboard_ledger.json"
        if stray.exists():
            stray.unlink()
        if REPO_DATA.read_bytes() != self.repo_data:
            REPO_DATA.write_bytes(self.repo_data)
            raise AssertionError("enrich script wrote the repo data.json")

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        for key in ENV_KEYS:
            env.pop(key, None)
        env.update(
            {
                "XVS_DATA": str(self.data_path),
                "XVS_LEDGER": str(self.ledger_path),
                "XVS_DIGEST_ROOT": str(self.digests),
                "XVS_WATCHLIST": str(self.watch_path),
            }
        )
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=self.root,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            0,
            result.stderr or result.stdout,
        )
        self.assertNotIn("FileNotFoundError", result.stderr)
        return result

    def add_digest(self, day: str, *hits: dict) -> None:
        folder = self.digests / day
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "composed.json").write_text(
            json.dumps({"hits": list(hits)}),
            encoding="utf-8",
        )

    def load_data(self) -> dict:
        return json.loads(self.data_path.read_text(encoding="utf-8"))

    def load_ledger(self) -> dict:
        return json.loads(self.ledger_path.read_text(encoding="utf-8"))

    def script_today(self) -> str:
        zone = ZoneInfo(self.load_data().get("timezone") or "UTC")
        return datetime.now(zone).date().isoformat()

    def day_before(self, iso_day: str, days: int) -> str:
        return (datetime.fromisoformat(iso_day).date() - timedelta(days=days)).isoformat()

    def test_missing_digests_directory_does_not_crash_or_invent_a_date(self) -> None:
        original = self.data_path.read_bytes()
        result = self.run_cli()
        self.assertIn("no digest days", result.stdout)
        self.assertEqual(self.data_path.read_bytes(), original)
        self.assertFalse(self.ledger_path.exists())
        self.assertFalse(self.digests.exists())

    def test_first_digests_before_today_land_on_week_and_month(self) -> None:
        original = self.data_path.read_bytes()
        self.run_cli()
        self.assertEqual(self.data_path.read_bytes(), original)
        self.assertFalse(self.ledger_path.exists())

        today = self.script_today()
        earlier = self.day_before(today, 2)
        later = self.day_before(today, 1)
        self.add_digest(earlier, account("@early", 6000), account("@small", 4000))
        self.add_digest(later, account("@later", 8000))

        self.run_cli()
        data = self.load_data()
        ledger_days = self.load_ledger()["days"]
        week = {row["handle"]: row for row in data["leaderboards"]["week"]["entries"]}
        month = {row["handle"]: row for row in data["leaderboards"]["month"]["entries"]}

        self.assertEqual(data["date"], later)
        self.assertEqual(data["leaderboards"]["as_of"], later)
        self.assertEqual(data["leaderboards"]["tracking_start"], earlier)
        self.assertNotEqual(data["date"], today)
        self.assertEqual(set(ledger_days), {earlier, later})
        self.assertEqual(week["@early"]["views"], 6000)
        self.assertEqual(week["@early"]["hits"], 1)
        self.assertEqual(week["@later"]["views"], 8000)
        self.assertNotIn("@small", week)
        self.assertIn("@later", month)
        if earlier[:7] == later[:7]:
            self.assertEqual(month["@early"]["views"], 6000)

        self.run_cli()
        again = self.load_data()
        week_again = {
            row["handle"]: row for row in again["leaderboards"]["week"]["entries"]
        }
        self.assertEqual(set(self.load_ledger()["days"]), {earlier, later})
        self.assertEqual(week_again["@early"]["hits"], 1)
        self.assertEqual(week_again["@early"]["views"], 6000)
        self.assertEqual(week_again["@later"]["views"], 8000)

    def test_as_of_before_today_lands_on_week_and_month(self) -> None:
        today = self.script_today()
        requested = self.day_before(today, 1)
        newer = today
        self.add_digest(requested, account("@requested", 9000))
        self.add_digest(newer, account("@newer", 7000))

        self.run_cli("--as-of", requested)
        data = self.load_data()
        week = {row["handle"]: row for row in data["leaderboards"]["week"]["entries"]}
        month = {row["handle"]: row for row in data["leaderboards"]["month"]["entries"]}

        self.assertEqual(data["date"], requested)
        self.assertEqual(data["leaderboards"]["as_of"], requested)
        self.assertEqual(data["leaderboards"]["tracking_start"], requested)
        self.assertIn(requested, data["leaderboards"]["days_included"])
        self.assertIn(requested, data["leaderboards"]["month_days_included"])
        self.assertEqual(week["@requested"]["views"], 9000)
        self.assertEqual(month["@requested"]["views"], 9000)
        self.assertNotIn("@newer", week)
        self.assertNotIn(newer, self.load_ledger()["days"])

    def test_explicit_tracking_start_still_filters_earlier_digests(self) -> None:
        today = self.script_today()
        yesterday = self.day_before(today, 1)
        data = self.load_data()
        data["leaderboards"]["tracking_start"] = today
        self.data_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        pinned = self.data_path.read_bytes()
        self.add_digest(yesterday, account("@yesterday", 8000))

        self.run_cli()
        self.assertEqual(self.data_path.read_bytes(), pinned)
        self.assertFalse(self.ledger_path.exists())

        self.add_digest(today, account("@today", 7000))
        self.run_cli()
        scored = self.load_data()
        week = {row["handle"]: row for row in scored["leaderboards"]["week"]["entries"]}
        self.assertEqual(scored["date"], today)
        self.assertEqual(scored["leaderboards"]["tracking_start"], today)
        self.assertEqual(set(self.load_ledger()["days"]), {today})
        self.assertEqual(week["@today"]["views"], 7000)
        self.assertNotIn("@yesterday", week)


if __name__ == "__main__":
    unittest.main()
