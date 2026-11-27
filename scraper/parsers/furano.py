"""Furano — data comes from the JSON file the status page loads:
https://furapuri.com/ski/data.json

Lift status codes (from the page's own script):
  0 = operating, 1 = closed, 2 = stopped for high wind, 3 = stopped by a fault,
  4 = closed for maintenance.
Course status codes: 0 = open, 1 = open (ungroomed), 2 = open (night), 3 = closed.
Courses are split into map segments (A1-1, A1-2 ...); segments of one course count once.
Snow depth and temperature are for the top station ("山頂").
"""

from __future__ import annotations

import json

from scraper.common import NA, clean_hours, lift, run, to_number, unique_names

COURSE_STATUS = {0: "open", 1: "open (ungroomed)", 2: "open (night)", 3: "closed"}

LIFT_STATUS = {
    0: ("open", "運行 (operating)"),
    1: ("closed", "運休 (closed)"),
    2: ("hold", "強風のため (high wind)"),
    3: ("hold", "機械故障のため (fault)"),
    4: ("closed", "機械整備のため (maintenance)"),
}


def parse(html: str, options: dict) -> dict:
    data = json.loads(html)

    lifts = []
    for l in data.get("lgrs", []):
        status, raw = LIFT_STATUS.get(l.get("status"), ("unknown", f"code {l.get('status')}"))
        lifts.append(lift(l["name"], raw, name_en=l.get("name_en"), status=status,
                          hours=clean_hours(l.get("operating_hours")) if status == "open" else NA))
    # Two lifts are both called "Snow Escalator" (one per zone): add the zone to the name.
    names = [l["name"] for l in lifts]
    for l, src in zip(lifts, data.get("lgrs", [])):
        if names.count(l["name"]) > 1 and src.get("zone"):
            zone_en = {"富良野": "Furano", "北の峰": "Kitanomine"}.get(src["zone"], src["zone"])
            l["name"] = f"{l['name']}（{src['zone']}）"
            l["name_en"] = f"{l['name_en']} ({zone_en})"
    unique_names(lifts)

    # Course id "A1-2" -> course "A1". The feed has no course names, only these map codes.
    # All segments open -> open; some open -> partial; none -> closed.
    segments: dict[str, list[int]] = {}
    for c in data.get("courses", []):
        segments.setdefault(c["id"].split("-")[0], []).append(c.get("status"))
    runs = []
    for code, states in segments.items():
        n_open = sum(s != 3 for s in states)
        status = "open" if n_open == len(states) else "partial" if n_open else "closed"
        raw = ", ".join(COURSE_STATUS.get(s, f"code {s}") for s in states)
        runs.append(run(f"Course {code}", raw, status=status))

    top = next((w for w in data.get("weathers", []) if w.get("name") == "山頂"), {})

    return {
        "source_updated": None,
        "snow_depth_cm": to_number(top.get("snowbase")),
        "new_snow_cm": to_number(top.get("last_snowfall")),
        "temperature_c": to_number(top.get("temperature")),
        "lifts": lifts,
        "runs": runs,
    }
