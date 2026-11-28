"""Kiroro — https://www.kiroro.co.jp/dashboard/ (English page, lift names in Japanese).

Hours aren't published on this page (N/A). Snow depth and temperature are for the
mountain peak; the resort updates weather at 8:00 each morning.
"""

from __future__ import annotations

from bs4 import BeautifulSoup

from scraper.common import clean_text, lift, run, to_number

NAMES_EN = {
    "キロロゴンドラ": "Kiroro Gondola",
    "朝里第2エクスプレス": "Asari No.2 Express",
    "余市第1エクスプレス": "Yoichi No.1 Express",
    "余市第2リフト": "Yoichi No.2 Lift",
    "センターエクスプレス": "Center Express",
    "長峰第1エクスプレス": "Nagamine No.1 Express",
    "長峰第2エクスプレス": "Nagamine No.2 Express",
    "ファミリーリフト": "Family Lift",
    "ゲートウェイエクスプレス": "Gateway Express",
}


def _table_after_heading(soup: BeautifulSoup, heading: str):
    """The table under this heading, or None if the section has no table. (On 28 Nov 2026 the
    lift table was missing in the morning; taking the next table on the page recorded the 24
    courses as lifts.)"""
    for h in soup.select("section h6"):
        if clean_text(h.get_text()).upper() == heading:
            for el in h.find_all_next(["table", "h6"]):
                return el if el.name == "table" else None  # the next heading came first: no table
    return None


def _rows(table) -> list[tuple[str, str]]:
    rows = []
    for tr in table.select("tr") if table else []:
        tds = tr.find_all("td")
        if len(tds) >= 2:
            rows.append((clean_text(tds[0].get_text()), clean_text(tds[1].get_text())))
    return rows


def parse(html: str, options: dict) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    lifts = [lift(name, raw, name_en=NAMES_EN.get(name))
             for name, raw in _rows(_table_after_heading(soup, "LIFT STATUS"))]

    # Runs: the English "Course Status" panel, grouped under level headings:
    #   <span class="ttl-status">Beginner</span>
    #   <div class="operation-status-item"><span class="num">8</span>Asari Course1-A<br>（Groomed）
    #        <span class="status close">Closed</span></div>
    runs = []
    panel = soup.select_one(".operation-status__inner")
    level = None
    for el in panel.find_all(["span", "div"], recursive=False) if panel else []:
        if "ttl-status" in el.get("class", []):
            level = el.get_text()
        elif "operation-status-item" in el.get("class", []):
            name = next((clean_text(s) for s in el.find_all(string=True, recursive=False) if clean_text(s)), "")
            status = el.select_one(".status")
            runs.append(run(name, status.get_text() if status else "", level=level))

    # Weather table: rows like  <th>Snow Depth</th><td>peak</td><td>base</td>
    peak = {}
    weather = soup.select_one("table.weather-table")
    for tr in weather.select("tbody tr") if weather else []:
        th, td = tr.find("th"), tr.find("td")
        if th and td:
            peak[clean_text(th.get_text())] = clean_text(td.get_text())

    return {
        "source_updated": None,
        "snow_depth_cm": to_number(peak.get("Snow Depth")),
        "new_snow_cm": to_number(peak.get("Snowfall in last 24 hours")),
        "temperature_c": to_number(peak.get("Current Temperature")),
        "lifts": lifts,
        "runs": runs,
    }
