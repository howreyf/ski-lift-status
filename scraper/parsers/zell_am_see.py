"""Zell am See-Kaprun — https://www.zellamsee-kaprun.com/en/service/live/pistes (English).

The page has dropdowns ("Cable cars & lifts", "Slopes", ...) with a tab per ski area:
ALPIN CARD (everything), Kitzsteinhorn, Schmittenhöhe and, for slopes, Skicircus (Saalbach,
a separate resort). We read the Kitzsteinhorn and Schmittenhöhe tabs (Kitzsteinhorn
includes Maiskogel). The lifts list only has the main cable cars and gondolas, as on the
page. Slope difficulty: easy = blue, medium = red, hard = black.
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup

from scraper.common import clean_hours, clean_text, lift, run

AREAS = ("Kitzsteinhorn", "Schmittenhöhe")
GRADE = {"level-easy": "Blue", "level-medium": "Red", "level-hard": "Black"}
ICON_TYPE = {"icon--lifte-pisten-gondel": "Gondola", "icon--lifte-pisten-seilbahn": "Ropeway",
             "icon--lifte-pisten-standseil": "Train", "icon--lifte-pisten-4er": "Quad",
             "icon--lifte-pisten-6er": "Six", "icon--lifte-pisten-8er": "Eight",
             "icon--lifte-pisten-schlepp": "Surface lift"}


def _status(raw: str) -> str:
    raw = raw.lower()
    return "open" if raw == "open" else "closed" if raw in ("closed", "in preparation") else "unknown"


def _area_rows(details, areas=AREAS):
    """The rows of the chosen tabs. Tabs and panels come in the same order."""
    tabs = [clean_text(b.get_text(" ")) for b in details.select(".lifts-slopes--switch--button")]
    panels = details.select(".lifts-slopes--place-information")
    rows = []
    for tab, panel in zip(tabs, panels):
        if any(tab.startswith(a) for a in areas):
            ul = panel.select_one("ul.lifts-slopes--information")
            rows += ul.find_all("li", recursive=False) if ul else []
    return rows


def _name(li) -> str:
    left = li.select_one(".lifts-slopes--information-left") or li
    spans = [s for s in left.find_all("span", recursive=False) if clean_text(s.get_text())]
    return clean_text(spans[-1].get_text()) if spans else ""


def parse(html: str, options: dict) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    lifts_box, slopes_box = soup.select_one("details.lifts"), soup.select_one("details.slopes")
    if not lifts_box:
        raise ValueError("lifts dropdown not found")

    lifts = []
    for li in _area_rows(lifts_box):
        raw = clean_text(li.select_one(".lifts-slopes--information--status").get_text(" "))
        icon = next((c for i in li.select("i.icon") for c in i.get("class") if c.startswith("icon--lifte")), "")
        right = li.select_one(".lifts-slopes--information-right")
        hours = clean_hours(re.sub(r"(\d{1,2})\.(\d{2})", r"\1:\2", right.get_text(" ") if right else ""))
        name = _name(li)
        lifts.append(lift(name, raw, status=_status(raw), hours=hours, lift_type=ICON_TYPE.get(icon), type_text=name))

    runs = []
    for li in _area_rows(slopes_box) if slopes_box else []:
        raw = clean_text(li.select_one(".lifts-slopes--information--status").get_text(" "))
        level = li.select_one(".level")
        grade = next((GRADE[c] for c in (level.get("class") if level else []) if c in GRADE), None)
        runs.append(run(_name(li), raw, status=_status(raw), grade=grade))
    return {"source_updated": None, "snow_depth_cm": None, "new_snow_cm": None, "lifts": lifts, "runs": runs}
