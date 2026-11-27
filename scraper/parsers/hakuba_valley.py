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


HAPPO_ICONS = {"icon_circle": "open", "icon_triangle": "partial", "icon_cross": "closed"}

# Happo-one's trail status page has no difficulty; it's taken from its trail guide
# (https://www.happo-one.jp/en/gelande/). Keys: trail names as the status page writes them,
# lower case. Ranges in the guide become our two-level grades (counted under the harder one);
# "Upper intermediate - Expert" (Riesen Grat) becomes Expert. Trails the guide doesn't list
# (cat tracks, park, glamping, Snowland, Kitaone, Lower Usuba, Lower Kokusai, Sakka Wave) stay N/A.
HAPPO_RUN_LEVELS = {
    "upper shirakaba south": "Beginner", "lower shirakaba south": "Beginner", "shirakaba north": "Beginner",
    "sakka south": "Beginner", "sakka north": "Beginner",
    "nakiyama south": "Beginner/Intermediate", "nakiyama north": "Beginner/Intermediate",
    "nakiyama wall": "Beginner/Intermediate",          # Nakiyama slope: Intermediate - Upper beginner
    "panorama course": "Intermediate", "skyline course": "Intermediate",
    "riesen slalom course": "Intermediate",            # Intermediate - Upper intermediate
    "central course": "Intermediate/Advanced",         # Advanced - Upper intermediate
    "usagidaira": "Advanced", "kurobishi": "Advanced",
    "olympic course i": "Advanced", "olympic course ii": "Advanced",
    "riesen grat course": "Expert",                    # Upper intermediate - Expert
    "tenbo course": "Expert", "omusubi": "Expert",
    "upper urakuro": "Expert", "lower urakuro": "Expert",
}


def parse_runs(html: str, options: dict) -> list[dict]:
    """Run status from the resort's own trail page (runs_url in resorts.yaml):
      - Goryu and Hakuba 47: https://www.hakubagoryu.jp/en/ski-en/gelande/slope-conditions/
        sections "toomi" (Alps Daira / Toomi) and "iimori" = Goryu, "hakuba47" = Hakuba 47;
        options.runs_sections picks them
      - Happo-one (options.runs_page = happo): https://www.happo-one.jp/en/gelande/trail-conditions/
    Night-ski and sunrise-ski rows are sessions of the same run, so they're skipped."""
    if options.get("runs_page") == "happo":
        return _happo_runs(html)
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


def _happo_runs(html: str) -> list[dict]:
    """Happo-one trail table rows: letter | trail | status icon | note. The status is an image:
    icon_circle = open, icon_triangle = partly closed, icon_cross = closed."""
    soup = BeautifulSoup(html, "html.parser")
    runs = []
    for table in soup.find_all("table"):
        head = [clean_text(c.get_text()).lower() for c in table.find("tr").find_all(["th", "td"])] if table.find("tr") else []
        if head[:2] != ["trail", "status"]:
            continue
        for tr in table.find_all("tr")[1:]:
            tds = tr.find_all("td")
            if len(tds) < 3:
                continue
            name = clean_text(tds[1].get_text())
            img = tds[2].find("img", attrs={"data-src": True}) or tds[2].find("img")
            src = (img.get("data-src") or img.get("src") or "") if img else ""
            icon = re.search(r"(icon_[a-z]+)\.svg", src)
            raw = icon.group(1) if icon else ""
            runs.append(run(name, raw, status=HAPPO_ICONS.get(raw, "unknown"),
                            level=HAPPO_RUN_LEVELS.get(name.lower())))
    if not runs:
        raise ValueError("No trail table on the Happo-one trail conditions page")
    return runs
