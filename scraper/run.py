"""Scrape every enabled resort in resorts.yaml and save the results under docs/data/.

Usage (from the project folder):
    python -m scraper.run                                  # all enabled resorts (in season only)
    python -m scraper.run --daily                          # also rewrite today's daily record now
    python -m scraper.run --force                          # scrape even outside the season
    python -m scraper.run --only zao-onsen                 # one resort (any time of year)
    python -m scraper.run --only zao-onsen --html tests/fixtures/zao.html
                                                           # use a saved page instead of downloading

GitHub runs this every 30 minutes from 07:00 to 21:00 Japan time. Every run:
    - updates docs/data/live.json with the latest lift and run status (only if something
      changed; the file is replaced, not added to)
and the first run at or after daily_time (09:30, set in resorts.yaml) each day also:
    - writes the day's permanent record (lifts, runs, snow depth, new snow) to
      docs/data/seasons/<season>.json, adds the weather (scraper/weather.py) and
      updates the season summary in docs/data/lifts.json

Files written:
    docs/data/lifts.json             small index: resorts, season summaries, which dates exist
    docs/data/seasons/2026-27.json   every day of one season (lifts and runs), no indentation
    docs/data/live.json              the latest lift/run status (today only)

Outside the season months set in resorts.yaml, nothing is scraped. Instead, once a month
the "last_checked" time in lifts.json is updated so the GitHub workflow has something to
commit; GitHub switches off scheduled workflows in repositories with no activity for 60 days.
"""

from __future__ import annotations

import argparse
import functools
import importlib
import json
import sys
import traceback
from datetime import date, timedelta
from pathlib import Path

import yaml

from scraper.common import RUN_STATUSES, STATUSES, fetch, now_jst
from scraper.weather import LEVELS, PAST_DAYS, apply_temps, fetch_weather, has_location

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "resorts.yaml"
DATA_DIR = ROOT / "docs" / "data"
INDEX_PATH = DATA_DIR / "lifts.json"
LIVE_PATH = DATA_DIR / "live.json"     # latest lift/run status, replaced on every run

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

def store_result(season: dict, date: str, resort_id: str, result: dict) -> bool:
    """Put today's result in the season's days. A re-run replaces today's entry, except
    that it never overwrites a successful result from earlier the same day with a failure
    or with a shorter lift list (some sites, e.g. Hakuba Valley, drop lifts from their page
    later in the day). Returns False if the earlier result was kept."""
    day = next((d for d in season["days"] if d["date"] == date), None)
    if day is None:
        day = {"date": date, "results": {}}
        season["days"].append(day)
        season["days"].sort(key=lambda d: d["date"])
    previous = day["results"].get(resort_id)
    if previous and previous.get("ok"):
        if not result["ok"]:
            print(f"  keeping earlier successful result for {resort_id} today")
            return False
        if len(result["lifts"]) < len(previous["lifts"]):
            print(f"  keeping earlier result for {resort_id} today "
                  f"({len(previous['lifts'])} lifts; this run found only {len(result['lifts'])})")
            result["_lifts_total"] = len(previous["lifts"])
            return False
    day["results"][resort_id] = {k: v for k, v in result.items() if not k.startswith("_")}
    return True


def update_summary(summary: dict, season: dict, resort_id: str, result: dict | None) -> None:
    """Recalculate one resort's season summary from all its days in that season.
    `result` is today's scrape (None when only temperatures were updated)."""
    # Totals: refreshed from today's page when it worked, otherwise kept as before.
    if result and result["ok"]:
        summary["lifts_total"] = result["_lifts_total"]
        if result["_runs_total"] is not None:
            summary["runs_total"] = result["_runs_total"]
    summary.setdefault("lifts_total", None)
    summary.setdefault("runs_total", None)

    days = [(d["date"], d["results"][resort_id]) for d in season["days"]
            if d["results"].get(resort_id, {}).get("ok")]
    depths = [(r["snow_depth_cm"], date) for date, r in days if r.get("snow_depth_cm") is not None]

    if depths:
        best = max(v for v, _ in depths)
        summary["snow_depth_max_cm"] = best
        summary["snow_depth_max_date"] = min(date for v, date in depths if v == best)
    else:
        summary["snow_depth_max_cm"] = summary["snow_depth_max_date"] = None

    # Season temperature range at summit and base, from the FINAL daily lows/highs only
    # (forecasts don't count). Uses every recorded day, even if that day's scrape failed.
    finals = [r["temps"] for d in season["days"] if (r := d["results"].get(resort_id))
              and (r.get("temps") or {}).get("kind") == "final"]
    for level in LEVELS:
        lows = [t[level]["min_c"] for t in finals if level in t]
        highs = [t[level]["max_c"] for t in finals if level in t]
        means = [t[level]["mean_c"] for t in finals if level in t and t[level].get("mean_c") is not None]
        summary[f"{level}_min_c"] = min(lows) if lows else None
        summary[f"{level}_max_c"] = max(highs) if highs else None
        # Coldest and warmest daily MEAN of the season (website compares a past day's mean to these).
        summary[f"{level}_lowest_mean_c"] = min(means) if means else None
        summary[f"{level}_highest_mean_c"] = max(means) if means else None
    summary.pop("temperature_min_c", None)  # older format (morning readings), replaced by the above
    summary.pop("temperature_max_c", None)

    # New snow reported by the resort: smallest, largest and average daily amount this season.
    new = [r["new_snow_cm"] for _, r in days if r.get("new_snow_cm") is not None]
    summary["new_snow_min_cm"] = min(new) if new else None
    summary["new_snow_max_cm"] = max(new) if new else None
    summary["new_snow_mean_cm"] = round(sum(new) / len(new), 1) if new else None
    summary["days_recorded"] = len(days)


def update_weather(season: dict, resorts: list[dict], today: str) -> set[str]:
    """Add today's forecast and snow outlook, and yesterday's (and any missed day's) final
    temperatures and snow hours. Never fails the run: if Open-Meteo can't be reached, the
    next run catches up. Returns the ids of resorts whose weather changed."""
    try:
        temps = fetch_weather(resorts)
    except Exception as e:
        print(f"Weather: couldn't get temperatures from Open-Meteo ({type(e).__name__}: {e}); "
              f"will catch up next run.")
        return set()
    changed = set()
    for resort in resorts:
        dates = apply_temps(season, resort, temps.get(resort["id"], {}), today)
        if dates:
            changed.add(resort["id"])
    print(f"Weather: temperatures updated for {len(changed)} resorts.")
    return changed


def has_pending_forecasts(season: dict, today: str) -> bool:
    """Any recent past day still holding a forecast instead of final temperatures?"""
    oldest = (date.fromisoformat(today) - timedelta(days=PAST_DAYS)).isoformat()
    return any(oldest <= d["date"] < today and (r.get("temps") or {}).get("kind") == "forecast"
               for d in season["days"] for r in d["results"].values())


def monthly_check_in(index: dict, now_iso: str) -> bool:
    """Off-season: update last_checked once per calendar month. Returns True if changed."""
    last = index.get("last_checked") or ""
    if last[:7] == now_iso[:7]:  # already checked in this month ("2027-06")
        return False
    index["last_checked"] = now_iso
    return True


# ---------------------------------------------------------------- live lift/run status

def live_entry(result: dict) -> dict:
    """What live.json keeps per resort: just the lift and run status (no snow or weather)."""
    if not result["ok"]:
        return {"ok": False, "error": result["error"]}
    return {"ok": True, "lifts_open": result["lifts_open"], "runs_open": result["runs_open"],
            "lifts": result["lifts"], "runs": result["runs"]}


def update_live(results: dict[str, dict], today: str, now_iso: str, path: Path = LIVE_PATH,
                baseline: dict[str, dict] | None = None) -> bool:
    """Replace live.json with this run's lift/run status. Same safeguards as the daily record:
    a resort that failed, or returned fewer lifts than earlier today (Hakuba Valley's afternoon
    page), keeps its earlier entry from today. `baseline` (today's permanent record) counts as
    "earlier today" for resorts live.json doesn't have yet. The file is only rewritten when a
    status actually changed, so quiet runs don't create a commit. Returns True if rewritten."""
    old = _read_json(path)
    same_day = old.get("date") == today
    previous = old.get("results", {}) if same_day else {}
    entries = {}
    for rid, result in results.items():
        new, prev = live_entry(result), previous.get(rid) or (baseline or {}).get(rid)
        if prev and prev.get("ok") and (not new["ok"] or len(new["lifts"]) < len(prev["lifts"])):
            new = prev
        entries[rid] = new
    for rid, prev in previous.items():  # resorts not scraped this run (e.g. --only) stay as they were
        entries.setdefault(rid, prev)

    def comparable(e):  # error wording may vary between runs; only ok/lifts/runs matter
        return {rid: {k: v for k, v in x.items() if k != "error"} for rid, x in e.items()}

    if same_day and comparable(entries) == comparable(previous):
        return False
    _write_json(path, {"date": today, "updated": now_iso, "results": entries}, compact=True)
    return True


def daily_due(season: dict, today: str, now_hhmm: str, daily_time: str) -> bool:
    """The day's permanent record is written by the first run at or after daily_time
    (09:30) that day. GitHub sometimes starts runs late, so this doesn't need an exact time."""
    return now_hhmm >= daily_time and not any(d["date"] == today for d in season["days"])


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
    ap.add_argument("--daily", action="store_true",
                    help="also (re)write today's permanent daily record now, whatever the time")
    args = ap.parse_args(argv)

    settings = load_settings()
    start, end = season_months(settings)
    daily_time = str((settings.get("season") or {}).get("daily_time", "09:30"))
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
    index["daily_time"] = daily_time
    now = now_jst()

    today = now.date().isoformat()
    label = season_of(today)

    if not (in_season(now.month, start, end) or args.force or args.only):
        changed_files = False
        # First off-season days: the last season days still hold a forecast; finish them.
        season = load_season(label)
        if has_pending_forecasts(season, today):
            changed = update_weather(season, resorts, today)
            summaries = index["seasons"].get(label, {}).get("summary", {})
            for rid in changed:
                update_summary(summaries.setdefault(rid, {}), season, rid, None)
            if changed:
                save_season(season)
                changed_files = True
        if monthly_check_in(index, now.isoformat()):
            print("Off-season: no scraping. Saved this month's check-in (keeps the GitHub schedule active).")
            changed_files = True
        else:
            print("Off-season: no scraping, and this month's check-in is already saved.")
        if changed_files:
            save_index(index)
        return 0

    season = load_season(label)
    write_daily = args.daily or args.only or daily_due(season, today, now.strftime("%H:%M"), daily_time)
    print(f"{now.strftime('%H:%M')} JST: lift/run status for all resorts"
          f"{' + daily record (snow, weather, history)' if write_daily else ''}")

    # 1. Scrape every resort (lift and run status, and the daily numbers).
    results, failures = {}, 0
    for resort in resorts:
        print(f"{resort['id']}: scraping {resort['url']}")
        result = results[resort["id"]] = scrape_resort(resort, html_override)
        if result["ok"]:
            print(f"  ok: {result['lifts_open']}/{result['_lifts_total']} lifts open")
        else:
            failures += 1
            print(f"  FAILED: {result['error']}")

    # 2. Live status: replace live.json if anything changed. Today's permanent record (if
    #    already written) is the fallback "earlier reading" for the safeguards.
    today_record = next((d["results"] for d in season["days"] if d["date"] == today), {})
    baseline = {rid: live_entry(dict(r, error=r.get("error"))) for rid, r in today_record.items()
                if r.get("ok") and "lifts" in r}
    live_changed = update_live(results, today, now.isoformat(), baseline=baseline)
    print("Live status: changed, live.json updated." if live_changed else "Live status: no change.")

    # 3. Once a day: the permanent record, weather and season summary.
    if write_daily:
        entry = index["seasons"].setdefault(label, {})
        entry["file"] = season_file(label)
        summaries = entry.setdefault("summary", {})
        for resort in resorts:
            index["resorts"][resort["id"]] = {
                "name": resort["name"],
                "region": resort["region"],
                "source_url": resort["url"],
                **({"website": resort["website"]} if resort.get("website") else {}),
                **({"map": resort["map"]} if resort.get("map") else {}),
                # Position and heights: the website uses them to fetch live temperatures.
                **({"location": {"lat": resort["location"]["lat"], "lon": resort["location"]["lon"]},
                    "elevation_m": {level: resort["elevation"][level] for level in LEVELS}}
                   if has_location(resort) else {}),
            }
            store_result(season, today, resort["id"], results[resort["id"]])

        # Temperatures (needs today's records to exist), then the season summaries.
        update_weather(season, resorts, today)
        for resort in resorts:
            update_summary(summaries.setdefault(resort["id"], {}), season, resort["id"], results[resort["id"]])

        entry["dates"] = [d["date"] for d in season["days"]]
        # Keep resorts in the same order as resorts.yaml (the website lists them in this order).
        order = [r["id"] for r in settings["resorts"]]
        index["resorts"] = dict(sorted(index["resorts"].items(),
                                       key=lambda kv: order.index(kv[0]) if kv[0] in order else len(order)))
        index["seasons"] = dict(sorted(index["seasons"].items()))
        index["last_updated"] = index["last_checked"] = now_jst().isoformat()
        save_season(season)
        save_index(index)
        print(f"Saved docs/data/{season_file(label)} and docs/data/lifts.json")

    print(f"{len(resorts) - failures} ok, {failures} failed")
    # Exit with an error only if nothing worked, so partial results still get committed.
    return 1 if resorts and failures == len(resorts) else 0


if __name__ == "__main__":
    sys.exit(main())
