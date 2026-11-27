# Japan Ski Lift Status

Records which ski lifts are open each day at selected Japanese resorts, and shows it on a static website.

- `resorts.yaml`: the season months and the list of resorts
- `scraper/`: the Python scraper (`run.py` plus one small parser per resort in `scraper/parsers/`)
- `docs/`: the website, served by GitHub Pages; the data lives in `docs/data/`
- `tests/`: checks that each parser still reads a saved copy of its resort's page
- `.github/workflows/scrape.yml`: runs the scraper every morning at 09:30 Japan time and commits the data
- `.github/workflows/tests.yml`: runs the tests whenever code is pushed

## Setup (once)

```
python -m pip install -r requirements.txt
python -m playwright install chromium
```

## Everyday commands (run in the project folder)

| What | Command |
|---|---|
| Scrape all enabled resorts (does nothing off-season) | `python -m scraper.run` |
| Scrape even off-season | `python -m scraper.run --force` |
| Scrape one resort | `python -m scraper.run --only zao-onsen` |
| Check the parsers still work | `python -m unittest -v` |
| Preview the website | `python -m http.server -d docs`, then open http://localhost:8000 |

Re-running on the same day replaces that day's results, so it's safe to run as often as you like.

## The website (`docs/`)

Plain HTML/CSS/JavaScript, no build step. Pages (the part after `#` in the address):

| Page | Address | What's on it |
|---|---|---|
| Home | `#/` | "Find resort" search, pinned resorts (up to 5), resort table grouped by region (collapsible) |
| Resorts | `#/resorts` | Search and a directory of all resorts by region |
| One resort | `#/resort/<id>` | Placeholder page for now: today's numbers, live summit/base temperature, lifts and runs |

- Table columns: lifts open / total · runs open by grade (green, red, black, orange = expert,
  grey = level not published; partly open counts as open; two-level runs count under the harder
  grade) · base temperature (live, or today's forecast low/high if live isn't available) · snow depth.
- Search suggestions (max 3): with nothing typed, recently viewed resorts first, then A–Z. While
  typing, matches are ranked by relevance (name starts with it > a word starts with it > appears
  inside a name > region), with recently viewed matches moved to the top. Enter opens the
  highlighted suggestion, or the only one left.
- Pins, recently viewed resorts and which regions are collapsed are saved in the visitor's own
  browser (localStorage), not on the server.
- Live temperatures: the browser asks Open-Meteo for the current temperature at each resort's
  summit and base when the page opens, and every 15 minutes while it stays open.

## Season months and the daily schedule

`season:` in `resorts.yaml` sets the months when data is collected (November–April by default).
Outside them the daily GitHub run scrapes nothing; instead, on the first run of each month it
updates `last_checked` in `docs/data/lifts.json` and commits that. GitHub switches off scheduled
workflows in public repositories after 60 days without activity, and this monthly commit
prevents that, so the schedule keeps running from one season to the next with no manual restart.

## When a resort changes its website

1. The scraper prints `FAILED` for that resort, and the website shows "Couldn't read the resort's page".
2. Save the new page over `tests/fixtures/<resort>.html`.
3. Fix `scraper/parsers/<resort>.py` until `python -m unittest -v` passes.

## Data format

Two kinds of file in `docs/data/`. The website loads the small index first, then only the season
file for the date being viewed.

`docs/data/lifts.json` (index, small, indented):
```
last_updated                       when lift data was last scraped
last_checked                       when the scraper last ran (includes off-season monthly check-ins)
season_months                      {start, end}, copied from resorts.yaml
resorts.<id>                       name, region, source_url, location {lat, lon}, elevation_m {summit, base}
seasons.<2026-27>.file             "seasons/2026-27.json"
seasons.<2026-27>.dates            every date recorded that season
seasons.<2026-27>.summary.<id>     lifts_total, runs_total, snow_depth_max_cm, snow_depth_max_date,
                                   summit_min_c, summit_max_c, base_min_c, base_max_c (season range
                                   from the FINAL daily lows/highs), days_recorded
```

`docs/data/seasons/2026-27.json` (one per season, written on one line to keep it small):
```
season                             "2026-27" (seasons run July–June, so Nov–Apr stays in one file)
days[].date                        Japan date, e.g. 2026-11-27
days[].results.<id>                scraped_at, ok, error (if failed), source_updated, lifts_open, runs_open,
                                   snow_depth_cm, new_snow_cm, temperature_c (the resort's own reading),
                                   temps, lifts[], runs[]
days[].results.<id>.temps          kind ("forecast" for today, "final" once the day is over),
                                   summit {elevation_m, min_c, max_c}, base {elevation_m, min_c, max_c},
                                   hourly {summit: [24], base: [24]} (final days only)
days[].results.<id>.lifts[]        name, name_en, status (open/closed/hold/unknown), raw, hours, lift_type
days[].results.<id>.runs[]         name, name_en, status (open/partial/closed/unknown), raw, level
```

`level` is Beginner / Intermediate / Advanced / Expert / First timer (or two joined, e.g.
"Intermediate/Advanced"), or N/A. An empty `runs` list means the resort doesn't publish runs.

Text a resort doesn't publish is stored as `"N/A"`; numbers it doesn't publish are stored as `null`
(and shown as N/A on the website).

## How the data is interpreted

- **status**: `open` = running; `hold` = temporarily stopped or waiting (wind hold, standby,
  weather check, scheduled to start later today); `closed` = not running today; `unknown` = wording
  the scraper doesn't recognise yet (the original text is always kept in `raw`).
- **Several measuring stations** (summit and base): snow depth and temperature are taken from the
  summit / top station.
- **Runs open** counts partly open runs as open.
- Each parser's notes at the top of `scraper/parsers/<resort>.py` explain anything resort-specific
  (for example, Shiga Kogen combines its 18 ski areas, and Hakuba skips night-session rows).

## Summit and base temperatures (Open-Meteo)

Besides the resort's own reading, every resort gets a daily low/high at its summit and base
height (set in `resorts.yaml`), from [Open-Meteo](https://open-meteo.com/) (free, no key,
non-commercial use, credit shown in the website footer). Code: `scraper/weather.py`.

- Each morning, today's record gets the **forecast** low/high (`temps.kind = "forecast"`).
- The next morning that forecast is **replaced** by the day's **final** low/high
  (`temps.kind = "final"`); the forecast isn't kept. Runs look back 7 days, so a missed morning
  is filled in later, and on 1 May the off-season run still finalises 30 April.
- With the final values, the day's **24 hourly temperatures** at summit and base are stored too
  (`temps.hourly.summit` / `temps.hourly.base`, 00:00–23:00 Japan time).
- "Final" values are the weather model's best estimate of what happened (from observations and
  satellites), not a thermometer on the slope.
- If Open-Meteo can't be reached, the run carries on without temperatures and catches up next time.

## What each resort publishes

| Resort | Hours | Snow depth | Temperature | Runs |
|---|---|---|---|---|
| Niseko Grand Hirafu | yes | yes | yes | yes |
| Kiroro | N/A | yes | yes | yes |
| Rusutsu | yes | N/A | N/A | yes |
| Furano | yes | yes | yes | yes |
| Tomamu | N/A | yes | yes | yes |
| Sapporo Kokusai | when open | N/A | N/A | yes |
| Sapporo Teine | yes | yes | yes | yes |
| Shiga Kogen | yes | N/A | yes (coldest area) | yes |
| Hakuba Goryu / 47 / Happo-one | N/A | yes | N/A | N/A |
| Nozawa Onsen | in season | in season | in season | yes |
| GALA Yuzawa | N/A | N/A | N/A | yes |
| Zao Onsen | yes | yes | yes | yes |
