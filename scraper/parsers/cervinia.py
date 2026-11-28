"""Breuil-Cervinia — https://www.cervinia.it/en/impianti (English, plain HTML).

The page lists every area of the Cervino Ski Paradise (Breuil-Cervinia, Valtournenche,
Zermatt...). The first "Ski lifts" / "Slopes" columns are Breuil-Cervinia's; we read those.
Status is a coloured dot whose class ends in a letter:
    O open (green), F closed (red), P expected opening (yellow), H / HP out of service (black)
Slope difficulty is a dot too: B blue, R red, N black (nera).
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup

from scraper.common import clean_hours, clean_text, lift, run, unique_names

STATUS = {"O": "open", "F": "closed", "P": "closed", "H": "closed", "HP": "closed"}
RAW = {"O": "Open", "F": "Closed", "P": "Expected opening", "H": "Out of service", "HP": "Out of service"}
SEATS = {1: "Single", 2: "Pair", 3: "Triple", 4: "Quad", 6: "Six", 8: "Eight"}
GRADE = {"B": "Blue", "R": "Red", "N": "Black", "V": "Green"}
ICON_TYPE = {"icon-lift": "Chairlift", "icon-gondola": "Gondola", "icon-cable-car": "Ropeway", "icon-funivia": "Ropeway",
             "icon-carpet-lift": "Magic carpet", "icon-ski-lift": "Surface lift", "icon-skilift": "Surface lift"}


def _first_list(soup: BeautifulSoup, heading: str):
    for h in soup.find_all("h5"):
        if clean_text(h.get_text()) == heading:
            box = h.find_next_sibling("div")
            if box and len(box.find_all("div", recursive=False)) > 1:
                return box.find_all("div", recursive=False)
    return []


def _code(item, prefix: str) -> str | None:
    el = item.find(class_=re.compile(rf"^{prefix}-"))
    if not el:
        return None
    cls = next(c for c in el.get("class") if c.startswith(prefix + "-"))
    return cls[len(prefix) + 1:]


def _name(item) -> str:
    return clean_text(item.find("span").get_text(" "))


def parse(html: str, options: dict) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    lifts = []
    for item in _first_list(soup, "Ski lifts"):
        code = _code(item, "impianto-status")
        icon = item.find("use")
        icon_name = (icon.get("xlink:href") or icon.get("href") or "").lstrip("#") if icon else ""
        hours = item.find("span", class_="size-16")
        name = _name(item).title()
        seats = re.fullmatch(r"icon-seggiovia-(\d)", icon_name)  # chairlift with N seats
        lift_type = SEATS.get(int(seats.group(1))) if seats else ICON_TYPE.get(icon_name)
        lifts.append(lift(name, RAW.get(code, code or ""), status=STATUS.get(code, "unknown"),
                          hours=clean_hours(hours.get_text(" ") if hours else None),
                          lift_type=lift_type, type_text=name))

    # Two lifts share a name (Breuil-Plan Maison cable car and gondola): add the type.
    shared = {l["name"] for l in lifts if sum(x["name"] == l["name"] for x in lifts) > 1}
    for l in lifts:
        if l["name"] in shared and l["lift_type"] != "N/A":
            l["name"] = l["name_en"] = f"{l['name']} ({l['lift_type'].lower()})"
    unique_names(lifts)

    runs = []
    for item in _first_list(soup, "Slopes"):
        code = _code(item, "impianto-status")
        level = _code(item, "pista-level")
        runs.append(run(_name(item).title(), RAW.get(code, code or ""), status=STATUS.get(code, "unknown"),
                        grade=GRADE.get(level)))
    return {"source_updated": None, "snow_depth_cm": None, "new_snow_cm": None, "lifts": lifts, "runs": runs}
