"""Scrape every enabled resort in resorts.yaml and save the results under docs/data/.

Usage (from the project folder):
    python -m scraper.run                                  # all enabled resorts (in season only)
    python -m scraper.run --force                          # scrape even outside the season
    python -m scraper.run --only zao-onsen                 # one resort (any time of year)
    python -m scraper.run --only zao-onsen --html tests/fixtures/zao.html
                                                           # use a saved page instead of downloading

Files written:
    docs/data/lifts.json             small index: resorts, season summaries, which dates exist
    docs/data/seasons/2026-27.json   every day of one season (lifts and runs), no indentation

Outside the season months set in resorts.yaml, nothing is scraped. Instead, once a month
the "last_checked" time in lifts.json is updated so the daily GitHub workflow has
something to commit; GitHub switches off scheduled workflows in repositories with no
activity for 60 days.
"""

from __future__ import annotations

import argparse
import functools
import importlib
import json
import sys
import traceback
from pathlib import Path

import yaml

from scraper.common import RUN_STATUSES, STATUSES, fetch, now_jst

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "resorts.yaml"
DATA_DIR = ROOT / "docs" / "data"
INDEX_PATH = DATA_DIR / "lifts.json"

LIFT_FIELDS = ("name", "name_en", "status", "raw", "hours", "lift_type")
RUN_FIELDS = ("name", "name_en", "status", "raw", "level")


# ---------------------------------------------------------------- config

def load_settings(path: Path = CONFIG_PATH) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_config(path: Path = CONFIG_PATH) -> list[dict]:
    return load_settings(path)["resorts"]


def season_months(settings: dict) -> tuple[int, int]:
    s = settings.get("season") or {}
    return int(s.get("start_month", 11)), int(s.get("end_month", 4))


def in_season(month: int, start: int, end: int) -> bool:
    """in_season(12, 11, 4) -> True. Handles seasons that cross New Year."""
    return start <= month <= end if start <= end else month >= start or month <= end


def season_of(date: str) -> str:
    """'2026-11-27' -> '2026-27'; '2027-03-01' -> '2026-27'. Seasons run 1 July - 30 June."""
    year, month = int(date[:4]), int(date[5:7])
    start = year if month >= 7 else year - 1
    return f"{start}-{(start + 1) % 100:02d}"


# ---------------------------------------------------------------- files

def _read_json(path: Path) -> dict:
    if path.exists():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {}


def _write_json(path: Path, data: dict, compact: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        if compact:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    tmp.replace(path)  # only replace the real file once writing succeeded


def season_file(label: str) -> str:
    """Path of a season's file, relative to docs/data/ (this is what the website fetches)."""
    return f"seasons/{label}.json"


def load_index(path: Path = INDEX_PATH) -> dict:
    index = _read_json(path)
    index.setdefault("last_updated", None)   # last time lift data was scraped
    index.setdefault("last_checked", None)   # last time the scraper ran (incl. off-season check-ins)
    index.setdefault("season_months", None)
    index.setdefault("resorts", {})
    index.setdefault("seasons", {})          # label -> {file, dates, summary}
    return index


def save_index(index: dict, path: Path = INDEX_PATH) -> None:
    _write_json(path, index, compact=False)  # small, so keep it readable


def load_season(label: str, data_dir: Path = DATA_DIR) -> dict:
    season = _read_json(data_dir / season_file(label))
    season.setdefault("season", label)
    season.setdefault("days", [])
    return season


def save_season(season: dict, data_dir: Path = DATA_DIR) -> None:
    _write_json(data_dir / season_file(season["season"]), season, compact=True)


# ---------------------------------------------------------------- scraping

@functools.lru_cache(maxsize=None)
def fetch_once(url: str, method: str, referer: str | None) -> str:
    """Download each address only once per run (Hakuba Valley's page serves 3 resorts).
    Failed downloads aren't remembered, so the next resort using that page tries again."""
    return fetch(url, method, referer=referer)


def scrape_resort(resort: dict, html_override: str | None = None) -> dict:
    """Run one resort's parser and return its record for today. Never raises."""
    scraped_at = now_jst().isoformat()
    try:
        parser = importlib.import_module(f"scraper.parsers.{resort['parser']}")
        if html_override is not None:
            html = html_override
        elif resort.get("data_url"):  # resort publishes its data separately (e.g. a JSON feed)
            html = fetch_once(resort["data_url"], resort.get("fetch", "html"), resort["url"])
        else:
            html = fetch_once(resort["url"], resort.get("fetch", "html"), None)
        parsed = parser.parse(html, resort.get("options") or {})

        lifts = parsed.get("lifts") or []
        if not lifts:
            raise ValueError("No lifts found on page (the page layout may have changed)")
        for lift in lifts:
            missing = [k for k in LIFT_FIELDS if k not in lift]
            if missing or lift["status"] not in STATUSES:
                raise ValueError(f"Parser returned a bad lift record: {lift}")
        runs = parsed.get("runs") or []  # empty = resort doesn't publish runs
        for r in runs:
            missing = [k for k in RUN_FIELDS if k not in r]
            if missing or r["status"] not in RUN_STATUSES:
                raise ValueError(f"Parser returned a bad run record: {r}")

        return {
            "scraped_at": scraped_at,
            "ok": True,
            "source_updated": parsed.get("source_updated"),
            "lifts_open": sum(l["status"] == "open" for l in lifts),
            # Partly open runs count as open.
            "runs_open": sum(r["status"] in ("open", "partial") for r in runs) if runs else None,
            "snow_depth_cm": parsed.get("snow_depth_cm"),
            "new_snow_cm": parsed.get("new_snow_cm"),
            "temperature_c": parsed.get("temperature_c"),
            "lifts": [{k: l[k] for k in LIFT_FIELDS} for l in lifts],
            "runs": [{k: r[k] for k in RUN_FIELDS} for r in runs],
            # Not stored per day; moved into the season summary by update_summary().
            "_lifts_total": len(lifts),
            "_runs_total": len(runs) or None,
        }
    except Exception as e:  # one broken resort must not stop the others
        traceback.print_exc()
        return {"scraped_at": scraped_at, "ok": False, "error": f"{type(e).__name__}: {e}", "lifts": [], "runs": []}


# ---------------------------------------------------------------- saving

def store_result(season: dict, date: str, resort_id: str, result: dict) -> None:
    """Put today's result in the season's days. A re-run replaces today's entry, except
    that a failed re-run never overwrites a successful result from earlier the same day."""
    day = next((d for d in season["days"] if d["date"] == date), None)
    if day is None:
        day = {"date": date, "results": {}}
        season["days"].append(day)
        season["days"].sort(key=lambda d: d["date"])
    previous = day["results"].get(resort_id)
    if previous and previous.get("ok") and not result["ok"]:
        print(f"  keeping earlier successful result for {resort_id} today")
        return
    day["results"][resort_id] = {k: v for k, v in result.items() if not k.startswith("_")}


def update_summary(summary: dict, season: dict, resort_id: str, result: dict) -> None:
    """Recalculate one resort's season summary from all its days in that season."""
    # Totals: refreshed from today's page when it worked, otherwise kept as before.
    if result["ok"]:
        summary["lifts_total"] = result["_lifts_total"]
        if result["_runs_total"] is not None:
            summary["runs_total"] = result["_runs_total"]
    summary.setdefault("lifts_total", None)
    summary.setdefault("runs_total", None)

    days = [(d["date"], d["results"][resort_id]) for d in season["days"]
            if d["results"].get(resort_id, {}).get("ok")]
    depths = [(r["snow_depth_cm"], date) for date, r in days if r.get("snow_depth_cm") is not None]
    temps = [r["temperature_c"] for _, r in days if r.get("temperature_c") is not None]

    if depths:
        best = max(v for v, _ in depths)
        summary["snow_depth_max_cm"] = best
        summary["snow_depth_max_date"] = min(date for v, date in depths if v == best)
    else:
        summary["snow_depth_max_cm"] = summary["snow_depth_max_date"] = None
    summary["temperature_min_c"] = min(temps) if temps else None
    summary["temperature_max_c"] = max(temps) if temps else None
    summary["days_recorded"] = len(days)


def monthly_check_in(index: dict, now_iso: str) -> bool:
    """Off-season: update last_checked once per calendar month. Returns True if changed."""
    last = index.get("last_checked") or ""
    if last[:7] == now_iso[:7]:  # already checked in this month ("2027-06")
        return False
    index["last_checked"] = now_iso
    return True


# ---------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    # Windows consoles can't always print Japanese; never crash just because of a log line.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="run just this resort id (e.g. zao-onsen), even if disabled or off-season")
    ap.add_argument("--html", help="read the page from this saved file instead of downloading (needs --only)")
    ap.add_argument("--force", action="store_true", help="scrape even outside the season months")
    args = ap.parse_args(argv)

    settings = load_settings()
    start, end = season_months(settings)
    resorts = settings["resorts"]
    if args.only:
        resorts = [r for r in resorts if r["id"] == args.only]
        if not resorts:
            ap.error(f"no resort with id {args.only!r} in resorts.yaml")
    else:
        resorts = [r for r in resorts if r.get("enabled", True)]
    if args.html and not args.only:
        ap.error("--html needs --only")
    html_override = Path(args.html).read_text(encoding="utf-8") if args.html else None

    index = load_index()
    index["season_months"] = {"start": start, "end": end}
    now = now_jst()

    if not (in_season(now.month, start, end) or args.force or args.only):
        if monthly_check_in(index, now.isoformat()):
            save_index(index)
            print("Off-season: no scraping. Saved this month's check-in (keeps the GitHub schedule active).")
        else:
            print("Off-season: no scraping, and this month's check-in is already saved.")
        return 0

    today = now.date().isoformat()
    label = season_of(today)
    season = load_season(label)
    entry = index["seasons"].setdefault(label, {})
    entry["file"] = season_file(label)
    summaries = entry.setdefault("summary", {})
    failures = 0

    for resort in resorts:
        print(f"{resort['id']}: scraping {resort['url']}")
        result = scrape_resort(resort, html_override)
        index["resorts"][resort["id"]] = {
            "name": resort["name"],
            "region": resort["region"],
            "source_url": resort["url"],
        }
        store_result(season, today, resort["id"], result)
        update_summary(summaries.setdefault(resort["id"], {}), season, resort["id"], result)
        if result["ok"]:
            print(f"  ok: {result['lifts_open']}/{result['_lifts_total']} lifts open")
        else:
            failures += 1
            print(f"  FAILED: {result['error']}")

    entry["dates"] = [d["date"] for d in season["days"]]
    # Keep resorts in the same order as resorts.yaml (the website lists them in this order).
    order = [r["id"] for r in settings["resorts"]]
    index["resorts"] = dict(sorted(index["resorts"].items(),
                                   key=lambda kv: order.index(kv[0]) if kv[0] in order else len(order)))
    index["seasons"] = dict(sorted(index["seasons"].items()))
    index["last_updated"] = index["last_checked"] = now_jst().isoformat()

    save_season(season)
    save_index(index)
    print(f"Saved docs/data/{season_file(label)} and docs/data/lifts.json "
          f"({len(resorts) - failures} ok, {failures} failed)")
    # Exit with an error only if nothing worked, so partial results still get committed.
    return 1 if resorts and failures == len(resorts) else 0


if __name__ == "__main__":
    sys.exit(main())
