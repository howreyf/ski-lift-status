"""Livigno — https://www.skipasslivigno.com/en/lifts-and-slopes/ (English, plain HTML).

Skipass Livigno lists every lift of the three operators (Mottolino, Carosello 3000, Sitas)
in one table, each with a tick (open) or a cross (closed). Run status isn't published in
one place for the whole of Livigno, so runs are N/A. (livigno.eu/en/lifts only lists the
six main cable cars.)
"""

from __future__ import annotations

from bs4 import BeautifulSoup

from scraper.common import clean_text, lift

PREFIX = "one-col-title-text-resorts-table__resort"
ICON_TYPE = {"icon-seggiovie": "Chairlift", "icon-skilift": "Surface lift", "icon-impianti": "Gondola",
             "icon-tapis-roulant": "Magic carpet", "icon-tappeti": "Magic carpet"}
SUFFIXES = (" chair lift", " drag lift", " gondola", " magic carpet")


def parse(html: str, options: dict) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    lifts = []
    for row in soup.select(f".{PREFIX}"):
        name_el = row.select_one(f".{PREFIX}-name")
        if not name_el:
            continue
        name = clean_text(name_el.get_text())
        state = row.select_one(f".{PREFIX}-state")
        classes = " ".join(state.get("class", [])) if state else ""
        status = "open" if "--opened" in classes else "closed" if "--closed" in classes else "unknown"
        icon = row.select_one(f"i.{PREFIX}-icon")
        icon_cls = next((c for c in (icon.get("class") if icon else []) if c.startswith("icon-")), "")
        number_el = row.select_one(f".{PREFIX}-number")
        number = clean_text(number_el.get_text()).replace("N. ", "") if number_el else ""
        short = name.title()
        for s in SUFFIXES:  # "Federia chair lift" -> "Federia" (the type is shown separately)
            if short.lower().endswith(s):
                short = short[: -len(s)]
        raw = {"open": "Open", "closed": "Closed"}.get(status, classes)
        lifts.append(lift(f"{short} (no. {number})" if number else short, raw, status=status,
                          lift_type=ICON_TYPE.get(icon_cls), type_text=name))
    return {"source_updated": None, "snow_depth_cm": None, "new_snow_cm": None, "lifts": lifts, "runs": []}


def parse_snow(text: str, options: dict) -> dict:
    """Snow (snow_url: Skipass Livigno's header widget, a form POST to admin-ajax.php with
    action=getSkipassWidgetData). It shows "36 cm / 0 cm" under "snow" (most likely mountain /
    village; not labelled), so the larger figure is used as the snow depth."""
    import json
    import re
    html = json.loads(text).get("livignoLive", "")
    m = re.search(r"(\d+)\s*cm\s*/\s*(\d+)\s*cm", html)
    return {"snow_depth_cm": max(int(m.group(1)), int(m.group(2)))} if m else {}
