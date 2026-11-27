"""Rusutsu — data comes from the JSON feed the status page loads:
https://rusutsu.com/assets/partial/ajax/trail-and-lift/get-front.php

The feed has Japanese names; English names are the ones shown on the English page.
Snow depth and temperature aren't on this page (N/A).
"""

from __future__ import annotations

import json
from datetime import datetime

from scraper.common import JST, NA, lift, run

# Feed code ("k") -> English name as shown on https://rusutsu.com/en/lift-and-trail-status/
NAMES_EN = {
    "wg": "Yotei Gondola",
    "w1q": "West No.1 Quad Lift",
    "w2q": "West No.2 Quad Lift",
    "wtp": "West Tiger Pair Lift",
    "eg1": "East No.1 Gondola",
    "eg2": "East No.2 Gondola",
    "eq": "East Quad Lift",
    "e1p": "East No.1 Pair Lift",
    "e2p": "East No.2 Pair Lift",
    "tp": "Tower Pair Lift",
    "ig": "Isola Gondola",
    "a1p": "Across No.1 Pair Lift",
    "a2p": "Across No.2 Pair Lift",
    "i1q": "Isola No.1 Quad Lift",
    "i2q": "Isola No.2 Quad Lift",
    "i3q": "Isola No.3 Quad Lift",
    "i4qq": "Isola No.4 Quad Lift",
    "i5p": "Isola No.5 Pair Lift",
}

# Trail code -> English name, copied from the site's own script (output-trail.js).
# Run statuses there: オープン (open), 一部規制あり (partly restricted), クローズ (closed).
RUN_NAMES_EN = {
    "wm-fm": "Family", "wm-wl": "White Lover", "wm-bu": "Bambi - Upper Zone",
    "wm-bl": "Bambi - Lower Zone", "wm-ev": "Eva", "wm-el": "Elite", "wm-n": "Natural",
    "wm-tg": "Tiger", "wm-rbu": "Rainbow - Upper Zone", "wm-rbm": "Rainbow - Middle Zone",
    "wm-rbl": "Rainbow - Lower Zone", "wm-dm": "Dynamic", "wm-su": "Sky - Upper Zone",
    "wm-sl": "Sky - Lower Zone", "wm-gu": "Giant - Upper Zone", "wm-gl": "Giant - Lower Zone",
    "em-ev": "East Vivaldi", "em-et": "Easy Trail", "em-fb": "Fuboru",
    "em-etu": "East Tignes - Upper Zone", "em-etl": "East Tignes - Lower Zone",
    "em-se": "Super East", "em-aa": "Across A", "em-ab": "Across B", "em-j": "Joint",
    "mi-fu": "Furikozawa - Upper Zone", "mi-fm": "Furikozawa - Middle Zone",
    "mi-fl": "Furikozawa - Lower Zone", "mi-igu": "Isola Grand - Upper Zone",
    "mi-igm": "Isola Grand - Middle Zone", "mi-igl": "Isola Grand - Lower Zone",
    "mi-ia": "Isola A", "mi-ib": "Isola B", "mi-ic": "Isola C", "mi-id": "Isola D",
    "mi-idb": "Isola D Bypass", "mi-isb": "Isola Summit Bypass", "mi-igb": "Isola Grand Bypass",
    "mi-sbau": "Steamboat A - Upper Zone", "mi-sbal": "Steamboat A - Lower Zone",
    "mi-sbbu": "Steamboat B - Upper Zone", "mi-sbbm": "Steamboat B - Middle Zone",
    "mi-sbbl": "Steamboat B - Lower Zone", "mi-r1": "Rusutsu No. 1", "mi-hc": "Heavenly Canyon",
    "mi-hs": "Heavenly Spirit", "mi-hv": "Heavenly View", "mi-hra": "Heavenly Ridge A",
    "mi-hrb": "Heavenly Ridge B", "mi-ht": "Heavenly Trail",
}

# Statuses the site's own script knows about.
STATUS_MAP = {
    "運転中": "open",            # operating
    "減速運転": "open",          # operating slowed
    "運行待ち": "hold",          # waiting to start
    "待機調査中": "hold",        # standby / checking weather
    "一時運休": "hold",          # temporarily suspended
    "運休/本日営業終了": "closed",  # closed / finished for today
}

# Trail groups that are ski runs (not terrain parks, kids parks, parking).
RUN_GROUPS = ("west", "east", "isola")


def _hours(l: dict) -> str:
    if l.get("sh") in (None, "", "0") and l.get("eh") in (None, "", "0"):
        return NA
    return f"{int(l['sh']):02d}:{int(l['sm']):02d}-{int(l['eh']):02d}:{int(l['em']):02d}"


def parse(html: str, options: dict) -> dict:
    data = json.loads(html)

    lifts = [
        lift(l["nm"], l["stat"], name_en=NAMES_EN.get(l.get("k")),
             status=STATUS_MAP.get(l["stat"]), hours=_hours(l))
        for l in data.get("lift", [])
    ]

    runs = [
        run(t["nm"], t["stat"], name_en=RUN_NAMES_EN.get(t.get("k")), level=t.get("lv"))
        for group in RUN_GROUPS for t in (data.get("trail") or {}).get(group, [])
    ]
    updated = (data.get("other") or {}).get("update")

    return {
        "source_updated": datetime.fromtimestamp(int(updated), JST).isoformat() if updated else None,
        "snow_depth_cm": None,
        "new_snow_cm": None,
        "temperature_c": None,
        "lifts": lifts,
        "runs": runs,
    }
