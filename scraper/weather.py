"""Daily low/high temperatures at each resort's summit and base, from Open-Meteo.

Open-Meteo (https://open-meteo.com) is a free weather service (no key; non-commercial use;
attribution required — see the website footer). One request covers every resort:
for each resort we ask for two points (summit and base height) and get, per day,
the lowest and highest temperature.

  - today:            a FORECAST (the day isn't over yet)
  - the past 7 days:  the FINAL low/high, worked out by the weather model from what
                      actually happened (observations, satellites). Not a thermometer
                      reading on the slope, but consistent across all resorts.

Each morning today's record gets the forecast, and earlier days that still hold a
forecast get it replaced by the final values. Looking back 7 days means a missed
morning (e.g. a GitHub outage) is filled in on the next run.
"""

from __future__ import annotations

import requests

API_URL = "https://api.open-meteo.com/v1/forecast"
PAST_DAYS = 7
LEVELS = ("summit", "base")
TIMEOUT_SECONDS = 30


def has_location(resort: dict) -> bool:
    loc, elev = resort.get("location") or {}, resort.get("elevation") or {}
    return "lat" in loc and "lon" in loc and all(level in elev for level in LEVELS)


def fetch_daily_temps(resorts: list[dict]) -> dict[str, dict[str, dict]]:
    """{resort_id: {date: {"summit": {"min_c", "max_c"}, "base": {...}}}} for the past
    PAST_DAYS days and today. Resorts without location/elevation in resorts.yaml are skipped."""
    points = [(r, level) for r in resorts if has_location(r) for level in LEVELS]
    if not points:
        return {}
    params = {
        "latitude": ",".join(str(r["location"]["lat"]) for r, _ in points),
        "longitude": ",".join(str(r["location"]["lon"]) for r, _ in points),
        "elevation": ",".join(str(r["elevation"][level]) for r, level in points),
        "daily": "temperature_2m_min,temperature_2m_max",
        "timezone": "Asia/Tokyo",
        "past_days": PAST_DAYS,
        "forecast_days": 1,
    }
    resp = requests.get(API_URL, params=params, timeout=TIMEOUT_SECONDS)
    resp.raise_for_status()
    return parse_response(resp.json(), points)


def parse_response(data, points: list[tuple[dict, str]]) -> dict[str, dict[str, dict]]:
    """Turn Open-Meteo's answer (a list with one entry per point, in request order;
    a single object if there was only one point) into per-resort, per-date values."""
    entries = data if isinstance(data, list) else [data]
    if len(entries) != len(points):
        raise ValueError(f"Open-Meteo returned {len(entries)} locations, expected {len(points)}")
    out: dict[str, dict[str, dict]] = {}
    for (resort, level), entry in zip(points, entries):
        daily = entry["daily"]
        for date, lo, hi in zip(daily["time"], daily["temperature_2m_min"], daily["temperature_2m_max"]):
            if lo is None or hi is None:
                continue
            # "+ 0.0" turns -0.0 (which Open-Meteo sometimes sends) into 0.0.
            out.setdefault(resort["id"], {}).setdefault(date, {})[level] = {"min_c": lo + 0.0, "max_c": hi + 0.0}
    return out


def temps_record(kind: str, values: dict, elevation: dict) -> dict:
    """{"kind": "forecast"|"final", "summit": {"elevation_m", "min_c", "max_c"}, "base": {...}}"""
    record = {"kind": kind}
    for level in LEVELS:
        if level in values:
            record[level] = {"elevation_m": elevation[level], **values[level]}
    return record


def apply_temps(season: dict, resort: dict, by_date: dict[str, dict], today: str) -> list[str]:
    """Write one resort's temperatures into the season's day records:
    today -> forecast; earlier days that don't yet have final values -> final (this
    replaces their forecast). Only days the scraper already recorded are touched.
    Returns the dates that changed."""
    changed = []
    days = {d["date"]: d for d in season["days"]}
    for date, values in by_date.items():
        result = days.get(date, {}).get("results", {}).get(resort["id"])
        if result is None:
            continue
        if date == today:
            result["temps"] = temps_record("forecast", values, resort["elevation"])
            changed.append(date)
        elif date < today and (result.get("temps") or {}).get("kind") != "final":
            result["temps"] = temps_record("final", values, resort["elevation"])
            changed.append(date)
    return changed
