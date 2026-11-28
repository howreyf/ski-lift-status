"""Zugspitze — https://zugspitze.de/en/Service-information/Facilities (English, plain HTML).

The page has a "Live information" section per area (Zugspitze, Garmisch-Classic, Mount
Wank...); we read the Zugspitze glacier ski area: "Lifts & cable cars" and "Ski runs".
Each row has a dot whose class says open / closed. Run difficulty isn't published (N/A).
"""

from __future__ import annotations

from bs4 import BeautifulSoup

from scraper.common import clean_hours, clean_text, lift, run

TYPE = {"aerial tramway": "Ropeway", "cogwheel train": "Train", "6-seat chairlift": "Six",
        "4-seat chairlift": "Quad", "t-bar lift": "Surface lift", "drag lift": "Surface lift",
        "gondola": "Gondola", "magic carpet": "Magic carpet"}


def _rows(soup: BeautifulSoup, group_id: str):
    head = soup.find(id=group_id)
    section = head.find_parent("section") if head else None
    return section.select("li.status-list__row") if section else []


def _status(row) -> tuple[str, str]:
    dot = row.select_one(".status-list__dot")
    classes = " ".join(dot.get("class", [])) if dot else ""
    # Closed rows have a note ("closed"); open ones the hours ("open, 8.30 a.m. – 4.45 p.m.").
    note = row.select_one(".status-list__note") or row.select_one(".status-list__time")
    raw = clean_text(note.get_text(" ")) if note else ""
    status = "open" if "--open" in classes else "closed" if "--closed" in classes else "unknown"
    return status, raw


def _hours(text: str) -> str:
    """'open, 8.30 a.m. – 4.45 p.m.' -> '08:30-16:45'; a route ('Grainau – Zugspitze') -> N/A."""
    t = text.replace("a.m.", "am").replace("p.m.", "pm")
    t = __import__("re").sub(r"(\d{1,2})\.(\d{2})", r"\1:\2", t)
    return clean_hours(t)


def parse(html: str, options: dict) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    area = options.get("area", "zugspitze")
    lifts = []
    for row in _rows(soup, f"{area}-lifts"):
        status, raw = _status(row)
        name = clean_text(row.select_one(".status-list__name").get_text())
        kind_el = row.select_one(".status-list__area")
        kind = clean_text(kind_el.get_text()).lower() if kind_el else ""
        lifts.append(lift(name, raw.split(",")[0], status=status, hours=_hours(raw),
                          lift_type=TYPE.get(kind), type_text=kind))
    runs = []
    for row in _rows(soup, f"{area}-slopes"):
        status, raw = _status(row)
        runs.append(run(clean_text(row.select_one(".status-list__name").get_text()), raw, status=status))
    if not lifts:
        raise ValueError(f"no '{area}' lifts section on the page")
    return {"source_updated": None, "snow_depth_cm": None, "new_snow_cm": None, "lifts": lifts, "runs": runs}
