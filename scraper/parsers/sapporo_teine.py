"""Sapporo Teine — https://sapporo-teine.com/snow/gelande-report-en (English, plain HTML).

Lift type comes from the icon class (icon-lift2 = 2-seat chair, icon-gondola, ...).
Snow depth is the peak depth; temperature is at the Highland ski center.
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup

from scraper.common import NA, clean_hours, clean_text, lift, run, to_jst_iso, to_number

ICON_TYPES = {"icon-gondola": "Gondola", "icon-lift1": "Single", "icon-lift2": "Pair",
              "icon-lift3": "Triple", "icon-lift4": "Quad", "icon-lift6": "Six"}


def _items(container) -> list:
    return container.select("li.list-label__item") if container else []


def parse(html: str, options: dict) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    # Lift list is the first .greport-map__detail block; courses are inside #CourseTab.
    course_tab = soup.select_one("#CourseTab")
    lift_box = next((d for d in soup.select(".greport-map__detail")
                     if not (course_tab and course_tab in d.parents)), None)

    lifts = []
    for li in _items(lift_box):
        title = li.select_one(".list-label__title")
        status = li.select_one(".list-label__status")
        hours = li.select_one(".list-label__text")
        icon = next((c for c in title.get("class", []) if c in ICON_TYPES), None)
        lifts.append(lift(title.get_text(), status.get_text() if status else "",
                          hours=clean_hours(hours.get_text()) if hours else NA,
                          lift_type=ICON_TYPES.get(icon)))

    runs = []
    for li in _items(course_tab):
        title, status = li.select_one(".list-label__title"), li.select_one(".list-label__status")
        if title:
            runs.append(run(title.get_text(), status.get_text() if status else ""))

    report = soup.select_one(".greport")
    data = {}
    if report:
        for dt in report.select(".greport__data__head"):
            dd = dt.find_next_sibling("dd")
            data[clean_text(dt.find(string=True, recursive=False))] = dd.get_text() if dd else None
        temp = report.select_one(".greport__temp .celsius")
        upd = report.select_one(".greport__update__content")
    m = re.search(r"\d{4}\.\d{2}\.\d{2} \d{1,2}:\d{2}", clean_text(upd.get_text())) if report and upd else None

    return {
        "source_updated": to_jst_iso(m.group(), "%Y.%m.%d %H:%M") if m else None,
        "snow_depth_cm": to_number(data.get("山頂積雪")),
        "new_snow_cm": to_number(data.get("24時間降雪量")),
        "temperature_c": to_number(temp.find(string=True, recursive=False)) if report and temp else None,
        "lifts": lifts,
        "runs": runs,
    }
