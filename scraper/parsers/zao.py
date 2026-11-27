"""Zao Onsen — https://zaomountainresort.com/ski/ (Japanese, plain HTML)."""

from __future__ import annotations

from bs4 import BeautifulSoup

from scraper.common import clean_hours, clean_text, guess_lift_type, run, to_jst_iso, to_number

# Japanese lift name (after clean_text, so Ａ -> A) -> English name.
# New lifts not listed here still get recorded, with the Japanese name as name_en.
NAMES_EN = {
    "蔵王ロープウェイ山頂線": "Zao Ropeway Summit Line",
    "蔵王ロープウェイ山麓線": "Zao Ropeway Sanroku (Base) Line",
    "蔵王中央ロープウェイ": "Zao Chuo Ropeway",
    "スカイケーブル": "Sky Cable",
    "菖蒲沼第2ペア": "Shobunuma No. 2 Pair",
    "蔵王パラダイスペアA・B": "Zao Paradise Pair A/B",
    "片貝トリプル": "Katagai Triple",
    "ダイヤモンド第2ペア": "Diamond No. 2 Pair",
    "見返りペア": "Mikaeri Pair",
    "中央第1ペアAB": "Chuo No. 1 Pair A/B",
    "中央第2ペアAB": "Chuo No. 2 Pair A/B",
    "黒姫第1クワトロ": "Kurohime No. 1 Quattro",
    "アストリア第2ペア": "Astoria No. 2 Pair",
    "アストリア第3ペア": "Astoria No. 3 Pair",
    "ユートピア第2ペア": "Utopia No. 2 Pair",
    "中森第1トリプル": "Nakamori No. 1 Triple",
    "中森第2ペア": "Nakamori No. 2 Pair",
    "蔵王国体ペア": "Zao Kokutai Pair",
    "温泉第1ペア": "Onsen No. 1 Pair",
    "温泉第2クワット": "Onsen No. 2 Quad",
    "温泉第3パラレルAB": "Onsen No. 3 Parallel A/B",
    "温泉第4クワット": "Onsen No. 4 Quad",
    "サンライズペア": "Sunrise Pair",
    "竜山ペア": "Ryuzan Pair",
    "大森クワトロ": "Omori Quattro",
    "横倉ペア": "Yokokura Pair",
}

# Status text on the page -> our status.
STATUS_MAP = {
    "平常運転": "open",       # normal operation
    "運転中": "open",         # operating
    "減速運転": "open",       # running at reduced speed
    "運転見合わせ": "hold",   # operation suspended (usually wind)
    "一時運休": "hold",       # temporarily stopped
    "-": "closed",            # no status = not running
    "運休": "closed",         # not operating
    "営業終了": "closed",     # finished for the day/season
    "営業前": "closed",       # before opening
}

RUN_NAMES_EN = {
    "ザンゲ坂・樹氷原コース": "Zangezaka / Juhyogen Course",
    "パラダイスゲレンデ": "Paradise Slope",
    "パラダイス迂回コース": "Paradise Bypass Course",
    "連絡コース": "Connecting Course",
    "菖蒲沼ゲレンデ": "Shobunuma Slope",
    "大平コース": "Ohira Course",
    "中央ゲレンデ": "Chuo Slope",
    "ダイヤモンドバレー": "Diamond Valley",
    "ユートピアゲレンデ": "Utopia Slope",
    "百万人ゲレンデ": "Hyakumannin Slope",
    "黒姫ゲレンデ": "Kurohime Slope",
    "黒姫スーパージャイアントコース": "Kurohime Super Giant Course",
    "黒姫コネクションコース": "Kurohime Connection Course",
    "高鳥コース": "Takatori Course",
    "上の台ゲレンデ": "Uwanodai Slope",
    "ハーネンカムCコース": "Hahnenkamm C Course",
    "ハーネンカムA・Bコース": "Hahnenkamm A/B Course",
    "竜山ゲレンデ": "Ryuzan Slope",
    "サンライズゲレンデ": "Sunrise Slope",
    "中森ゲレンデ": "Nakamori Slope",
    "横倉ゲレンデ": "Yokokura Slope",
    "大森ゲレンデ": "Omori Slope",
    "大森ジャイアントコース": "Omori Giant Course",
}


def parse(html: str, options: dict) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    lifts = []
    for row in soup.select("table.tbl_ropeway tbody tr"):
        name_cell, status_cell = row.select_one("td.name"), row.select_one("td.jyoko")
        if not name_cell or not status_cell:
            continue
        name = clean_text(name_cell.get_text())
        raw = clean_text(status_cell.get_text())
        lifts.append({
            "name": name,
            "name_en": NAMES_EN.get(name, name),
            "status": STATUS_MAP.get(raw, "unknown"),
            "raw": raw,
            "hours": clean_hours(row.select_one("td.time").get_text() if row.select_one("td.time") else None),
            "lift_type": guess_lift_type(name, NAMES_EN.get(name, "")),
        })

    # Course table: the one with a "滑走可否" (can ski?) column: 滑走可 = open, 滑走不可 = closed.
    runs = []
    for row in soup.select("table.tbl_course tbody tr"):
        name, kahi = row.select_one("td.name"), row.select_one("td.kahi")
        if name and kahi:
            n = clean_text(name.get_text())
            runs.append(run(n, kahi.get_text(), name_en=RUN_NAMES_EN.get(n)))

    weather = soup.select_one("div.weather")
    snow = {}
    if weather:
        for p in weather.select("p.snowinfo"):
            label, value = clean_text(p.get_text()), p.select_one("span")
            if "新雪" in label:
                snow["new"] = to_number(value.get_text() if value else None)
            elif "積雪" in label:
                snow["depth"] = to_number(value.get_text() if value else None)
    temp_div = weather.select_one("div.temperature") if weather else None
    updated = soup.select_one("p.lastposted time")

    return {
        "source_updated": to_jst_iso(updated.get_text() if updated else None, "%Y-%m-%d %H:%M:%S"),
        "snow_depth_cm": snow.get("depth"),
        "new_snow_cm": snow.get("new"),
        "temperature_c": to_number(temp_div.find(string=True, recursive=False) if temp_div else None),
        "lifts": lifts,
        "runs": runs,
    }
