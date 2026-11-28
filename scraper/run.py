"""Scrape the enabled resorts in resorts.yaml and save the results under docs/data/.

Usage (from the project folder):
    python -m scraper.run                                  # resorts whose local time is 09:00-21:00
    python -m scraper.run --daily                          # also rewrite today's daily record now
    python -m scraper.run --force                          # every resort now, even off-season / at night
    python -m scraper.run --only zao-onsen                 # one resort (any time of year)
    python -m scraper.run --only zao-onsen --html tests/fixtures/zao.html
                                                           # use a saved page instead of downloading
    python -m scraper.run --needs-browser                  # print "yes" if a resort due now needs Playwright

GitHub starts this every 45 minutes around the clock. Each run only scrapes the resorts whose
LOCAL time is inside the schedule (09:00-21:00, set in resorts.yaml) and whose group is in
season. For each of them, every run:
    - updates its group's live file (e.g. docs/data/live-europe.json) with the latest lift and
      run status (only if something changed; the file is replaced, not added to)
and the first run at or after daily_time (09:30 local) each day also:
    - writes the resort's permanent record for that day (lifts, runs, snow depth, new snow)
      to its group's season file, adds the weather (scraper/weather.py) and updates the
      season summary in docs/data/lifts.json

Files written (one set per group in resorts.yaml: japan, europe, north-america):
    docs/data/lifts.json                          small index: groups, resorts, season summaries
    docs/data/seasons/2026-27.json                Japan: every day of one season, no indentation
    docs/data/seasons/europe/2026-27.json         Europe: the same
    docs/data/live.json, live-europe.json, ...    the latest lift/run status per group

When every group is off-season, nothing is scraped. Instead, once a month the "last_checked"
time in lifts.json is updated so the GitHub workflow has something to commit; GitHub switches
off scheduled workflows in repositories with no activity for 60 days.
"""

from __future__ import annotations

import argparse
import functools
import importlib
import json
import sys
import traceback
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

from scraper import alerts
from scraper.common import RUN_STATUSES, STATUSES, fetch
from scraper.weather import LEVELS, PAST_DAYS, apply_temps, fetch_weather, has_location

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "resorts.yaml"
DATA_DIR = ROOT / "docs" / "data"
INDEX_PATH = DATA_DIR / "lifts.json"
LIVE_PATH = DATA_DIR / "live.json"     # Japan's latest lift/run status, replaced on every run
SEASON_PATTERN = "seasons/{season}.json"

LIFT_FIELDS = ("name", "name_en", "status", "raw", "hours", "lift_type")
RUN_FIELDS = ("name", "name_en", "status", "raw", "level")

# Used when resorts.yaml has no `groups` (older config): everything is one Japanese group.
DEFAULT_GROUPS = {"japan": {"name": "Japan", "country": "Japan", "timezone": "Asia/Tokyo",
                            "live_file": "live.json", "season_file": SEASON_PATTERN,
                            "season": {"start_month": 11, "end_month": 5}}}
DEFAULT_SCHEDULE = {"hours": ["09:00", "21:00"], "until": "22:00", "daily_time": "09:30"}


# ---------------------------------------------------------------- config

def load_settings(path: Path = CONFIG_PATH) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def groups_of(settings: dict) -> dict[str, dict]:
    groups = settings.get("groups") or DEFAULT_GROUPS
    if "season" in settings and "groups" not in settings:  # older config: one season block
        groups = {"japan": dict(DEFAULT_GROUPS["japan"], season=settings["season"])}
    return groups


def schedule_of(settings: dict) -> dict:
    s = dict(DEFAULT_SCHEDULE, **(settings.get("schedule") or {}))
    if "daily_time" in (settings.get("season") or {}):  # older config
        s["daily_time"] = settings["season"]["daily_time"]
    return s


def resolve(resort: dict, groups: dict[str, dict]) -> dict:
    """The resort with its group's defaults filled in (group, country, timezone)."""
    r = dict(resort)
    r.setdefault("group", next(iter(groups)))
    if r["group"] not in groups:
        raise ValueError(f"{r['id']}: unknown group {r['group']!r}")
    g = groups[r["group"]]
    r.setdefault("country", g.get("country") or "")
    r.setdefault("timezone", g.get("timezone") or "UTC")
    return r


def load_config(path: Path = CONFIG_PATH) -> list[dict]:
    settings = load_settings(path)
    groups = groups_of(settings)
    return [resolve(r, groups) for r in settings["resorts"]]


def season_months(group: dict) -> tuple[int, int]:
    s = group.get("season") or {}
    return int(s.get("start_month", 11)), int(s.get("end_month", 4))


def in_season(month: int, start: int, end: int) -> bool:
    """in_season(12, 11, 4) -> True. Handles seasons that cross New Year."""
    return start <= month <= end if start <= end else month >= start or month <= end


def in_hours(hhmm: str, schedule: dict) -> bool:
    """Inside the scraping hours (local time): from hours[0] until `until` (runs start late)."""
    return schedule["hours"][0] <= hhmm <= schedule.get("until", schedule["hours"][1])


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


def season_file(label: str, pattern: str = SEASON_PATTERN) -> str:
    """Path of a season's file, relative to docs/data/ (this is what the website fetches)."""
    return pattern.format(season=label)


# Paths default to None and are looked up when called, so DATA_DIR / INDEX_PATH can be pointed
# elsewhere (e.g. a copy of the site) after importing this module.

def load_index(path: Path | None = None) -> dict:
    index = _read_json(path or INDEX_PATH)
    index.setdefault("last_updated", None)   # last time lift data was scraped
    index.setdefault("last_checked", None)   # last time the scraper ran (incl. off-season check-ins)
    index.setdefault("resorts", {})
    index.setdefault("seasons", {})          # label -> {files, dates, summary}
    return index


def save_index(index: dict, path: Path | None = None) -> None:
    _write_json(path or INDEX_PATH, index, compact=False)  # small, so keep it readable


def load_season(label: str, data_dir: Path | None = None, pattern: str = SEASON_PATTERN) -> dict:
    season = _read_json((data_dir or DATA_DIR) / season_file(label, pattern))
    season.setdefault("season", label)
    season.setdefault("days", [])
    return season


def save_season(season: dict, data_dir: Path | None = None, pattern: str = SEASON_PATTERN) -> None:
    _write_json((data_dir or DATA_DIR) / season_file(season["season"], pattern), season, compact=True)


# ---------------------------------------------------------------- scraping

@functools.lru_cache(maxsize=None)
def fetch_once(url: str, method: str, referer: str | None, data: str | None = None) -> str:
    """Download each address only once per run (Hakuba Valley's page serves 3 resorts).
    Failed downloads aren't remembered, so the next resort using that page tries again."""
    return fetch(url, method, referer=referer, data=data)


def scrape_resort(resort: dict, html_override: str | None = None, now: datetime | None = None) -> dict:
    """Run one resort's parser and return its record for today. Never raises."""
    now = now or datetime.now(ZoneInfo(resort.get("timezone") or "Asia/Tokyo")).replace(microsecond=0)
    scraped_at = now.isoformat()
    try:
        parser = importlib.import_module(f"scraper.parsers.{resort['parser']}")
        method = resort.get("fetch", "html")
        if html_override is not None:
            html = html_override
        elif resort.get("data_url"):  # resort publishes its data separately (e.g. a JSON feed)
            html = fetch_once(resort["data_url"], method, resort["url"])
        else:
            html = fetch_once(resort["url"], method, None)
        parsed = parser.parse(html, resort.get("options") or {})

        # Some resorts publish run status (runs_url) or the snow report (snow_url) on a separate
        # page. If that page fails, the lifts are still recorded, just without it.
        if resort.get("runs_url") and html_override is None:
            try:
                runs_html = fetch_once(resort["runs_url"], method, resort["url"])
                parsed["runs"] = parser.parse_runs(runs_html, resort.get("options") or {})
            except Exception as e:
                print(f"  runs page failed ({type(e).__name__}: {e}); recording lifts only")
        if resort.get("snow_url") and html_override is None:
            try:
                # snow_post: send this form body (POST) instead of a GET; snow_fetch: html/browser
                text = fetch_once(resort["snow_url"], resort.get("snow_fetch", method), resort["url"], resort.get("snow_post"))
                snow = parser.parse_snow(text, resort.get("options") or {})
                parsed.update({k: v for k, v in snow.items() if v is not None})
            except Exception as e:
                print(f"  snow report failed ({type(e).__name__}: {e}); recording without it")

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

    # Season averages (shown in the Historical tab's search): mean of the daily means, and
    # mean snow depth.
    for level in LEVELS:
        means = [t[level]["mean_c"] for t in finals if level in t and t[level].get("mean_c") is not None]
        summary[f"{level}_mean_c"] = round(sum(means) / len(means), 1) if means else None
    summary["snow_depth_mean_cm"] = round(sum(v for v, _ in depths) / len(depths), 1) if depths else None

    # New snow reported by the resort: smallest, largest and average daily amount this season.
    new = [r["new_snow_cm"] for _, r in days if r.get("new_snow_cm") is not None]
    summary["new_snow_min_cm"] = min(new) if new else None
    summary["new_snow_max_cm"] = max(new) if new else None
    summary["new_snow_mean_cm"] = round(sum(new) / len(new), 1) if new else None
    summary["days_recorded"] = len(days)


def update_weather(seasons: dict[str, dict], resorts: list[dict], today_of: dict[str, str]) -> set[str]:
    """Add today's forecast and snow outlook, and yesterday's (and any missed day's) final
    temperatures and snow hours. `seasons` and `today_of` are per resort id (each resort's
    season file and local date). Never fails the run: if Open-Meteo can't be reached, the
    next run catches up. Returns the ids of resorts whose weather changed."""
    if not resorts:
        return set()
    try:
        temps = fetch_weather(resorts)
    except Exception as e:
        print(f"Weather: couldn't get temperatures from Open-Meteo ({type(e).__name__}: {e}); "
              f"will catch up next run.")
        return set()
    changed = set()
    for resort in resorts:
        rid = resort["id"]
        if apply_temps(seasons[rid], resort, temps.get(rid, {}), today_of[rid]):
            changed.add(rid)
    print(f"Weather: temperatures updated for {len(changed)} resorts.")
    return changed


def has_pending_forecasts(season: dict, today: str, resort_ids: set[str] | None = None) -> bool:
    """Any recent past day still holding a forecast instead of final temperatures?"""
    oldest = (date.fromisoformat(today) - timedelta(days=PAST_DAYS)).isoformat()
    return any(oldest <= d["date"] < today and (r.get("temps") or {}).get("kind") == "forecast"
               and (resort_ids is None or rid in resort_ids)
               for d in season["days"] for rid, r in d["results"].items())


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


def _comparable(entry: dict) -> dict:
    """Error wording varies between runs, and `changed` is bookkeeping: only the rest counts."""
    return {k: v for k, v in entry.items() if k not in ("error", "changed")}


def update_live(results: dict[str, dict], today: str | dict[str, str], now_iso: str, path: Path | None = None,
                baseline: dict[str, dict] | None = None) -> bool:
    """Update a group's live file with this run's lift/run status. `today` is the local date
    (one for all, or per resort id). Same safeguards as the daily record: a resort that
    failed, or returned fewer lifts than earlier the same (local) day (Hakuba Valley's
    afternoon page), keeps its earlier entry. `baseline` (today's permanent record) counts as
    "earlier today" for resorts the file doesn't have yet. Resorts not scraped this run (e.g.
    it's night there) keep their entry. Each entry has its local `date` and `changed` (when its
    status last changed). The file is only rewritten when a status actually changed, so quiet
    runs don't create a commit. Returns True if rewritten.

    A resort whose page can't be read gets "failing_since": the time of the first failed run
    in a row (kept across midnight, removed once the page works again). The website uses it
    to warn that the status shown may be out of date; scraper/alerts.py opens an issue when
    it has lasted for hours."""
    path = path or LIVE_PATH
    old = _read_json(path)
    old_entries = {rid: ({"date": old.get("date"), **e} if "date" not in e and old.get("date") else e)
                   for rid, e in (old.get("results") or {}).items()}
    entries = dict(old_entries)
    for rid, result in results.items():
        day = today if isinstance(today, str) else today[rid]
        old_e = old_entries.get(rid) or {}
        prev = (old_e if old_e.get("date") == day else None) or (baseline or {}).get(rid)
        new = live_entry(result)
        if prev and prev.get("ok") and (not new["ok"] or len(new["lifts"]) < len(prev["lifts"])):
            new = {k: v for k, v in prev.items() if k not in ("date", "changed", "open_today")}
        new.pop("failing_since", None)
        new.pop("error", None)
        if not result["ok"]:
            new["failing_since"] = old_e.get("failing_since") or now_iso
            new["error"] = result["error"]
        new["date"] = day
        # Lifts and runs seen open at any check this (local) day: after closing time the website
        # keeps showing them as open, with a note that they're closed for the day.
        seen = ((old_e.get("open_today") if old_e.get("date") == day else None)
                or open_names((baseline or {}).get(rid) or {}))
        now_open = open_names(new)
        open_today = {k: sorted(set(seen.get(k, [])) | set(now_open.get(k, []))) for k in ("lifts", "runs")}
        if open_today["lifts"] or open_today["runs"]:
            new["open_today"] = open_today
        else:
            new.pop("open_today", None)
        new["changed"] = old_e.get("changed") or old.get("updated") or now_iso \
            if _comparable(new) == _comparable(old_e) else now_iso
        entries[rid] = new

    if old_entries and {r: _comparable(e) for r, e in entries.items()} == \
            {r: _comparable(e) for r, e in old_entries.items()}:
        return False
    dates = [e["date"] for e in entries.values() if e.get("date")]
    _write_json(path, {"date": max(dates) if dates else None, "updated": now_iso, "results": entries}, compact=True)
    return True


def open_names(entry: dict) -> dict[str, list[str]]:
    """Names of the lifts open and the runs open (or partly open) in a live entry."""
    if not entry.get("ok"):
        return {}
    return {"lifts": [l["name"] for l in entry.get("lifts") or [] if l.get("status") == "open" and l.get("name")],
            "runs": [r["name"] for r in entry.get("runs") or [] if r.get("status") in ("open", "partial") and r.get("name")]}


def daily_due(season: dict, today: str, now_hhmm: str, daily_time: str, resort_id: str | None = None) -> bool:
    """The day's permanent record is written by the first run at or after daily_time
    (09:30 local) that day. GitHub sometimes starts runs late, so this doesn't need an exact
    time. With `resort_id`: due if that resort has no record today yet."""
    if now_hhmm < daily_time:
        return False
    day = next((d for d in season["days"] if d["date"] == today), None)
    return day is None or (resort_id is not None and resort_id not in day["results"])


def resort_info(resort: dict) -> dict:
    """What lifts.json lists about a resort (from resorts.yaml)."""
    return {
        "name": resort["name"],
        "region": resort["region"],
        "country": resort.get("country") or "",
        "group": resort["group"],
        "timezone": resort["timezone"],
        "source_url": resort["url"],
        **({"website": resort["website"]} if resort.get("website") else {}),
        **({"map": resort["map"]} if resort.get("map") else {}),
        # Night skiing per season (dates, hours, lifts), from resorts.yaml.
        **({"night_skiing": {str(k): {kk: (vv if isinstance(vv, list) else str(vv)) for kk, vv in v.items()}
                             for k, v in resort["night_skiing"].items()}}
           if resort.get("night_skiing") else {}),
        # Position and heights: the website uses them to fetch live temperatures.
        **({"location": {"lat": resort["location"]["lat"], "lon": resort["location"]["lon"]},
            "elevation_m": {level: resort["elevation"][level] for level in LEVELS}}
           if has_location(resort) else {}),
    }


def groups_info(groups: dict[str, dict], schedule: dict) -> dict:
    """What lifts.json lists about the groups (the website loads each group's files)."""
    return {g: {"name": v.get("name", g), "live": v["live_file"],
                "season_months": dict(zip(("start", "end"), season_months(v)))}
            for g, v in groups.items()}


# ---------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    # Windows consoles can't always print Japanese; never crash just because of a log line.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="run just this resort id (e.g. zao-onsen), even if disabled or off-season")
    ap.add_argument("--html", help="read the page from this saved file instead of downloading (needs --only)")
    ap.add_argument("--force", action="store_true", help="scrape every resort now, even off-season or at night")
    ap.add_argument("--daily", action="store_true",
                    help="also (re)write today's permanent daily record now, whatever the time")
    ap.add_argument("--alerts", metavar="FILE",
                    help="write problems (resorts failing for hours, missing lifts/runs) to FILE "
                         "for scraper/alerts.py, which opens GitHub issues")
    ap.add_argument("--needs-browser", action="store_true",
                    help="only print yes/no: does a resort due now use fetch: browser (Playwright)?")
    args = ap.parse_args(argv)

    settings = load_settings()
    groups, schedule = groups_of(settings), schedule_of(settings)
    daily_time = schedule["daily_time"]
    every = [resolve(r, groups) for r in settings["resorts"]]
    if args.only:
        resorts = [r for r in every if r["id"] == args.only]
        if not resorts:
            ap.error(f"no resort with id {args.only!r} in resorts.yaml")
    else:
        resorts = [r for r in every if r.get("enabled", True)]
    if args.html and not args.only:
        ap.error("--html needs --only")
    html_override = Path(args.html).read_text(encoding="utf-8") if args.html else None

    now_utc = datetime.now(timezone.utc).replace(microsecond=0)
    local = {r["id"]: now_utc.astimezone(ZoneInfo(r["timezone"])) for r in resorts}
    today_of = {rid: t.date().isoformat() for rid, t in local.items()}

    def group_in_season(r: dict) -> bool:
        return in_season(local[r["id"]].month, *season_months(groups[r["group"]]))

    due = [r for r in resorts if args.only or args.force
           or (group_in_season(r) and in_hours(local[r["id"]].strftime("%H:%M"), schedule))]
    if args.needs_browser:
        print("yes" if any(r.get("fetch") == "browser" for r in due) else "no")
        return 0

    index = load_index()
    index["groups"] = groups_info(groups, schedule)
    index["schedule"] = {"hours": schedule["hours"], "daily_time": daily_time}
    index.pop("season_months", None)  # older format (one season for all); now per group
    index["daily_time"] = daily_time

    # Season files touched this run: (group, label) -> season
    seasons: dict[tuple[str, str], dict] = {}

    def season_for(r: dict) -> dict:
        key = (r["group"], season_of(today_of[r["id"]]))
        if key not in seasons:
            seasons[key] = load_season(key[1], pattern=groups[r["group"]]["season_file"])
        return seasons[key]

    if not due:
        return off_season_or_night(index, resorts, groups, group_in_season, season_for, seasons,
                                   today_of, now_utc)

    print(f"{now_utc.strftime('%H:%M')} UTC: {len(due)} resorts due "
          f"({', '.join(sorted({groups[r['group']].get('name', r['group']) for r in due}))})")

    # 1. Scrape (lift and run status, and the daily numbers).
    results, failures = {}, 0
    for resort in due:
        rid = resort["id"]
        print(f"{rid} ({local[rid].strftime('%H:%M')} local): scraping {resort['url']}")
        result = results[rid] = scrape_resort(resort, html_override, local[rid])
        if result["ok"]:
            print(f"  ok: {result['lifts_open']}/{result['_lifts_total']} lifts open")
        else:
            failures += 1
            print(f"  FAILED: {result['error']}")

    problems, checked, written = [], [], []
    for g, group in groups.items():
        gres = [r for r in due if r["group"] == g]
        if not gres:
            continue
        # 2. Live status: update the group's live file if anything changed. Today's permanent
        #    record (if already written) is the fallback "earlier reading" for the safeguards.
        baseline = {}
        for r in gres:
            day = next((d for d in season_for(r)["days"] if d["date"] == today_of[r["id"]]), None)
            rec = (day or {}).get("results", {}).get(r["id"])
            if rec and rec.get("ok") and "lifts" in rec:
                baseline[r["id"]] = live_entry(dict(rec, error=rec.get("error")))
        live_path = DATA_DIR / group["live_file"]
        changed = update_live({r["id"]: results[r["id"]] for r in gres}, {r["id"]: today_of[r["id"]] for r in gres},
                              now_utc.isoformat(), live_path, baseline=baseline)
        print(f"Live status ({g}): {'changed, ' + group['live_file'] + ' updated' if changed else 'no change'}.")

        # Problems worth an alert: a resort failing for hours (any run); far fewer lifts/runs
        # than usual (daily record only, so Hakuba's shorter afternoon page doesn't count).
        live_now = _read_json(live_path).get("results", {})
        for r in gres:
            rid, result, season = r["id"], results[r["id"]], season_for(r)
            if p := alerts.down_problem(r, live_now.get(rid), now_utc):
                problems.append(p)
            is_daily = bool(args.daily or args.only
                            or daily_due(season, today_of[rid], local[rid].strftime("%H:%M"), daily_time, rid))
            if result["ok"]:
                checked.append(f"down:{rid}")
                if is_daily:
                    checked += [f"drop-lifts:{rid}", f"drop-runs:{rid}"]
                    problems += alerts.drop_problems(r, result, season, today_of[rid])
            if is_daily:  # 3. the resort's permanent record for today
                store_result(season, today_of[rid], rid, result)
                written.append(r)
    for p in problems:
        print(f"ALERT: {p['title']}")

    # 4. Weather and season summaries for the resorts recorded today (and any whose record for
    #    today still has no temperatures, e.g. Open-Meteo timed out on an earlier run); save.
    def record_today(r: dict) -> dict | None:
        day = next((d for d in season_for(r)["days"] if d["date"] == today_of[r["id"]]), None)
        return (day or {}).get("results", {}).get(r["id"])
    no_temps = [r for r in due if r not in written and (rec := record_today(r)) is not None and not rec.get("temps")]
    if written or no_temps:
        weathered = update_weather({r["id"]: season_for(r) for r in written + no_temps}, written + no_temps, today_of)
        written += [r for r in no_temps if r["id"] in weathered]
        for r in written:
            summaries = index["seasons"].setdefault(season_of(today_of[r["id"]]), {}).setdefault("summary", {})
            update_summary(summaries.setdefault(r["id"], {}), season_for(r), r["id"], results[r["id"]])
        for (g, label), season in seasons.items():
            save_season(season, pattern=groups[g]["season_file"])
            entry = index["seasons"].setdefault(label, {})
            files = entry.setdefault("files", {})
            files[g] = season_file(label, groups[g]["season_file"])
            if g == "japan":
                entry["file"] = files[g]  # older website versions read this
            by_group = entry.setdefault("dates_by_group", {})
            if "japan" not in by_group and entry.get("dates") and entry.get("file"):
                by_group["japan"] = entry["dates"]  # older index: dates were Japan's
            by_group[g] = [d["date"] for d in season["days"]]
            entry["dates"] = sorted({d for ds in by_group.values() for d in ds})
            print(f"Saved docs/data/{files[g]}")
        refresh_resorts(index, every, settings.get("areas"))
        index["last_updated"] = index["last_checked"] = now_utc.isoformat()
        save_index(index)
        print("Saved docs/data/lifts.json")

    if args.alerts:
        alerts.write_report(Path(args.alerts), problems, checked, now_utc.isoformat())
    print(f"{len(due) - failures} ok, {failures} failed")
    # Exit with an error only if nothing worked, so partial results still get committed.
    return 1 if due and failures == len(due) else 0


def area_info(area: dict, every: list[dict]) -> dict:
    """What lifts.json lists about a group of connected resorts (e.g. Niseko United)."""
    first = next(r for r in every if r["id"] == area["resorts"][0])
    return {
        "name": area["name"],
        "region": area.get("region", first["region"]),
        "country": area.get("country", first.get("country") or ""),
        "timezone": first["timezone"],
        "resorts": list(area["resorts"]),
        **({"website": area["website"]} if area.get("website") else {}),
        **({"source_url": area["url"]} if area.get("url") else {}),
        **({"map": area["map"]} if area.get("map") else {}),
    }


def refresh_resorts(index: dict, every: list[dict], areas: list[dict] | None = None) -> None:
    """Resort (and area) details from resorts.yaml, in its order (the website lists them in this order)."""
    index["areas"] = {a["id"]: area_info(a, every) for a in areas or []}
    for r in every:
        if r.get("enabled", True) or r["id"] in index["resorts"]:
            index["resorts"][r["id"]] = resort_info(r)
    order = [r["id"] for r in every]
    index["resorts"] = dict(sorted(index["resorts"].items(),
                                   key=lambda kv: order.index(kv[0]) if kv[0] in order else len(order)))
    index["seasons"] = dict(sorted(index["seasons"].items()))


def off_season_or_night(index, resorts, groups, group_in_season, season_for, seasons, today_of, now_utc) -> int:
    """No resort is due: it's night everywhere in season, or off-season. Finish the last
    days' forecasts of groups whose season just ended, and (when every group is off-season)
    save the monthly check-in."""
    changed_files = False
    for g, group in groups.items():
        gres = [r for r in resorts if r["group"] == g]
        if not gres or group_in_season(gres[0]):
            continue
        ids = {r["id"] for r in gres}
        pending = [r for r in gres if has_pending_forecasts(season_for(r), today_of[r["id"]], ids)]
        if pending:
            changed = update_weather({r["id"]: season_for(r) for r in pending}, pending, today_of)
            for r in pending:
                if r["id"] in changed:
                    summaries = index["seasons"].get(season_for(r)["season"], {}).get("summary", {})
                    update_summary(summaries.setdefault(r["id"], {}), season_for(r), r["id"], None)
            if changed:
                for (gg, _), season in seasons.items():
                    if gg == g:
                        save_season(season, pattern=group["season_file"])
                changed_files = True
    if all(not group_in_season(r) for r in resorts):
        if monthly_check_in(index, now_utc.isoformat()):
            print("Off-season everywhere: no scraping. Saved this month's check-in (keeps the GitHub schedule active).")
            changed_files = True
        else:
            print("Off-season everywhere: no scraping, and this month's check-in is already saved.")
    else:
        print("No resort is inside its scraping hours right now (local time).")
    if changed_files:
        save_index(index)
    return 0


if __name__ == "__main__":
    sys.exit(main())
