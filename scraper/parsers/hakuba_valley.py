"""Hakuba Valley — http://hakubavalley.com/en/weather_en/ (English, plain HTML).

One page covers ten resorts. options.area picks one by a word in its heading,
e.g. {area: goryu} matches "ABLE Hakuba GORYU".

Rows like "Toomi Sky Four Lift（Night Ski）" are the same lift's night or sunrise
session, not separate lifts, so they're skipped.
This page has no hours, temperature or run list (N/A).
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup

from scraper.common import clean_text, lift, run, to_jst_iso, to_number

SESSION_ROW = re.compile(r"\((night|sunrise)[^)]*\)\s*$", re.IGNORECASE)

# Some lifts (Goryu's Iimori area) are listed in Japanese even on the English page.
NAMES_EN = {
    "ミルキーフォーリフト": "Milky Four Lift",
    "いいもり第1高速ペアリフト": "Iimori No.1 High-speed Pair Lift",
    "いいもり第6ペアリフト": "Iimori No.6 Pair Lift",
    "LAND ROVER コスモフォーリフト": "LAND ROVER Cosmo Four Lift",
}


def _matches(heading, area: str) -> bool:
    return heading is not None and area.lower() in clean_text(heading.get_text()).lower()


def parse(html: str, options: dict) -> dict:
    area = str(options["area"])
    soup = BeautifulSoup(html, "html.parser")

    block = next((b for b in soup.select(".lift-item") if _matches(b.select_one(".lift-ttl h3"), area)), None)
    if block is None:
        raise ValueError(f"No lift table for area {area!r} on the page")

    lifts = []
    for tr in block.select(".lift-tbl tr"):
        tds = tr.find_all("td")
        if len(tds) < 2:
            continue
        name = clean_text(tds[0].get_text())
        if SESSION_ROW.search(name):
            continue
        lifts.append(lift(name, tds[1].get_text(), name_en=NAMES_EN.get(name)))

    report = next((r for r in soup.select(".report-item") if _matches(r.select_one(".gelande_name"), area)), None)
    depth = report.select_one(".snow_status .status-item") if report else None
    date = report.select_one(".update .date") if report else None
    m = re.search(r"\d{4}/\d{2}/\d{2} \d{1,2}:\d{2}", clean_text(date.get_text())) if date else None

    return {
        "source_updated": to_jst_iso(m.group(), "%Y/%m/%d %H:%M") if m else None,
        "snow_depth_cm": to_number(depth.get_text()) if depth else None,
        "new_snow_cm": None,
        "temperature_c": None,
        "lifts": lifts,
        "runs": [],  # not on this page; see parse_runs (Goryu and Hakuba 47 only)
    }


def parse_runs(html: str, options: dict) -> list[dict]:
    """Run status from https://www.hakubagoryu.jp/en/ski-en/gelande/slope-conditions/, which
    covers Goryu (sections "toomi" = Alps Daira / Toomi, and "iimori") and Hakuba 47
    ("hakuba47"). options.runs_sections picks the sections for this resort.
    Night-ski and sunrise-ski rows are sessions of the same run, so they're skipped."""
    soup = BeautifulSoup(html, "html.parser")
    runs = []
    for section_id in options.get("runs_sections") or []:
        section = soup.find(id=section_id)
        if section is None:
            raise ValueError(f"No run table {section_id!r} on the slope conditions page")
        for tr in section.select("table tr"):
            tds = tr.find_all("td")
            if len(tds) < 2:
                continue
            name = clean_text(tds[0].get_text())
            if SESSION_ROW.search(name):
                continue
            runs.append(run(name, tds[1].get_text()))
    return runs
