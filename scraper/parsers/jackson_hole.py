"""Jackson Hole — https://www.jacksonhole.com/mountain-report

The mountain report is built with JavaScript from a JSON feed, which we read directly:
https://jacksonhole-prod.zaneray.com/api/all.json (lifts, trails, snow report).
Trails without a status in the feed are listed as closed.
"""

from __future__ import annotations

import json

from scraper.common import NA, clean_text, cm_from_inches, guess_lift_type, lift, run, to_number

LIFT_STATUS = {"OPEN": "open", "CLOSED": "closed", "HOLD": "hold", "ON_HOLD": "hold", "DELAYED": "hold",
               "EXPECTED": "closed", "SCHEDULED": "closed"}
RUN_STATUS = {"OPEN": "open", "CLOSED": "closed", "PARTIAL": "partial", "PARTIALLY_OPEN": "partial"}
GRADE = {"GREEN_CIRCLE": "Green circle", "BLUE_SQUARE": "Blue square", "DOUBLE_BLUE_SQUARE": "Double blue square",
         "BLACK_DIAMOND": "Black diamond", "DOUBLE_BLACK_DIAMOND": "Double black diamond",
         "TERRAIN_PARKS": "Terrain park", "TERRAIN_PARK": "Terrain park"}
TYPE = {"GONDOLA": "Gondola", "TRAM": "Ropeway", "MAGIC_CARPET": "Magic carpet", "SURFACE_LIFT": "Surface lift"}


def _cm(value: dict | None):
    if not isinstance(value, dict) or value.get("value") in (None, ""):
        return None
    return cm_from_inches(value["value"]) if value.get("unit") == "INCH" else to_number(value["value"])


def parse(text: str, options: dict) -> dict:
    data = json.loads(text)
    lifts = []
    for l in (data.get("lifts") or {}).values():
        raw = clean_text(l.get("openingStatus"))
        kind = l.get("liftType") or ""
        lifts.append(lift(l["name"], raw, status=LIFT_STATUS.get(raw, "unknown"),
                          # seats only from the name ("Teton Quad"); otherwise just "Chairlift"
                          lift_type=TYPE.get(kind) or (guess_lift_type(l["name"]) if guess_lift_type(l["name"]) != NA
                                                       else "Chairlift" if "CHAIR" in kind else None)))
    runs = []
    for t in (data.get("trails") or {}).values():
        if t.get("trailType", "DOWNHILL_SKIING") != "DOWNHILL_SKIING":
            continue
        raw = clean_text(t.get("openingStatus"))
        runs.append(run(t["name"], raw, status=RUN_STATUS.get(raw, "closed" if not raw else "unknown"),
                        grade=GRADE.get(t.get("trailLevel"))))
    snow = data.get("snow") or {}
    mid, summit = snow.get("midMountain") or {}, snow.get("tramSummit") or {}
    return {
        "source_updated": data.get("lastModified"),
        # Snow depth at mid-mountain (the resort's headline figure); new snow in the last 24 h.
        "snow_depth_cm": _cm(mid.get("totalSnowDepth")) or _cm(summit.get("totalSnowDepth")),
        "new_snow_cm": _cm(mid.get("newSnowLast24H")),
        "lifts": lifts,
        "runs": runs,
    }
