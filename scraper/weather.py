"""Daily weather at each resort's summit and base, from Open-Meteo.

Open-Meteo (https://open-meteo.com) is a free weather service (no key; non-commercial use;
attribution required — see the website footer). One request covers every resort: for each
resort we ask about two points (summit and base height).

What gets stored, per resort and day:

  today (temps.kind = "forecast")
      summit/base: forecast min, max and mean temperature
      snow_outlook: the next day (from today, up to 16 days ahead) with at least 1 cm of
                    snow forecast at the summit -> "next snow in N days" on the website

  each earlier day, once it's over (temps.kind = "final"; replaces the forecast)
      summit/base: the day's final min, max and mean temperature
      snow_hours / snowed: how many hours it snowed at the summit, and whether that was
                    3 hours or more
      snowfall_cm:  the day's total snowfall at the summit (used where the resort doesn't
                    report new snow itself)
      (the day's snow_outlook is deleted, and hourly values are not kept)

"Final" values are the weather model's best estimate of what happened (from observations
and satellites), not a thermometer on the slope. Each run looks back 7 days, so a missed
morning (e.g. a GitHub outage) is filled in on the next run.

The website shows live (current) temperature and snowfall by asking Open-Meteo directly
from the visitor's browser; nothing live is stored.
"""

from __future__ import annotations

from datetime import date as Date

import requests

API_URL = "https://api.open-meteo.com/v1/forecast"
PAST_DAYS = 7
FORECAST_DAYS = 16          # longest snow outlook Open-Meteo offers
LEVELS = ("summit", "base")
SNOW_DAY_CM = 1.0           # a "snow day" in the outlook: at least this much at the summit
SNOWED_HOURS = 3            # a past day counts as "snowed" with at least this many hours of snow
TIMEOUT_SECONDS = 30


def has_location(resort: dict) -> bool:
    loc, elev = resort.get("location") or {}, resort.get("elevation") or {}
    return "lat" in loc and "lon" in loc and all(level in elev for level in LEVELS)


def fetch_weather(resorts: list[dict]) -> dict[str, dict[str, dict]]:
    """{resort_id: {date: day}} from PAST_DAYS ago to FORECAST_DAYS ahead (see parse_response).
    Resorts without location/elevation in resorts.yaml are skipped."""
    points = [(r, level) for r in resorts if has_location(r) for level in LEVELS]
    if not points:
        return {}
    params = {
        "latitude": ",".join(str(r["location"]["lat"]) for r, _ in points),
        "longitude": ",".join(str(r["location"]["lon"]) for r, _ in points),
        "elevation": ",".join(str(r["elevation"][level]) for r, level in points),
        "daily": "temperature_2m_min,temperature_2m_max,temperature_2m_mean,snowfall_sum",
        "hourly": "snowfall",
        "timezone": "Asia/Tokyo",
        "past_days": PAST_DAYS,
        "forecast_days": FORECAST_DAYS,
    }
    resp = requests.get(API_URL, params=params, timeout=TIMEOUT_SECONDS)
    resp.raise_for_status()
    return parse_response(resp.json(), points)


def _num(v):
    """None stays None; -0.0 (which Open-Meteo sometimes sends) becomes 0.0."""
    return None if v is None else v + 0.0


def parse_response(data, points: list[tuple[dict, str]]) -> dict[str, dict[str, dict]]:
    """Open-Meteo's answer (a list with one entry per point, in request order; a single
    object if there was only one point) ->
    {resort_id: {date: {"summit": {"min_c", "max_c", "mean_c"}, "base": {...},
                        "snowfall_cm": {"summit": x, "base": y},
                        "snow_hours": {"summit": n, "base": n}  (complete days only)}}}"""
    entries = data if isinstance(data, list) else [data]
    if len(entries) != len(points):
        raise ValueError(f"Open-Meteo returned {len(entries)} locations, expected {len(points)}")
    out: dict[str, dict[str, dict]] = {}
    for (resort, level), entry in zip(points, entries):
        days = out.setdefault(resort["id"], {})
        daily = entry["daily"]
        for i, date in enumerate(daily["time"]):
            lo, hi = _num(daily["temperature_2m_min"][i]), _num(daily["temperature_2m_max"][i])
            mean = _num((daily.get("temperature_2m_mean") or [None] * len(daily["time"]))[i])
            snow = _num((daily.get("snowfall_sum") or [None] * len(daily["time"]))[i])
            day = days.setdefault(date, {})
            if lo is not None and hi is not None:
                day[level] = {"min_c": lo, "max_c": hi, **({"mean_c": round(mean, 1)} if mean is not None else {})}
            if snow is not None:
                day.setdefault("snowfall_cm", {})[level] = round(snow, 1)

        # Hourly snowfall -> number of hours it snowed, per complete day.
        hourly = entry.get("hourly") or {}
        by_day: dict[str, list] = {}
        for stamp, value in zip(hourly.get("time", []), hourly.get("snowfall", [])):
            by_day.setdefault(stamp[:10], []).append(value)
        for date, values in by_day.items():
            if len(values) == 24 and None not in values:
                days.setdefault(date, {}).setdefault("snow_hours", {})[level] = sum(v > 0 for v in values)
    return out


def snow_outlook(by_date: dict[str, dict], today: str) -> dict:
    """The next day from today with >= SNOW_DAY_CM of snow forecast at the summit:
    {"date": "2026-11-29", "days": 2, "cm": 5.3}, or {"date": None, "days": None,
    "within_days": 16} if none is forecast."""
    for date in sorted(d for d in by_date if d >= today):
        cm = (by_date[date].get("snowfall_cm") or {}).get("summit")
        if cm is not None and cm >= SNOW_DAY_CM:
            days = (Date.fromisoformat(date) - Date.fromisoformat(today)).days
            return {"date": date, "days": days, "cm": cm}
    return {"date": None, "days": None, "within_days": FORECAST_DAYS}


def temps_record(kind: str, values: dict, elevation: dict) -> dict:
    """{"kind": "forecast"|"final",
        "summit": {"elevation_m", "min_c", "max_c", "mean_c"}, "base": {...},
        "snow_hours": n, "snowed": bool   (final only; summit)}"""
    record = {"kind": kind}
    for level in LEVELS:
        if level in values:
            record[level] = {"elevation_m": elevation[level], **values[level]}
    hours = (values.get("snow_hours") or {}).get("summit")
    if kind == "final" and hours is not None:
        record["snow_hours"] = hours
        record["snowed"] = hours >= SNOWED_HOURS
    snowfall = (values.get("snowfall_cm") or {}).get("summit")
    if kind == "final" and snowfall is not None:
        record["snowfall_cm"] = snowfall  # the day's total snowfall at the summit (model)
    return record


def apply_temps(season: dict, resort: dict, by_date: dict[str, dict], today: str) -> list[str]:
    """Write one resort's weather into the season's day records:
    today -> forecast temperatures + snow outlook; earlier days without final values yet ->
    final temperatures + snow hours, and their forecast and snow outlook are removed.
    Only days the scraper already recorded are touched. Returns the dates that changed."""
    changed = []
    days = {d["date"]: d for d in season["days"]}
    for date, values in by_date.items():
        result = days.get(date, {}).get("results", {}).get(resort["id"])
        if result is None or not any(level in values for level in LEVELS):
            continue
        if date == today:
            result["temps"] = temps_record("forecast", values, resort["elevation"])
            result["snow_outlook"] = snow_outlook(by_date, today)
            changed.append(date)
        elif date < today and (result.get("temps") or {}).get("kind") != "final":
            result["temps"] = temps_record("final", values, resort["elevation"])
            result.pop("snow_outlook", None)
            changed.append(date)
    return changed
