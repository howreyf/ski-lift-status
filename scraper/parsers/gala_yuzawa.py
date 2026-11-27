"""GALA Yuzawa — https://gala.co.jp/winter/gelande/?wovn=en

The site translates itself with a service called WOVN. Usually we get the English
page with the Japanese original kept in <!--wovn-src:...--> comments, but sometimes
the server sends the plain Japanese page instead. Both versions are handled.

Lifts: ○ scheduled to operate today, × not today, － season over.
Courses: ○ open, △ partly open, × closed.
No hours, snow depth or temperature on this page (N/A).
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup, Comment

from scraper.common import clean_text, lift, run

BRACKETS = re.compile(r"\s*[（(][^）)]*[）)]\s*$")

# Used when the server sends the Japanese-only page.
NAMES_EN = {
    "ディリジャンス": "Diligence",
    "バルーシュ": "Barouche",
    "ソーシャブル": "Sociable",
    "フェートン": "Phaeton",
    "ビクトリア": "Victoria",
    "シャリオ": "Chariot",
    "ティルバリー": "Tilbury",
    "バギー": "Buggy",
    "ランドー": "Landau",
    "ワゴネット": "Wagonette",
}


RUN_NAMES_EN = {
    "メロディ": "Melody",
    "エンターテイメント": "Entertainment",
    "エーデルワイス": "Edelweiss",
    "ジジ": "Gigi",
    "グルノーブル": "Grenoble",
    "ゆきあそびパーク": "Snow Enjoyment Park",
    "ブロードウェイ": "Broadway",
    "スーパーブロードウェイ": "Super Broadway",
    "スワン": "Swan",
    "スーパースワン(非圧雪)": "Super Swan (un-groomed)",
    "ローマンホリデーA": "Roman Holiday A",
    "ローマンホリデーB": "Roman Holiday B",
    "ジョアンナA": "Joanna A",
    "ジョアンナB": "Joanna B",
    "スノーパーク": "Snow Park",
    "バットマン": "Batman",
    "260万ダラー(非圧雪)": "$2,600,000 (un-groomed)",
    "ブロンコA(非圧雪)": "Bronco A (ungroomed)",
    "ブロンコB(非圧雪)": "Bronco B (ungroomed)",
    "イライザ": "Eliza",
    "ファルコン": "Falcon",
}


def _table_after_heading(soup: BeautifulSoup, *headings: str):
    for h in soup.find_all("h3"):
        text = clean_text(h.get_text()).lower()
        if any(words.lower() in text for words in headings):
            return h.find_next("table")
    return None


def _japanese(td) -> str | None:
    c = td.find(string=lambda s: isinstance(s, Comment) and s.strip().startswith("wovn-src:"))
    return c.strip()[len("wovn-src:"):] if c else None


def parse(html: str, options: dict) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    lifts = []
    table = _table_after_heading(soup, "CHAIRLIFT OPERATING STATUS", "リフト運行予定")
    for tr in table.select("tbody tr") if table else []:
        tds = tr.find_all("td")
        if len(tds) < 2:
            continue
        name_td, status_td = tds[-2], tds[-1]  # first column (area) only on some rows
        shown = clean_text(name_td.get_text())  # "Diligence (8-seater Gondola Lift)" or "ディリジャンス（8人乗りゴンドラ）"
        original = clean_text(_japanese(name_td)) or shown
        name = BRACKETS.sub("", original)
        name_en = BRACKETS.sub("", shown) if shown != original else NAMES_EN.get(name)
        lifts.append(lift(name, status_td.get_text(), name_en=name_en, type_text=shown))

    # Course rows: [area (some rows only)], level, name, status
    runs = []
    table = _table_after_heading(soup, "TRAIL OPENING STATUS", "コースオープン予定")
    for tr in table.select("tbody tr") if table else []:
        tds = tr.find_all("td")
        if len(tds) < 3:
            continue
        level_td, name_td, status_td = tds[-3], tds[-2], tds[-1]
        shown = clean_text(name_td.get_text())
        original = clean_text(_japanese(name_td)) or shown
        level = clean_text(_japanese(level_td)) or clean_text(level_td.get_text())
        runs.append(run(original, status_td.get_text(),
                        name_en=shown if shown != original else RUN_NAMES_EN.get(original),
                        level=level))

    return {
        "source_updated": None,
        "snow_depth_cm": None,
        "new_snow_cm": None,
        "temperature_c": None,
        "lifts": lifts,
        "runs": runs,
    }
