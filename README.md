# Ski Status

Records which ski lifts are open each day at selected Japanese resorts, and shows it on a static website.

- `resorts.yaml`: the season months and the list of resorts
- `scraper/`: the Python scraper (`run.py` plus one small parser per resort in `scraper/parsers/`)
- `docs/`: the website, served by GitHub Pages; the data lives in `docs/data/`
- `tests/`: checks that each parser still reads a saved copy of its resort's page
- `.github/workflows/scrape.yml`: runs the scraper every 45 minutes from 09:08 to 21:08 Japan time and commits any changes
- `.github/workflows/tests.yml`: runs the tests whenever code is pushed

## Setup (once)

```
python -m pip install -r requirements.txt
python -m playwright install chromium
```

## Everyday commands (run in the project folder)

| What | Command |
|---|---|
| Update live lift/run status (and the daily record if it's after 09:30 and not done yet; does nothing off-season) | `python -m scraper.run` |
| Also rewrite today's daily record now | `python -m scraper.run --daily` |
| Scrape even off-season | `python -m scraper.run --force` |
| Scrape one resort | `python -m scraper.run --only zao-onsen` |
| Check the parsers still work | `python -m unittest -v` |
| Preview the website | `python -m http.server -d docs`, then open http://localhost:8000 |

Re-running is safe: live.json is only rewritten when a status changed, and a re-run never replaces
a good result with a failure or a shorter lift list.

## The website (`docs/`)

Plain HTML/CSS/JavaScript, no build step. Pages (the part after `#` in the address):

| Page | Address | What's on it |
|---|---|---|
| Home | `#/` | Large "Ski Status" title over contour lines (`docs/contours.svg`, used as a mask so it takes the theme colour), a "Find resorts" button, and the pinned resorts (up to 5) or, with none pinned, a prompt that leads to Resorts |
| Resorts | `#/resorts` | "Find resort" search, pinned resorts, resort table grouped by region (collapsible) |
| One resort | `#/resort/<id>` | Boxes (lifts, runs, snow depth, new snow, base and summit temperature), lifts and runs lists, trail map |
| One resort, past day | `#/resort/<id>/<YYYY-MM-DD>` | The same for a historical record (final temperatures, day's mean vs season) |
| Historical | `#/history` | Season/Month picker at the top (remembers the last season or month chosen anywhere in Historical; first visit: latest season), search, and a table like Home with pins and region dropdowns: most lifts open, most runs open (by grade), mean base temperature, mean snow depth over that period. A resort opens its history at the same period |
| A resort's history | `#/history/<id>/<unit>/<value>` | unit = `season` (2026-27), `month` (2026-12), `week` (the Sunday it starts) or `day`; period picker with search and ‹ › arrows; opening/closing day and first/last snow; lifts box that expands to the graph; "+ Compare" adds the resort and its season to Compare and moves Compare's time range to the larger period (a season makes it whole season; a month, or a week/day as its month, widens the month range): the name flies into the Compare tab, whose badge counts resorts added since Compare was last opened |

| Compare | `#/compare` | One list of up to 10 resorts, each with a season (e.g. 26-27), shared by both modes, and one time range at the top for all of them: Season (each resort's whole season) or Month, from one month to another (e.g. December–January of each resort's own season). Graph mode: a line each, seasons lined up by date; choose the data point and "As a percentage". Side-by-side mode: a column each, sections open together |

**Night skiing:** `night_skiing` in `resorts.yaml` (per season: dates, hours, lifts) shows a moon
symbol beside the resort and its night lifts; hovering shows the dates.

**Historical boxes** (season / month / week; each expands to a graph when clicked):

| Box | Number | Graph | Go to day |
|---|---|---|---|
| Lifts | lifts opened at least once / total | lifts open per day | lifts table |
| Runs | runs opened at least once / total, by difficulty | runs open per day | runs table |
| Snow depth | mean depth (season: Dec–Apr only) | depth per day | – |
| New snow | days it snowed / days from first to last snow (season) or days in the month/week | bars: new snow per day / week / month | – |
| Base, Summit | mean of daily means (season: Dec–Apr only) | daily mean temperature | – |

New snow amounts are the resort's own reports where it publishes them, otherwise Open-Meteo's
daily snowfall at the summit. Day view: lifts and runs boxes open that day's table directly. In
any "go to day" view, ‹ › that cross into another month/week/day also move the period selector,
and stop at the season's first and last day. Lists below the boxes show each lift's and run's
status over the period ("28 Nov – present", "Opened on 5 Dec", "Open until 20 Dec", "Open", "Closed").

**The graph** (`docs/graph.js`) shows values over a period (a line, or bars for new snow): hover for a small box with that day's
details, click to pin it (click elsewhere to close), "Go to specific day" opens that day with
‹ › arrows and "Return to graph". Keyboard: ← → move between days, Enter opens the day.

**Demo mode:** add `?demo` before the `#` (e.g. `.../ski-lift-status/?demo#/history/niseko-hirafu`)
to fill in a made-up 2025-26 season for trying the Historical tab. It's only in the browser and
never saved; pages show a "Demo mode" banner.

**Opening and closing day:** worked out from the daily records, no extra scraping. Opening day =
the first day any run was open; closing day = the last day any run was open, filled in once the
season is over (after 31 May). Hakuba Valley doesn't publish runs, so its resorts use lifts instead. First and last snow: days with snow at the
summit (Open-Meteo) or new snow reported by the resort.

- Table columns: lifts open / total · runs open by grade (green, red, black, orange = expert,
  grey = level not published; partly open counts as open; two-level runs count under the harder
  grade) · base temperature (live, or today's forecast low/high if live isn't available) · snow depth.
- Search suggestions (max 3): with nothing typed, recently viewed resorts first, then A–Z. While
  typing, matches are ranked by relevance (name starts with it > a word starts with it > appears
  inside a name > region), with recently viewed matches moved to the top. Enter opens the
  highlighted suggestion, or the only one left.
- Pins, recently viewed resorts and which regions are collapsed are saved in the visitor's own
  browser (localStorage), not on the server.
- Lift and run status come from `docs/data/live.json` (re-checked by the browser every 5 minutes);
  snow depth, new snow and weather come from the day's permanent record.
- Live temperatures: the browser asks Open-Meteo for the current temperature at each resort's
  summit and base when the page opens, and every 15 minutes while it stays open.

## Schedule: what is collected when

GitHub runs the scraper every 45 minutes from 09:08 to 21:08 Japan time (in season).

| Data | When | Kept? |
|---|---|---|
| Lift and run status | every run | `live.json` is replaced each time (only when something changed); the first run at or after 09:30 also saves it as the day's permanent record |
| Snow depth, new snow, resort's "last updated" time | first run at or after 09:30 | permanent daily record |
| Forecast min/max/mean temperature (summit, base), next snow | first run at or after 09:30 | replaced/deleted the next morning |
| Final min/max/mean temperature, hours of snow (+ "snowed" = 3 h or more, for the animation) | next morning, for the day before | permanent |
| Live temperature, snowing now | visitor's browser, every 15 min while open | never stored |
| Season summary | first run at or after 09:30 | permanent (recalculated daily) |

The 09:30 time is `season.daily_time` in `resorts.yaml`. The resort's own temperature reading is not
stored (Open-Meteo covers temperatures). Replaced files stay in the git history, but the site never
shows old versions.

**Runs open but no lifts:** when a resort lists runs as open while no lifts are running (Hakuba's
run page is updated once in the morning, for example), the site shows a warning beside the runs.
Hakuba Goryu, Hakuba 47 and Happo-one get their runs from a second page (`runs_url` in `resorts.yaml`,
read by `parse_runs` in `scraper/parsers/hakuba_valley.py`); if it fails, lifts are still recorded.

## Season months

`season:` in `resorts.yaml` sets the months when data is collected (November–May).
Outside them the daily GitHub run scrapes nothing; instead, on the first run of each month it
updates `last_checked` in `docs/data/lifts.json` and commits that. GitHub switches off scheduled
workflows in public repositories after 60 days without activity, and this monthly commit
prevents that, so the schedule keeps running from one season to the next with no manual restart.

## When a resort changes its website

1. The scraper prints `FAILED` for that resort. The website keeps showing the last status it got;
   after 2 days of failed checks it adds a warning ("Couldn't reach the resort's status page since …")
   on the resort page and a ⚠ in the tables.
   You'll also get an email: a GitHub issue labelled **scraper alert** is opened when
   - a resort has failed on every run for 6 hours or more, or
   - the day's record lists far fewer lifts or runs than usual (under 75% of the most seen this season),
     which usually means the page layout changed and the parser misses some.

   The issue closes by itself once the resort works again (`scraper/alerts.py`).
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
resorts.<id>                       name, region, source_url, website, map {type, url, note},
                                   location {lat, lon}, elevation_m {summit, base}
seasons.<2026-27>.file             "seasons/2026-27.json"
seasons.<2026-27>.dates            every date recorded that season
seasons.<2026-27>.summary.<id>     lifts_total, runs_total, snow_depth_max_cm, snow_depth_max_date,
                                   summit_min_c, summit_max_c, base_min_c, base_max_c (season range
                                   from the FINAL daily lows/highs), summit_lowest_mean_c,
                                   summit_highest_mean_c, base_lowest_mean_c, base_highest_mean_c,
                                   new_snow_min_cm, new_snow_max_cm, new_snow_mean_cm, days_recorded
```

`docs/data/seasons/2026-27.json` (one per season, written on one line to keep it small):
```
season                             "2026-27" (seasons run July–June, so Nov–May stays in one file)
days[].date                        Japan date, e.g. 2026-11-27
days[].results.<id>                scraped_at, ok, error (if failed), source_updated, lifts_open, runs_open,
                                   snow_depth_cm, new_snow_cm, temps, snow_outlook (today only),
                                   lifts[], runs[]   (records before 28 Nov 2026 also have temperature_c)
days[].results.<id>.temps          kind ("forecast" for today, "final" once the day is over),
                                   summit {elevation_m, min_c, max_c, mean_c}, base {...},
                                   snow_hours, snowed (final days only: hours of snow at the summit,
                                   and whether that was 3 or more)
days[].results.<id>.snow_outlook   {date, days, cm}: next day with >= 1 cm of snow forecast at the
                                   summit (date null if none in 16 days); deleted once the day is over
days[].results.<id>.lifts[]        name, name_en, status (open/closed/hold/unknown), raw, hours, lift_type
days[].results.<id>.runs[]         name, name_en, status (open/partial/closed/unknown), raw, level
```

`docs/data/live.json` (latest lift/run status, replaced on every run that finds a change):
```
date                               Japan date the statuses are for
updated                            when a status last changed
results.<id>                       ok, lifts_open, runs_open, lifts[], runs[]  (or ok: false, error)
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
  is filled in later, and on 1 June the off-season run still finalises 31 May.
- Today's record also gets a **snow outlook**: the next day with at least 1 cm of snow forecast at
  the summit (up to 16 days ahead), shown as "Next snow in N days". It's deleted once the day is over.
- Final days also store the day's **mean** temperature and how many **hours it snowed** at the
  summit (`snowed` = 3 hours or more). Hourly values themselves are not kept.
- **Live** temperature and "is it snowing now" are fetched by the visitor's browser and never stored.
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
| Hakuba Goryu / 47 / Happo-one | N/A | yes | N/A | yes (separate pages, no difficulty) |
| Nozawa Onsen | in season | in season | in season | yes |
| GALA Yuzawa | N/A | N/A | N/A | yes |
| Zao Onsen | yes | yes | yes | yes |
