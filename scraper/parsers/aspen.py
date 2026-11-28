"""Aspen Mountain (Aspen Snowmass) — https://www.aspensnowmass.com/four-mountains/aspen-mountain/snow-and-grooming-report

The page is built with JavaScript from JSON feeds, which we read directly:
    lifts (data_url)  /AspenSnowmass/LiftStatus/Feed?mountain=AspenMountain
    runs  (runs_url)  /AspenSnowmass/GroomingReport/Feed?mountain=AspenMountain
    snow  (snow_url)  /AspenSnowmass/SnowReport/Feed?mountain=AspenMountain
"""

from __future__ import annotations

import json

from scraper.common import clean_hours, clean_text, lift, run, to_number

LIFT_STATUS = {"open": "open", "closed": "closed", "on hold": "hold", "hold": "hold", "wind hold": "hold",
               "delayed": "hold", "scheduled": "closed", "expected": "closed"}
GRADE = {"beginner": "Green circle", "easiest": "Green circle", "intermediate": "Blue square",
         "advanced": "Black diamond", "expert": "Double black diamond", "extreme": "Double black diamond",
         "terrain park": "Terrain park", "park": "Terrain park"}
SEATS = {"1": "Single", "2": "Pair", "3": "Triple", "4": "Quad", "6": "Six", "8": "Eight"}


def parse(text: str, options: dict) -> dict:
    data = json.loads(text)
    lifts = []
    for l in data.get("liftStatuses") or []:
        raw = clean_text(l.get("status"))
        name = clean_text(l.get("liftName"))
        lift_type = "Gondola" if "gondola" in name.lower() else SEATS.get(str(l.get("type")), None)
        lifts.append(lift(name, raw, status=LIFT_STATUS.get(raw.lower(), "unknown"),
                          hours=clean_hours(l.get("hoursOfOperation")), lift_type=lift_type, type_text=name))
    return {"source_updated": None, "snow_depth_cm": None, "new_snow_cm": None, "lifts": lifts, "runs": []}


def parse_runs(text: str, options: dict) -> list[dict]:
    """Every trail, grouped by area in the feed. Uphill routes aren't ski runs: skipped."""
    runs, seen = [], set()
    for area in json.loads(text).get("areas") or []:
        if "uphill" in clean_text(area.get("name")).lower():
            continue
        for t in area.get("trails") or []:
            name = clean_text(t.get("name"))
            if not name or name in seen:
                continue
            seen.add(name)
            is_open = t.get("isOpen") or t.get("isDayOpen")
            runs.append(run(name, "Open" if is_open else "Closed", status="open" if is_open else "closed",
                            grade=GRADE.get(clean_text(t.get("difficulty")).lower())))
    return runs


def parse_snow(text: str, options: dict) -> dict:
    data = json.loads(text)
    base = (data.get("snowBase") or {}).get("centimeters")
    new = (data.get("snow24Hours") or {}).get("centimeters")
    return {"snow_depth_cm": to_number(base), "new_snow_cm": to_number(new)}
