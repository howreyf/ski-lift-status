"""Shared helpers used by run.py and the resort parsers."""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timedelta, timezone

import requests

JST = timezone(timedelta(hours=9), "JST")
NA = "N/A"  # shown for text fields a resort doesn't publish (numbers use None / null)

USER_AGENT = "Mozilla/5.0 (compatible; lift-status-tracker/1.0)"
TIMEOUT_SECONDS = 30

STATUSES = ("open", "closed", "hold", "unknown")


def now_jst() -> datetime:
    return datetime.now(JST).replace(microsecond=0)


# ---------------------------------------------------------------- fetching

def fetch(url: str, method: str = "html", referer: str | None = None) -> str:
    """Return the page text. method="browser" runs JavaScript via Playwright."""
    if method == "browser":
        return _fetch_with_browser(url)
    headers = {"User-Agent": USER_AGENT}
    if referer:
        headers["Referer"] = referer
    resp = requests.get(url, headers=headers, timeout=TIMEOUT_SECONDS)
    resp.raise_for_status()
    # Servers that don't declare a charset default to ISO-8859-1, which garbles Japanese.
    if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
        resp.encoding = resp.apparent_encoding
    return resp.text


def _fetch_with_browser(url: str) -> str:
    from playwright.sync_api import sync_playwright  # imported only when needed

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(user_agent=USER_AGENT)
            page.goto(url, wait_until="networkidle", timeout=TIMEOUT_SECONDS * 1000)
            return page.content()
        finally:
            browser.close()


# ---------------------------------------------------------------- cleaning

def clean_text(s: str | None) -> str:
    """Collapse whitespace and convert full-width letters/digits (Ａ１) to normal ones (A1)."""
    if s is None:
        return ""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(s))).strip()


def to_number(s: str | None) -> int | float | None:
    """'40' -> 40, '-5.5℃' -> -5.5, '' / '-' / None -> None."""
    m = re.search(r"-?\d+(?:\.\d+)?", clean_text(s).replace("−", "-").replace(",", ""))
    if not m:
        return None
    value = float(m.group())
    return int(value) if value.is_integer() else value


def clean_hours(s: str | None) -> str:
    """'08:30〜16:00' -> '08:30-16:00'. With a lunch break ('9:00-12:00 13:00-15:30')
    gives first start to last end: '09:00-15:30'. No times at all -> 'N/A'."""
    times = []
    for h, m, ampm in re.findall(r"(\d{1,2}):(\d{2})\s*([AaPp][Mm])?", clean_text(s)):
        hour = int(h) % 12 + (12 if ampm.lower() == "pm" else 0) if ampm else int(h)
        times.append(f"{hour:02d}:{m}")
    if len(times) >= 2:
        return f"{times[0]}-{times[-1]}"
    return NA


def to_jst_iso(s: str | None, fmt: str) -> str | None:
    """Parse a resort's local (Japan) timestamp into ISO format with +09:00."""
    try:
        return datetime.strptime(clean_text(s), fmt).replace(tzinfo=JST).isoformat()
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------- statuses

# Checked in this order; the first group with a matching word wins.
# "hold" comes first so "Temporarily suspended" is a hold, not a closure, and
# "closed" comes before "open" so "Not operating" / "Opening soon" aren't read as open.
_STATUS_WORDS = [
    ("hold", ["tempora", "stand-by", "standby", "stand by", "wait", "pending", "investigat",
              "on hold", "見合わせ", "待機", "一時", "調査", "運行待ち", "強風"]),
    ("closed", ["closed", "close", "suspen", "not operat", "no schedul", "not schedul",
                "opening soon", "before opening", "season end", "ended",
                "運休", "休止", "終了", "閉鎖", "クローズ", "営業時間外", "営業前", "準備中"]),
    ("open", ["operat", "open", "in service", "running", "運転中", "運行中", "平常", "減速",
              "営業中", "運行", "オープン"]),
]
_STATUS_SYMBOLS = {
    "○": "open", "◯": "open", "〇": "open",
    "△": "hold",
    "×": "closed", "✕": "closed", "x": "closed", "-": "closed", "－": "closed", "ー": "closed", "": "closed",
}


def status_from_text(raw: str | None) -> str:
    """Turn a resort's status wording (English or Japanese) into open/closed/hold/unknown."""
    text = clean_text(raw)
    if text.lower() in _STATUS_SYMBOLS:
        return _STATUS_SYMBOLS[text.lower()]
    low = text.lower()
    for status, words in _STATUS_WORDS:
        if any(w in low for w in words):
            return status
    return "unknown"


RUN_STATUSES = ("open", "partial", "closed", "unknown")


def run_status_from_text(raw: str | None) -> str:
    """Run (course/slope) wording -> open / partial / closed / unknown."""
    text = clean_text(raw).lower()
    if text in ("○", "◯", "〇"):
        return "open"
    if text == "△":
        return "partial"
    if text in ("×", "✕", "x", "-", "－", ""):
        return "closed"
    if any(w in text for w in ("partial", "partly", "一部", "restricted", "規制")):
        return "partial"
    if any(w in text for w in ("不可", "closed", "close", "クローズ", "×", "soon", "before", "閉鎖")):
        return "closed"
    if any(w in text for w in ("open", "滑走可", "オープン")):
        return "open"
    return "unknown"


_LEVELS = [  # (English, words) — checked hardest first so 最上級 isn't read as 上級
    ("Expert", ["expert", "最上級"]),
    ("Advanced", ["advanced", "上級"]),
    ("Intermediate", ["intermediate", "中級"]),
    ("Beginner", ["beginner", "elementary", "初級", "初心者"]),
    ("First timer", ["first timer", "first-timer"]),
]


def level_en(raw: str | None) -> str:
    """Difficulty in English: '初級' -> 'Beginner', 'Intermediate to advanced level' ->
    'Intermediate/Advanced'. Nothing recognisable -> 'N/A'."""
    text = clean_text(raw).lower()
    found = []
    for level, words in _LEVELS:
        hit = [text.find(w) for w in words if w in text]
        if hit:
            found.append((min(hit), level))
            for w in words:  # so 上級 inside 最上級 isn't counted again
                text = text.replace(w, " " * len(w))
    if "初中級" in clean_text(raw):  # "beginner-intermediate" written as one word
        return "Beginner/Intermediate"
    return "/".join(level for _, level in sorted(found)) or NA


def run(name: str, raw: str, *, name_en: str | None = None, status: str | None = None,
        level: str | None = None) -> dict:
    """Build one run (course/slope) record with the standard fields."""
    name = clean_text(name)
    return {
        "name": name,
        "name_en": clean_text(name_en) or name,
        "status": status or run_status_from_text(raw),
        "raw": clean_text(raw),
        "level": level_en(level) if level else NA,
    }


# ---------------------------------------------------------------- lift types

_LIFT_TYPE_WORDS = [
    ("Ropeway", ["ropeway", "ロープウェイ", "ロープウエイ", "ロープウェー", "aerial tram"]),
    ("Gondola", ["gondola", "gondla", "ゴンドラ", "cabin"]),
    ("Magic carpet", ["carpet", "escalator", "escalater", "moving walk", "ムービング", "エスカレーター", "ベルト"]),
    ("Six", ["sixpack", "six-pack", "six ", "6-seat", "6 seat", "シックス", "6人乗り"]),
    ("Quad", ["quad", "クワッド", "クワット", "クワトロ", "four", "フォー", "4-seat", "4 seat", "4人乗り"]),
    ("Triple", ["triple", "トリプル", "3-seat", "3 seat", "3人乗り"]),
    ("Pair", ["pair", "double", "ペア", "ダブル", "2-seat", "2 seat", "2人乗り"]),
    ("Single", ["single", "シングル", "1-seat", "1 seat", "1人乗り"]),
]


def guess_lift_type(*texts: str | None) -> str:
    """Lift type from the first text that names one (e.g. a 'type' column, then the
    lift's name). Within a text, the word mentioned last wins, so
    'Gondola-link Double' is a Pair. Returns 'N/A' if nothing says."""
    for text in texts:
        low = clean_text(text).lower() + " "
        best = None
        for lift_type, words in _LIFT_TYPE_WORDS:
            for w in words:
                pos = low.rfind(w)
                if pos >= 0 and (best is None or pos > best[0]):
                    best = (pos, lift_type)
        if best:
            return best[1]
    return NA


def unique_names(lifts: list[dict]) -> list[dict]:
    """If two lifts share a name, add (1), (2)... so each lift stays identifiable."""
    counts: dict[str, int] = {}
    for lift in lifts:
        counts[lift["name"]] = counts.get(lift["name"], 0) + 1
    seen: dict[str, int] = {}
    for lift in lifts:
        if counts[lift["name"]] > 1:
            seen[lift["name"]] = seen.get(lift["name"], 0) + 1
            n = seen[lift["name"]]
            lift["name"] = f"{lift['name']} ({n})"
            lift["name_en"] = f"{lift['name_en']} ({n})"
    return lifts


def lift(name: str, raw: str, *, name_en: str | None = None, status: str | None = None,
         hours: str | None = None, lift_type: str | None = None, type_text: str | None = None) -> dict:
    """Build one lift record with the standard fields."""
    name = clean_text(name)
    name_en = clean_text(name_en) or name
    return {
        "name": name,
        "name_en": name_en,
        "status": status or status_from_text(raw),
        "raw": clean_text(raw),
        "hours": hours if hours is not None else NA,
        "lift_type": lift_type or guess_lift_type(type_text, name_en, name),
    }
