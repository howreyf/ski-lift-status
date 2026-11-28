# Ski Status

Records which ski lifts are open each day at selected resorts in Japan, Europe and North America,
and shows it on a static website.

- `resorts.yaml`: the schedule, the resort groups (Japan, Europe, North America) and the list of resorts
- `scraper/`: the Python scraper (`run.py` plus one small parser per resort in `scraper/parsers/`)
- `docs/`: the website, served by GitHub Pages; the data lives in `docs/data/`
- `tests/`: checks that each parser still reads a saved copy of its resort's page
- `.github/workflows/scrape.yml`: starts the scraper every 45 minutes around the clock; each run scrapes the
  resorts whose local time is 09:00–21:00, and commits any changes
- `.github/workflows/tests.yml`: runs the tests whenever code is pushed

## Setup (once)

```
python -m pip install -r requirements.txt
python -m playwright install chromium
```

## Everyday commands (run in the project folder)

| What | Command |
|---|---|
| Update live lift/run status of the resorts inside their hours now (and their daily record if it's after 09:30 there and not done yet) | `python -m scraper.run` |
| Also rewrite today's daily record now | `python -m scraper.run --daily` |
| Scrape every resort now, even off-season or at night there | `python -m scraper.run --force` |
| Scrape one resort | `python -m scraper.run --only zao-onsen` |
| Check the parsers still work | `python -m unittest -v` |
| Preview the website | `python -m http.server -d docs`, then open http://localhost:8000 |

Re-running is safe: live.json is only rewritten when a status changed, and a re-run never replaces
a good result with a failure or a shorter lift list.

## The website (`docs/`)

Plain HTML/CSS/JavaScript, no build step. Pages (the part after `#` in the address):

| Page | Address | What's on it |
|---|---|---|
| Home | `#/` | Large "Ski Status" title and a "Find resorts" button, over a 3D contour drawing of a mountain range that runs behind the whole page (`docs/contours-light.svg` / `contours-dark.svg`: stacked contour layers seen diagonally from above and from a corner, higher layers hiding the ones behind). No small print on Home, and the pinned resorts (up to 5) or, with none pinned, a prompt that leads to Resorts |
| Resorts | `#/resorts` | "Find resort" search with a Sort button, country buttons, pinned resorts, resort table in a dropdown per country (collapsible) with the regions as headings inside |
| (Countries) | Resorts and Historical | Buttons under the search: "All countries" or any mix of Japan, Italy, Germany, Austria, USA, Canada (pinned resorts always show). Kept in the browser |
| (Sort) | Resorts and Historical | Sort by number of runs or lifts, lifts or runs open, runs (or runs open) of one difficulty, snow depth, base temperature or night skiing; high to low or low to high; "Keep resorts in their countries" sorts inside each country dropdown, otherwise one list. N/A always last. Shared by both tabs, kept in the browser (`docs/sort.js`). On Historical the values are for the chosen period (peaks and means) |
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

- Table columns: lifts open / total · runs open by grade · base temperature (live, or today's
  forecast low/high if live isn't available) · snow depth.
- Run grades: Japan green / red / black / orange (expert); Europe blue / red / black; North America
  green circle, blue square (double blue counts as blue), black diamond, double black (black circle
  with a white ring), terrain park (purple); grey = level not published. Partly open counts as open;
  two-level Japanese runs count under the harder grade. The legend lists the grades shown.
- Search suggestions (max 3): with nothing typed, recently viewed resorts first, then A–Z. While
  typing, matches are ranked by relevance (name starts with it > a word starts with it > appears
  inside a name > region > country), with recently viewed matches moved to the top. Enter opens the
  highlighted suggestion, or the only one left.
- Pins, recently viewed resorts, the country buttons and which countries are collapsed are saved
  in the visitor's own browser (localStorage), not on the server.
- Lift and run status come from the groups' live files (re-checked by the browser every 5 minutes);
  snow depth, new snow and weather come from the day's permanent record.
- Times are shown in the resort's own time zone (JST, CET, MST...); "last change" in the tables is
  in the visitor's time. Each resort's "today" is its own latest local day.
- Live temperatures: the browser asks Open-Meteo for the current temperature at each resort's
  summit and base when the page opens, and every 15 minutes while it stays open.

## Schedule: what is collected when

GitHub starts the scraper every 45 minutes, all day (UTC). Each run scrapes only the resorts whose
**local** time is between 09:00 and 21:00 (`schedule.hours` in `resorts.yaml`; runs up to 22:00
still count, because GitHub often starts them late) and whose group is in season. So Japan is
scraped around 00:00–12:00 UTC, Europe around 08:00–20:00 UTC and North America around
16:00–05:00 UTC. A run with nobody inside their hours finishes in seconds and commits nothing.
Playwright (the browser) is only installed when a resort that needs it (Whistler Blackcomb) is due.

| Data | When | Kept? |
|---|---|---|
| Lift and run status | every run | the group's live file is replaced each time (only when something changed); the first run at or after 09:30 local also saves it as the day's permanent record |
| Snow depth, new snow, resort's "last updated" time | first run at or after 09:30 local | permanent daily record |
| Forecast min/max/mean temperature (summit, base), next snow | first run at or after 09:30 local | replaced/deleted the next morning |
| Final min/max/mean temperature, hours of snow (+ "snowed" = 3 h or more, for the animation) | next morning, for the day before | permanent |
| Live temperature, snowing now | visitor's browser, every 15 min while open | never stored |
| Season summary | first run at or after 09:30 local | permanent (recalculated daily) |

The 09:30 time is `schedule.daily_time` in `resorts.yaml`. The resort's own temperature reading is not
stored (Open-Meteo covers temperatures). Replaced files stay in the git history, but the site never
shows old versions.

**Runs open but no lifts:** when a resort lists runs as open while no lifts are running (Hakuba's
run page is updated once in the morning, for example), the site shows a warning beside the runs.
Hakuba Goryu, Hakuba 47 and Happo-one get their runs from a second page (`runs_url` in `resorts.yaml`,
read by `parse_runs` in `scraper/parsers/hakuba_valley.py`); if it fails, lifts are still recorded.

## Resort groups and season months

`groups:` in `resorts.yaml` has one entry per group (japan, europe, north-america): its data files
(so no file grows too big, and a change in Europe doesn't rewrite Japan's file), its season months
(Japan and North America November–May, Europe October–May for the glaciers) and default country
and time zone. Each resort says which `group` it's in (default japan), its `country` and `timezone`.
When every group is off-season the GitHub run scrapes nothing; instead, on the first run of each month it
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
2. Save the new page over `tests/fixtures/<parser>.html` (or `.json`; `<resort id>.json` where
   several resorts share a parser, plus `_runs` / `_snow` copies for separate runs / snow pages).
3. Fix `scraper/parsers/<resort>.py` until `python -m unittest -v` passes.

## Data format

Two kinds of file in `docs/data/`, per group. The website loads the small index first, then the
groups' season files for the season being viewed (merged by date) and their live files.

`docs/data/lifts.json` (index, small, indented):
```
last_updated                       when lift data was last scraped
last_checked                       when the scraper last ran (includes off-season monthly check-ins)
groups.<group>                     name, live ("live-europe.json"), season_months {start, end}
schedule                           hours ["09:00", "21:00"], daily_time (local times)
resorts.<id>                       name, region, country, group, timezone, source_url, website,
                                   map {type, url, note}, location {lat, lon}, elevation_m {summit, base}
seasons.<2026-27>.files            {japan: "seasons/2026-27.json", europe: "seasons/europe/2026-27.json", ...}
seasons.<2026-27>.file             Japan's file (for older versions of the website)
seasons.<2026-27>.dates            every date recorded that season (any group); dates_by_group per group
seasons.<2026-27>.summary.<id>     lifts_total, runs_total, snow_depth_max_cm, snow_depth_max_date,
                                   summit_min_c, summit_max_c, base_min_c, base_max_c (season range
                                   from the FINAL daily lows/highs), summit_lowest_mean_c,
                                   summit_highest_mean_c, base_lowest_mean_c, base_highest_mean_c,
                                   new_snow_min_cm, new_snow_max_cm, new_snow_mean_cm, days_recorded
```

`docs/data/seasons/2026-27.json` (Japan), `seasons/europe/2026-27.json`, `seasons/north-america/2026-27.json`
(one per group and season, written on one line to keep them small):
```
season                             "2026-27" (seasons run July–June, so Oct–May stays in one file)
days[].date                        the resort's local date, e.g. 2026-11-27
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

`docs/data/live.json` (Japan), `live-europe.json`, `live-north-america.json` (latest lift/run
status, replaced on every run that finds a change):
```
date                               newest local date among the entries
updated                            when a status last changed (any resort in the file)
results.<id>                       date (the resort's local date), changed (when its status last
                                   changed), ok, lifts_open, runs_open, lifts[], runs[]
                                   (or ok: false, error, failing_since)
```

`level` is, in Japan, Beginner / Intermediate / Advanced / Expert / First timer (or two joined, e.g.
"Intermediate/Advanced"); in Europe Blue / Red / Black; in North America Green circle / Blue square /
Double blue square / Black diamond / Double black diamond / Terrain park; or N/A. An empty `runs` list means the resort doesn't publish runs.

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
| Niseko Annupuri / Village / Hanazono | yes | yes (summit) | N/A | yes (no difficulty) |
| Breuil-Cervinia | yes | N/A | N/A | yes |
| Livigno | N/A | N/A | N/A | N/A (all of Livigno's lifts on one page, no run list) |
| Zugspitze | when open | N/A | N/A | yes (no difficulty) |
| Zell am See-Kaprun | yes | N/A | N/A | yes (Kitzsteinhorn and Schmittenhöhe; lifts list has the main cable cars and gondolas only) |
| Big Sky | when given | yes | N/A | yes |
| Aspen Mountain | yes | yes | N/A | yes |
| Jackson Hole | N/A | yes (mid-mountain) | N/A | yes |
| Whistler Blackcomb | yes | N/A | N/A | yes (page opened in a browser: Vail Resorts refuses plain downloads) |

Abroad, the scraper reads the same JSON feeds the resorts' own pages load (Niseko's yukiyama API,
Big Sky, Aspen, Jackson Hole), or the page itself. Snow depth there is converted from inches where needed.
