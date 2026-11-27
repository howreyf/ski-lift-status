"""Tomamu — https://www.snowtomamu.jp/winter/en/ski/ski-slope/condition/ (English, plain HTML).

Lift status is shown by a CSS class on each lift name (no text), so "raw" holds the class.
Hours aren't published here (N/A). Snow depth is for the summit.
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup

from scraper.common import clean_text, lift, run, to_jst_iso, to_number

# Run difficulty is a CSS class. Not labelled on the page; inferred from known runs
# (The Glory, No Gravity and North Star are lv03 and are Tomamu's expert runs).
RUN_LEVELS = {"lv00": "First timer", "lv01": "Beginner", "lv02": "Intermediate", "lv03": "Advanced"}

# CSS class -> (our status, the page's legend wording)
CLASS_STATUS = {
    "is-running": ("open", "Operating"),
    "is-schedule": ("hold", "Scheduled to operate"),
    "is-survey": ("hold", "Weather under investigation"),
    "is-tempstop": ("hold", "Temporarily Suspended"),
    "is-stopped": ("closed", "Suspended All Day"),
}


def _condition(soup: BeautifulSoup, label: str):
    """The detail cells next to a condition label like 'Temperature'."""
    for name in soup.select(".condition-item-name"):
        if label.lower() in clean_text(name.get_text()).lower().replace(" ", ""):
            return name.parent.select(".condition-item-detail")
    return []


def parse(html: str, options: dict) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    lifts = []
    for el in soup.select("#lift-condition .lift-map .lift-name"):
        cls = next((c for c in el.get("class", []) if c in CLASS_STATUS), None)
        status, raw = CLASS_STATUS.get(cls, ("unknown", " ".join(el.get("class", []))))
        lifts.append(lift(el.get_text(), raw, status=status))

    # Each run: <div class="tooltip-box tooltip-c01 lv02 is-stopped">
    #   <div class="tooltip-box-title">Dragon Ridge</div><div class="tooltip-box-p">CLOSE 圧雪 [夜間]</div>
    runs = []
    for box in soup.select("#course-status .course-map-wrap .tooltip-box"):
        classes = box.get("class", [])
        title, text = box.select_one(".tooltip-box-title"), box.select_one(".tooltip-box-p")
        raw = clean_text(text.get_text()) if text else ""
        lv = next((RUN_LEVELS[c] for c in classes if c in RUN_LEVELS), None)
        runs.append(run(title.get_text() if title else "", raw,
                        status="closed" if "is-stopped" in classes else None, level=lv))

    temp = _condition(soup, "Temperature")
    depth = _condition(soup, "Snowdepth")    # [summit, base]
    new = _condition(soup, "24-hoursnowfall")
    upd = soup.select_one("#lift-condition .condition-update")
    m = re.search(r"\d{4}\.\d{2}\.\d{2} \d{1,2}:\d{2}", upd.get_text() if upd else "")

    def first_number(cells):
        return to_number(cells[0].find(string=True, recursive=False)) if cells else None

    return {
        "source_updated": to_jst_iso(m.group(), "%Y.%m.%d %H:%M") if m else None,
        "snow_depth_cm": first_number([c for c in depth if "en" in c.get("class", [])]),
        "new_snow_cm": first_number(new),
        "temperature_c": first_number(temp),
        "lifts": lifts,
        "runs": runs,
    }
