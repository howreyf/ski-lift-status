"""Vail Resorts mountains (Whistler Blackcomb) — e.g.
https://www.whistlerblackcomb.com/the-mountain/mountain-conditions/terrain-and-lift-status.aspx

Vail Resorts' sites refuse plain downloads, so the page is opened in a browser
(fetch: browser). It carries the lift and trail status as a script variable:
    FR.TerrainStatusFeed = {"Date": ..., "GroomingAreas": [{"Name", "Lifts": [...], "Trails": [...]}], "Lifts": [...]}
The page has it twice: once with numbers for status and difficulty, once with words; we use
the one with words. Lift status "Scheduled" = due to open later today (closed until then).
"""

from __future__ import annotations

import json
import re

from scraper.common import clean_hours, clean_text, lift, run

LIFT_STATUS = {"open": "open", "closed": "closed", "scheduled": "closed", "onhold": "hold", "hold": "hold",
               "delayed": "hold", "windhold": "hold"}
GRADE = {"green": "Green circle", "blue": "Blue square", "black": "Black diamond",
         "doubleblack": "Double black diamond", "terrainpark": "Terrain park"}
TYPE = {"gondola": "Gondola", "tram": "Ropeway", "single": "Single", "double": "Pair", "triple": "Triple",
        "quad": "Quad", "six": "Six", "eight": "Eight", "t-bar": "Surface lift", "tbar": "Surface lift",
        "platter": "Surface lift", "carpet": "Magic carpet", "conveyor": "Magic carpet"}


def _feeds(html: str) -> list[dict]:
    feeds = []
    for m in re.finditer(r"TerrainStatusFeed\s*=\s*(\{.*?\});\s*$", html, re.M):
        try:
            feeds.append(json.loads(m.group(1)))
        except json.JSONDecodeError:
            continue
    return feeds


def parse(html: str, options: dict) -> dict:
    feeds = _feeds(html)
    feed = next((f for f in feeds if any(isinstance(l.get("Status"), str) for l in f.get("Lifts") or [])),
                feeds[0] if feeds else None)
    if not feed:
        raise ValueError("TerrainStatusFeed not found on the page")

    lifts, seen = [], set()
    for l in (feed.get("Lifts") or []) + [l for a in feed.get("GroomingAreas") or [] for l in a.get("Lifts") or []]:
        if l["Name"] in seen:
            continue
        seen.add(l["Name"])
        raw = clean_text(str(l.get("Status")))
        lifts.append(lift(re.sub(r"\s+", " ", l["Name"]).strip(), raw,
                          status=LIFT_STATUS.get(raw.lower().replace(" ", ""), "unknown"),
                          hours=clean_hours(f"{l.get('OpenTime') or ''}-{l.get('CloseTime') or ''}"),
                          lift_type=TYPE.get(clean_text(l.get("Type")).lower()), type_text=l.get("Name")))
    runs, seen = [], set()
    for area in feed.get("GroomingAreas") or []:
        for t in area.get("Trails") or []:
            if t["Name"] in seen:
                continue
            seen.add(t["Name"])
            runs.append(run(t["Name"], "Open" if t.get("IsOpen") else "Closed",
                            status="open" if t.get("IsOpen") else "closed",
                            grade=GRADE.get(clean_text(str(t.get("Difficulty"))).lower())))
    return {"source_updated": feed.get("Date") if isinstance(feed.get("Date"), str) and "T" in feed.get("Date") else None,
            "snow_depth_cm": None, "new_snow_cm": None, "lifts": lifts, "runs": runs}
