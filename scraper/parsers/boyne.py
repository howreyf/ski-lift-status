"""Big Sky (Boyne Resorts) — https://www.bigskyresort.com/current-conditions

The page is built with JavaScript from a JSON feed, which we read directly:
https://www.bigskyresort.com/api/reportpal?resortName=bs&useReportPal=true
It has every lift and trail by area (status, type, difficulty) and the snow report.
Lift status "Scheduled" means it's due to open later today (counted as closed until it runs).
"""

from __future__ import annotations

import json

from scraper.common import clean_hours, clean_text, cm_from_inches, lift, run, to_number

LIFT_STATUS = {"open": "open", "closed": "closed", "scheduled": "closed", "hold": "hold", "on hold": "hold",
               "wind hold": "hold", "delayed": "hold"}
RUN_STATUS = {"open": "open", "closed": "closed", "partial": "partial", "partially open": "partial"}
GRADE = {"beginner": "Green circle", "intermediate": "Blue square", "advanced intermediate": "Double blue square",
         "advanced": "Black diamond", "expert": "Double black diamond", "high exposure": "Double black diamond",
         "terrain park": "Terrain park", "park": "Terrain park"}
TYPE = {"chairlift": None, "detachable chairlift": None, "gondola": "Gondola", "aerial tramway": "Ropeway",
        "magic carpet": "Magic carpet", "poma": "Surface lift", "rope tow": "Surface lift", "t-bar": "Surface lift"}
SEATS = {1: "Single", 2: "Pair", 3: "Triple", 4: "Quad", 6: "Six", 8: "Eight"}


def _list(area: dict, kind: str, one: str) -> list[dict]:
    return ((area.get(kind) or {}).get(one)) or []


def _lift_type(l: dict) -> str | None:
    kind = clean_text(l.get("type")).lower()
    if kind in ("chairlift", "detachable chairlift"):
        return SEATS.get(l.get("capacity") or 0, "Chairlift")
    return TYPE.get(kind)


def _cm(value: dict | None) -> int | float | None:
    if not isinstance(value, dict):
        return None
    if value.get("centimeters") not in (None, "", "None"):
        return to_number(value["centimeters"])
    return cm_from_inches(value.get("inches"))


def parse(text: str, options: dict) -> dict:
    data = json.loads(text)
    lifts, runs = [], []
    for area in (data.get("facilities") or {}).get("areas", {}).get("area") or []:
        for l in _list(area, "lifts", "lift"):
            raw = clean_text(l.get("status"))
            hours = clean_hours(f"{l.get('openTime') or ''}-{l.get('closeTime') or ''}")
            lifts.append(lift(l["name"], raw, status=LIFT_STATUS.get(raw.lower(), "unknown"), hours=hours,
                              lift_type=_lift_type(l), type_text=l.get("type")))
        for t in _list(area, "trails", "trail"):
            raw = clean_text(t.get("status"))
            runs.append(run(t["name"], raw, status=RUN_STATUS.get(raw.lower(), "closed" if not raw else "unknown"),
                            grade=GRADE.get(clean_text(t.get("difficulty")).lower())))
    loc = (((data.get("currentConditions") or {}).get("resortLocations") or {}).get("location") or [{}])[0]
    return {
        "source_updated": data.get("liftsUpdated") or data.get("updated"),
        "snow_depth_cm": _cm(loc.get("base")),
        "new_snow_cm": _cm(loc.get("snow24Hours")),
        "lifts": lifts,
        "runs": runs,
    }
