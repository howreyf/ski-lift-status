"""Shiga Kogen — https://www.shigakogen.gr.jp/english/lift_information/ (English, plain HTML).

Shiga Kogen is 18 linked ski areas on one page; all their lifts count as one resort.
Each area reports its own temperature and snowfall but no snow depth, so we record
the coldest area temperature (≈ the highest point) and the biggest snowfall.

"Opening Soon" is read as closed: early in the season it means "not open yet",
not "opening in a few minutes".
"""

from __future__ import annotations

from bs4 import BeautifulSoup

from scraper.common import clean_hours, clean_text, lift, run, to_number, unique_names

STATUS_MAP = {
    "Operating": "open",
    "Not Operating": "closed",
    "Opening Soon": "closed",
    "Weather Pending": "hold",
    "Closed": "closed",
}


def parse(html: str, options: dict) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    lifts, runs, temps, snowfalls = [], [], [], []
    for area in soup.select("section.p-sakudo-status__row"):
        for tr in area.select(".--lift tbody tr"):
            name = tr.select_one(".name-link") or tr.select_one("strong")
            raw = clean_text(tr.select_one(".status").get_text()) if tr.select_one(".status") else ""
            hours = tr.select_one(".biztime")
            kind = tr.select_one(".type")
            lifts.append(lift(name.get_text(), raw, status=STATUS_MAP.get(raw),
                              hours=clean_hours(hours.get_text() if hours else None),
                              type_text=kind.get_text() if kind else None))

        for tr in area.select(".--course tbody tr"):
            st, name, level = tr.select_one(".status"), tr.select_one(".name-link") or tr.select_one("strong"), tr.select_one(".level")
            runs.append(run(name.get_text() if name else "", st.get_text() if st else "",
                            level=level.get_text() if level else None))

        for dl in area.select(".p-sakudo-status-condition dl"):
            label = clean_text(dl.find("dt").get_text()) if dl.find("dt") else ""
            value = to_number(dl.find("dd").get_text()) if dl.find("dd") else None
            if value is None:
                continue
            if label == "Temperature":
                temps.append(value)
            elif label == "Snow Fall":
                snowfalls.append(value)

    return {
        "source_updated": None,
        "snow_depth_cm": None,
        "new_snow_cm": max(snowfalls) if snowfalls else None,
        "temperature_c": min(temps) if temps else None,
        "lifts": unique_names(lifts),
        "runs": unique_names(runs),  # "Yokoteyama Queen 6th Gelende" is listed twice
    }
