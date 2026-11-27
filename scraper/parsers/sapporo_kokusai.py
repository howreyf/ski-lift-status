"""Sapporo Kokusai — https://www.sapporo-kokusai.jp/en/slopes/ (English, plain HTML).

Lift status cell says either "Operating hours：9:00～15:20" (running) or e.g.
"Suspension of operations". Courses: ○ open, △ partly open, × closed.
Snow depth and temperature aren't on this page (N/A).
"""

from __future__ import annotations

from bs4 import BeautifulSoup

from scraper.common import NA, clean_hours, clean_text, lift, run


def _table_with_header(soup: BeautifulSoup, header: str):
    for table in soup.find_all("table"):
        first = table.find("tr")
        if first and header.lower() in clean_text(first.get_text()).lower():
            return table
    return None


def parse(html: str, options: dict) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    lifts = []
    table = _table_with_header(soup, "Lift name")
    for tr in table.find_all("tr")[1:] if table else []:
        tds = tr.find_all("td")
        if len(tds) < 4:
            continue
        name, seats, raw = (clean_text(tds[i].get_text()) for i in (0, 1, 3))
        hours = clean_hours(raw)
        lifts.append(lift(name, raw, status="open" if hours != NA else None,
                          hours=hours, type_text=seats))

    # Course rows: <th>Forest Trail</th><td>ELEMENTARY</td> ... <td><span class="course__detail-tag">○</span>
    runs = []
    table = _table_with_header(soup, "Course name")
    for tr in table.find_all("tr")[1:] if table else []:
        tag, th, tds = tr.select(".course__detail-tag"), tr.find("th"), tr.find_all("td")
        if tag and th:
            runs.append(run(th.get_text(), tag[-1].get_text(), level=tds[0].get_text() if tds else None))

    return {
        "source_updated": None,
        "snow_depth_cm": None,
        "new_snow_cm": None,
        "temperature_c": None,
        "lifts": lifts,
        "runs": runs,
    }
