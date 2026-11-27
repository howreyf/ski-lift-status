"""Nozawa Onsen — https://en.nozawaski.com/the-mountain/moutain-info/slopes-lifts/ (English, plain HTML).

Lift and course statuses are symbols: ○ open, △ restricted/partly open, × closed.
Hours may be a time range or Japanese text such as シーズン終了 (season ended) -> N/A.
Snow depth and temperature are from the top station (Yamabiko, 1,407 m).
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup, Comment

from scraper.common import clean_hours, clean_text, lift, run, to_jst_iso, to_number

STATUS_CELL = re.compile(r"^lift_\d+$")


def parse(html: str, options: dict) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    lifts = []
    for table in soup.select("table.tb_lift"):
        for tr in table.find_all("tr"):
            tds = tr.find_all("td")
            if len(tds) < 4:
                continue
            name, hours, raw = (clean_text(tds[i].get_text()) for i in (1, 2, 3))
            lifts.append(lift(name, raw, hours=clean_hours(hours)))

    # Course rows are malformed (<td>NAME<td class="lift_2">×), so find the status cell
    # by class and take the name from the text just before it.
    runs = []
    for table in soup.select("table.table_course"):
        for cell in table.find_all("td", class_=STATUS_CELL):
            name = cell.find_previous(string=lambda s: not isinstance(s, Comment) and clean_text(s) != "")
            runs.append(run(name or "", cell.get_text()))

    # Lift table's own "Latest update" line.
    updated = None
    for h5 in soup.find_all("h5"):
        if h5.find_next("table") in soup.select("table.tb_lift"):
            m = re.search(r"(\d{2}/[A-Za-z]{3}/\d{4} \d{1,2}:\d{2})", clean_text(h5.get_text()))
            updated = to_jst_iso(m.group(1), "%d/%b/%Y %H:%M") if m else None

    top = {}
    station = soup.select_one("table.snowinfo")
    for tr in station.find_all("tr") if station else []:
        th, td = tr.find("th"), tr.find("td")
        if th and td:
            top[clean_text(th.get_text())] = td.get_text()

    return {
        "source_updated": updated,
        "snow_depth_cm": to_number(top.get("snow depth")),
        # "snow depth [yesterday 3:00PM - today 8:00AM]" = new snow overnight
        "new_snow_cm": to_number(next((v for k, v in top.items() if "yesterday" in k), None)),
        "temperature_c": to_number(top.get("temp")),
        "lifts": lifts,
        "runs": runs,
    }
