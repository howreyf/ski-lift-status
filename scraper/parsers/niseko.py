"""Niseko Grand Hirafu — https://www.grand-hirafu.jp/snow/status/ (Japanese, plain HTML).

The page has two tabs: "hirafu" (Grand Hirafu only) and "united" (all Niseko United
resorts). We read the Grand Hirafu tab. Snow depth and temperature are for the summit.
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup

from scraper.common import clean_hours, clean_text, lift, run, to_number

# English names as on the resort's English page.
RUN_NAMES_EN = {
    "ファミリーコース": "Family Course",
    "せんの木コース": "Sennoki Course",
    "アルペンコース": "Alpen Course",
    "キング・エース連絡通路": "King/Ace Access Pass",
    "温泉沢コース": "Onsenzawa Course",
    "スーパーコース": "Super Course",
    "初級者迂回路": "Beginners Access",
    "グリーンコース": "Green Course",
    "フリココース": "Furiko Course",
    "白樺コース": "Shirakaba Course",
    "センターコース": "Center Course",
    "ラージコース": "Large Course",
    "高原コース": "Kogen Course",
    "望羊コース": "Boyo Course",
    "第2の壁": "Dai 2 no Kabe Course",
    "国体コース": "Kokutai Course",
    "粉雪コース": "Konayuki Course",
    "ホリデーコース": "Holiday Course",
    "見晴コース": "Miharashi Course",
    "林間コース": "Rinkan Course",
    "ジャンボコース": "Jumbo Course",
    "ダイナミックコース": "Dynamic Course",
}

NAMES_EN = {
    "エースゴンドラ(10人乗り)": "Ace Gondola (10-seater)",
    "キングゴンドラ(8人乗り)": "King Gondola (8-seater)",
    "エースファミリークワッド": "Ace Family Quad Lift",
    "エース第3クワッド": "Ace Quad Lift #3",
    "エース第4ペア": "Ace Pair Lift #4",
    "キング第3シックス": "King Sixpack Lift #3",
    "キング第4シングル": "King Single Lift #4",
    "キングホリデーペア": "King Holiday Pair Lift",
    "スインギングモンキー": "Swinging Monkey Lift",
}


def parse(html: str, options: dict) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    # The map layer reuses the same classes, so pick the panel that actually lists lifts.
    panel = next(p for p in soup.select('div.p-status__panel[data-content="hirafu"]')
                 if p.select(".p-status__lift"))

    lifts = []
    for item in panel.select(".p-status__lift"):
        name = clean_text(item.select_one(".p-status__lift-name").get_text())
        raw = clean_text(item.select_one(".p-status__lift-status").get_text())
        time = item.select_one(".p-status__lift-time")
        lifts.append(lift(name, raw, name_en=NAMES_EN.get(name),
                          hours=clean_hours(time.get_text() if time else None)))

    runs = []
    for item in panel.select(".p-status__course-item"):
        # Name is "1. ファミリーコース"; drop the map number.
        name = re.sub(r"^\d+\.\s*", "", clean_text(item.select_one(".p-status__course-name").get_text()))
        state = item.select_one(".p-status__course-state")
        classes = state.get("class", []) if state else []
        status = "open" if "is-open" in classes else "closed" if "is-close" in classes else None
        level = item.select_one(".p-status__course-level")
        runs.append(run(name, state.get_text() if state else "", name_en=RUN_NAMES_EN.get(name),
                        status=status, level=level.get_text() if level else None))

    # Snow: <span data-snow-cm="130"> under the "山頂" (summit) label.
    depth = None
    for d in soup.select(".p-information-ski__snow-depth"):
        if "山頂" in d.get_text():
            depth = to_number(d.select_one("[data-snow-cm]")["data-snow-cm"])
    new_snow_el = soup.select_one(".p-information-ski__snow-item [data-snow-cm]")
    snow_time = soup.select_one("time[data-snow-datetime]")

    # Temperature lives in an inline script: { place: "山頂", ..., celsius: 1.4, ... }
    m = re.search(r'place:\s*"山頂"[^}]*?celsius:\s*(-?[\d.]+)', html)

    return {
        "source_updated": (snow_time["datetime"] + ":00+09:00") if snow_time and snow_time.get("datetime") else None,
        "snow_depth_cm": depth,
        "new_snow_cm": to_number(new_snow_el["data-snow-cm"]) if new_snow_el else None,
        "temperature_c": to_number(m.group(1)) if m else None,
        "lifts": lifts,
        "runs": runs,
    }
