"""Niseko United resorts (Annupuri, Niseko Village, Hanazono) — the lift and course status
shown on https://www.niseko.ne.jp/en/niseko-lift-status/ and the resorts' own pages
(e.g. https://hanazononiseko.com/en/winter/resort/lift-status) comes from the yukiyama
web API, which we read directly (JSON):

    lifts    .../latest-facility/backward?facilityType=lift&lang=en&skiareaId=<id>
    courses  .../latest-facility/backward?facilityType=course&lang=<en|ja>&skiareaId=<id>
    weather  .../latest-weather/backward?lang=en&skiareaId=<id>   (snow depth, summit)

Ski area ids: 379 Hanazono, 390 Grand Hirafu, 393 Annupuri, 394 Niseko Village.
Annupuri's course names are only published in Japanese, so its course feed is read in
Japanese and translated (RUN_NAMES_EN). The feed doesn't give difficulty (N/A).
"""

from __future__ import annotations

import json

from scraper.common import clean_hours, clean_text, lift, run, to_number

# Lift wording in the feed -> our status (OPERATION_SLOWED = running slower in wind).
LIFT_STATUS = {
    "OPERATING": "open", "OPERATION_SLOWED": "open",
    "STANDBY": "hold", "OPERATION_TEMPORARILY_SUSPENDED": "hold",
    "SUSPENDED": "closed", "TODAY_CLOSED": "closed", "CLOSED": "closed",
}
RUN_STATUS = {"OPEN": "open", "PARTIALLY_OPEN": "partial", "CLOSED": "closed"}

# Annupuri's courses (Japanese only in the feed), English names as on the trail map.
RUN_NAMES_EN = {
    "チャンピオンコース": "Champion Course",
    "ユートピアコース": "Utopia Course",
    "パノラマコース": "Panorama Course",
    "シルバーコース": "Silver Course",
    "S字コース": "S-Curve Course",
    "白樺コース": "Shirakaba Course",
    "ファミリーコース": "Family Course",
    "パラダイスコース": "Paradise Course",
    "メルヘンコース": "Märchen Course",
    "ジュニアコース": "Junior Course",
    "チャレンジコース": "Challenge Course",
    "深雪林間コース": "Powder Forest Course",
    "ダイナミックコース": "Dynamic Course",
    # Hanazono: a missing space in the feed
    "Colly’sFolly": "Colly’s Folly",
}

# Some lift names in the feed are abbreviated; the names used on the resorts' pages.
LIFT_NAMES_EN = {
    "Hanazono 2": "Hanazono Quad Lift #2",
    "Hanazono 3": "Hanazono Hooded Quad Lift #3",
    "Hanazono Lift#1": "Hanazono Hooded Lift #1",
}

LIFT_TYPES = {"Hanazono Hooded Lift #1": "Quad", "Village Express": "Quad", "Community Chair": "Pair",
              "Banzai Chair": "Pair", "Country Road Chair": "Pair", "Wonderland Chair": "Pair",
              "Jumbo Pair #2": "Pair", "Jumbo Pair #3": "Pair", "Jumbo Pair #4": "Pair"}


def _results(text: str) -> list[dict]:
    return json.loads(text).get("results") or []


def _hours(item: dict) -> str:
    start, end = item.get("start_time") or "", item.get("end_time") or ""
    hours = clean_hours(f"{start}-{end}")
    return "N/A" if hours in ("00:00-00:00", "N/A") else hours


def parse(text: str, options: dict) -> dict:
    """Lifts (the data_url feed)."""
    lifts = []
    for item in _results(text):
        name = clean_text(item.get("name"))
        if not name:
            continue
        name_en = LIFT_NAMES_EN.get(name, name)
        raw = clean_text(item.get("status"))
        lifts.append(lift(name, raw, name_en=name_en, status=LIFT_STATUS.get(raw, "unknown"),
                          hours=_hours(item), lift_type=LIFT_TYPES.get(name_en)))
    updated = max((i.get("updateDate") or "" for i in _results(text)), default="") or None
    return {"source_updated": updated.replace(".000000Z", "+00:00") if updated else None,
            "snow_depth_cm": None, "new_snow_cm": None, "lifts": lifts, "runs": []}


def parse_runs(text: str, options: dict) -> list[dict]:
    """Courses (the runs_url feed)."""
    runs = []
    for item in _results(text):
        name = clean_text(item.get("name"))
        if not name:
            continue
        raw = clean_text(item.get("status"))
        runs.append(run(name, raw, name_en=RUN_NAMES_EN.get(name, name), status=RUN_STATUS.get(raw, "unknown")))
    return runs


def parse_snow(text: str, options: dict) -> dict:
    """Snow depth at the summit (the snow_url feed). The feed's place names differ per resort
    ("Peak", "TOP", "Ski slope summit", "Mountain top"); the deepest reading is the summit's."""
    depths = [to_number(str(p.get("snow_accumulation"))) for p in _results(text)
              if p.get("snow_accumulation") is not None]
    return {"snow_depth_cm": max(depths) if depths else None}
