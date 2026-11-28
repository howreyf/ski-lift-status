"""Check each parser still reads its saved page correctly.

Run from the project folder:   python -m unittest -v

The pages in tests/fixtures/ were saved on 2026-11-27. When a resort changes its
website: save the new page over its fixture, fix the parser, and update the
numbers for that resort in EXPECTED below.
"""

import importlib
import re
import unittest
from pathlib import Path

from scraper.common import (GRADE_NAMES, NA, RUN_STATUSES, STATUSES, clean_hours, guess_lift_type, level_en,
                            run_status_from_text, status_from_text, to_number)
from scraper.run import (in_season, load_config, load_season, monthly_check_in, save_season,
                         season_of, store_result, update_summary)

FIXTURES = Path(__file__).parent / "fixtures"
LIFT_TYPES = {"Ropeway", "Gondola", "Magic carpet", "Eight", "Six", "Quad", "Triple", "Pair", "Single",
              "Chairlift", "Surface lift", "Train", NA}
LEVELS = {"First timer", "Beginner", "Intermediate", "Advanced", "Expert", NA, *GRADE_NAMES}
JAPANESE = re.compile(r"[぀-ヺー-ヿ一-鿿]")  # skips the "・" separator

# resort id: (lifts, open, hold, runs_open, runs_total, snow_depth_cm, new_snow_cm, temperature_c)
EXPECTED = {
    "niseko-hirafu":    (9, 0, 0, 0, 22, 130, 0, 1.4),
    "kiroro":           (9, 0, 0, 0, 24, 100, 0, -2),
    "rusutsu":          (18, 0, 0, 0, 50, None, None, None),
    "furano":           (11, 0, 0, 0, 28, 65, 2, -3),
    "tomamu":           (6, 0, 0, 0, 29, 50, 0, -1),
    "sapporo-kokusai":  (5, 2, 0, 7, 8, None, None, None),
    "sapporo-teine":    (10, 0, 0, 0, 15, 50, 1, -1),
    "shiga-kogen":      (49, 2, 1, 3, 110, None, 15, -5),
    "hakuba-goryu":     (11, 2, 0, None, None, 105, None, None),
    "hakuba-47":        (5, 4, 0, None, None, 105, None, None),
    "hakuba-happo-one": (19, 3, 0, None, None, 124, None, None),
    "nozawa-onsen":     (16, 0, 0, 0, 45, None, None, None),
    "gala-yuzawa":      (10, 0, 0, 0, 21, None, None, None),
    "zao-onsen":        (26, 3, 1, 0, 23, 40, 5, -5),
    # Niseko United (yukiyama feeds)
    "niseko-annupuri":  (6, 2, 0, 12, 13, 30, None, None),
    "niseko-village":   (8, 0, 0, 0, 28, 183, None, None),
    "niseko-hanazono":  (4, 1, 0, 0, 12, 37, None, None),
    # Europe
    "breuil-cervinia":  (14, 0, 0, 0, 34, 130, None, None),
    "livigno":          (32, 14, 0, None, None, 36, None, None),
    "zugspitze":        (8, 6, 0, 3, 12, 40, None, None),
    "zell-am-see-kaprun": (18, 7, 0, 9, 40, 60, None, None),
    # North America
    "big-sky":          (40, 0, 0, 11, 318, 48, 8, None),
    "aspen-mountain":   (6, 0, 0, 4, 138, 33, 0, None),
    "jackson-hole":     (13, 0, 0, 6, 155, 20, 3, None),
    "whistler-blackcomb": (12, 0, 0, 26, 295, 98, 3, None),
}
# Wording that honestly means "we don't know" (allowed to give status "unknown").
UNKNOWN_WORDING = {"no information"}


def fixture_for(resort: dict, part: str = "") -> Path | None:
    """tests/fixtures/<resort id or parser><part>.json|.html (a resort's own copy first, for
    parsers several resorts share). part: "" (main page), "_runs" or "_snow"."""
    for key in (resort["id"], resort["parser"]):
        for ext in (".json", ".html"):
            if (path := FIXTURES / f"{key}{part}{ext}").exists():
                return path
    return None


def parse_fixture(resort: dict) -> dict:
    """Like scrape_resort: the main page, plus the saved runs / snow pages where the resort
    has runs_url / snow_url and a saved copy exists."""
    parser = importlib.import_module(f"scraper.parsers.{resort['parser']}")
    options = resort.get("options") or {}
    parsed = parser.parse(fixture_for(resort).read_text(encoding="utf-8"), options)
    if resort.get("runs_url") and (path := fixture_for(resort, "_runs")):
        parsed["runs"] = parser.parse_runs(path.read_text(encoding="utf-8"), options)
    if resort.get("snow_url") and (path := fixture_for(resort, "_snow")):
        parsed.update({k: v for k, v in parser.parse_snow(path.read_text(encoding="utf-8"), options).items() if v is not None})
    return parsed


class TestEveryResort(unittest.TestCase):
    """Same checks for every resort in resorts.yaml."""

    @classmethod
    def setUpClass(cls):
        cls.resorts = load_config()
        cls.results = {r["id"]: parse_fixture(r) for r in cls.resorts}

    def test_every_resort_has_expected_numbers(self):
        self.assertEqual(set(EXPECTED), {r["id"] for r in self.resorts}, "EXPECTED out of sync with resorts.yaml")
        for rid, (n, n_open, n_hold, runs_open, runs_total, depth, new, temp) in EXPECTED.items():
            with self.subTest(resort=rid):
                r = self.results[rid]
                statuses = [l["status"] for l in r["lifts"]]
                runs = r["runs"]
                self.assertEqual(len(statuses), n, "number of lifts")
                self.assertEqual(statuses.count("open"), n_open, "lifts open")
                self.assertEqual(statuses.count("hold"), n_hold, "lifts on hold")
                self.assertEqual(sum(x["status"] in ("open", "partial") for x in runs) if runs else None,
                                 runs_open, "runs open (incl. partly open)")
                self.assertEqual(len(runs) or None, runs_total, "runs total")
                self.assertEqual(r["snow_depth_cm"], depth, "snow depth")
                self.assertEqual(r["new_snow_cm"], new, "new snow")
                self.assertEqual(r.get("temperature_c"), temp, "temperature")

    def test_night_skiing_lifts_exist(self):
        """Every lift named under night_skiing in resorts.yaml must match a real lift name."""
        from scraper.parsers.hakuba_valley import NAMES_EN
        for r in self.resorts:
            names = {l["name"] for l in self.results[r["id"]]["lifts"]} | {l["name_en"] for l in self.results[r["id"]]["lifts"]}
            if r["parser"] == "hakuba_valley":
                names |= set(NAMES_EN.values())  # Goryu's Iimori lifts are missing from the saved page
            for season, ns in (r.get("night_skiing") or {}).items():
                with self.subTest(resort=r["id"], season=season):
                    self.assertEqual([l for l in ns.get("lifts", []) if l not in names], [])

    def test_lift_records_are_well_formed(self):
        for rid, r in self.results.items():
            with self.subTest(resort=rid):
                names = [l["name"] for l in r["lifts"]]
                self.assertEqual(len(names), len(set(names)), "lift names must be unique")
                for l in r["lifts"]:
                    self.assertEqual(set(l), {"name", "name_en", "status", "raw", "hours", "lift_type"})
                    self.assertTrue(l["name"] and l["name_en"], l)
                    self.assertIn(l["status"], STATUSES, l)
                    if l["raw"].lower() not in UNKNOWN_WORDING:
                        self.assertNotEqual(l["status"], "unknown", f"status wording not recognised: {l}")
                    self.assertIn(l["lift_type"], LIFT_TYPES, l)
                    self.assertRegex(l["hours"], r"^(\d{2}:\d{2}-\d{2}:\d{2}|N/A)$", l)

    def test_run_records_are_well_formed(self):
        for rid, r in self.results.items():
            with self.subTest(resort=rid):
                names = [x["name"] for x in r["runs"]]
                self.assertEqual(len(names), len(set(names)), "run names must be unique")
                for x in r["runs"]:
                    self.assertEqual(set(x), {"name", "name_en", "status", "raw", "level"})
                    self.assertTrue(x["name"] and x["name_en"], x)
                    self.assertIn(x["status"], RUN_STATUSES, x)
                    self.assertNotEqual(x["status"], "unknown", f"run status wording not recognised: {x}")
                    self.assertIn(x["level"], LEVELS | {"Beginner/Intermediate", "Intermediate/Advanced"}, x)

    def test_english_names_for_japanese_lifts_and_runs(self):
        for rid, r in self.results.items():
            with self.subTest(resort=rid):
                missing = [x["name"] for x in r["lifts"] + r["runs"] if JAPANESE.search(x["name_en"])]
                self.assertEqual(missing, [], "add these to the parser's NAMES_EN / RUN_NAMES_EN")

    def test_source_updated_format(self):
        for rid, r in self.results.items():
            with self.subTest(resort=rid):
                if r["source_updated"] is not None:
                    # ISO time with its offset (Japanese resorts give +09:00; feeds abroad UTC or local)
                    self.assertRegex(r["source_updated"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$")


class TestSpecificLifts(unittest.TestCase):
    """Spot checks of single lifts where the parser does something special."""

    @classmethod
    def setUpClass(cls):
        resorts = {r["id"]: r for r in load_config()}
        cls.lifts = {rid: {l["name_en"]: l for l in parse_fixture(r)["lifts"]} for rid, r in resorts.items()}

    def test_zao_hold_with_hours(self):
        self.assertEqual(self.lifts["zao-onsen"]["Zao Chuo Ropeway"], {
            "name": "蔵王中央ロープウェイ", "name_en": "Zao Chuo Ropeway", "status": "hold",
            "raw": "運転見合わせ", "hours": "08:30-16:00", "lift_type": "Ropeway",
        })

    def test_kiroro_without_lift_table_finds_no_lifts(self):
        """Without its lift table, the course table under the next heading must not be read as lifts."""
        from bs4 import BeautifulSoup
        from scraper.parsers import kiroro
        soup = BeautifulSoup((FIXTURES / "kiroro.html").read_text(encoding="utf-8"), "html.parser")
        heading = next(h for h in soup.select("section h6") if h.get_text(strip=True).upper() == "LIFT STATUS")
        heading.find_next("table").decompose()
        self.assertEqual(kiroro.parse(str(soup), {})["lifts"], [])

    def test_furano_duplicate_names_get_zone(self):
        self.assertIn("Snow Escalator (Furano)", self.lifts["furano"])
        self.assertIn("Snow Escalator (Kitanomine)", self.lifts["furano"])

    def test_kokusai_open_when_hours_shown(self):
        l = self.lifts["sapporo-kokusai"]["SkyCabin8"]
        self.assertEqual((l["status"], l["hours"], l["lift_type"]), ("open", "09:00-15:20", "Gondola"))

    def test_hakuba_skips_night_sessions(self):
        self.assertFalse(any("Night" in n for n in self.lifts["hakuba-goryu"]))

    def test_happo_one_runs_from_the_trail_conditions_page(self):
        from scraper.parsers.hakuba_valley import parse_runs
        html = (FIXTURES / "happo_trails.html").read_text(encoding="utf-8")  # saved 2026-11-27
        runs = parse_runs(html, {"runs_page": "happo"})
        self.assertEqual(len(runs), 33)
        self.assertEqual([r["name"] for r in runs if r["status"] == "open"], ["Panorama Course"])
        self.assertTrue(all(r["status"] in ("open", "partial", "closed") for r in runs))
        levels = {r["name"]: r["level"] for r in runs}
        self.assertEqual(sum(v != "N/A" for v in levels.values()), 21)  # from the trail guide; 12 not in it
        self.assertEqual((levels["Panorama Course"], levels["Tenbo Course"], levels["Central Course"]),
                         ("Intermediate", "Expert", "Intermediate/Advanced"))
        self.assertEqual(levels["Panorama Cat Track"], "N/A")
        with self.assertRaises(ValueError):
            parse_runs("<html></html>", {"runs_page": "happo"})

    def test_teine_run_difficulty_from_course_guide(self):
        from scraper.parsers import sapporo_teine
        runs = sapporo_teine.parse((FIXTURES / "sapporo_teine.html").read_text(encoding="utf-8"), {})["runs"]
        levels = {r["name"]: r["level"] for r in runs}
        self.assertNotIn("N/A", levels.values(), "every Teine run should have a difficulty")
        self.assertEqual(levels["KITAKABE"], "Expert")
        self.assertEqual(levels["Natural"], "Beginner")
        self.assertEqual(levels["Ocean Dive"], "Advanced")

    def test_hakuba_runs_from_the_slope_conditions_page(self):
        from scraper.parsers.hakuba_valley import parse_runs
        html = (FIXTURES / "hakuba_slopes.html").read_text(encoding="utf-8")  # saved 2026-11-27
        goryu = parse_runs(html, {"runs_sections": ["toomi", "iimori"]})
        h47 = parse_runs(html, {"runs_sections": ["hakuba47"]})
        self.assertEqual((len(goryu), sum(r["status"] == "open" for r in goryu)), (24, 7))
        self.assertEqual((len(h47), sum(r["status"] == "open" for r in h47)), (23, 20))
        self.assertFalse(any("Night" in r["name"] or "Sunrise" in r["name"] for r in goryu))  # sessions skipped
        self.assertIn("Toomi Slope(Upper)", [r["name"] for r in goryu])                     # a real run, kept
        names47 = [r["name"] for r in h47]
        self.assertEqual(len(names47), len(set(names47)), "duplicate run names get numbered")
        self.assertIn("Upper Route 7_B (2)", names47)
        levels = {r["name"]: r["level"] for r in goryu + h47}
        self.assertEqual((levels["Grand Prix"], levels["Champion Expert"], levels["Route 5"], levels["Upper Route 7"]),
                         ("Intermediate", "Advanced", "Intermediate", "Beginner"))
        self.assertEqual(levels["Champion Dynamic"], "N/A")  # no clear rating found
        with self.assertRaises(ValueError):
            parse_runs(html, {"runs_sections": ["no-such-section"]})

    def test_gala_japanese_and_english_names(self):
        l = self.lifts["gala-yuzawa"]["Diligence"]
        self.assertEqual((l["name"], l["lift_type"]), ("ディリジャンス", "Gondola"))

    def test_gala_japanese_only_page_gives_same_result(self):
        from scraper.parsers import gala_yuzawa
        en = gala_yuzawa.parse((FIXTURES / "gala_yuzawa.html").read_text(encoding="utf-8"), {})
        ja = gala_yuzawa.parse((FIXTURES / "gala_yuzawa_ja.html").read_text(encoding="utf-8"), {})
        self.assertEqual([(l["name"], l["name_en"], l["status"], l["lift_type"]) for l in ja["lifts"]],
                         [(l["name"], l["name_en"], l["status"], l["lift_type"]) for l in en["lifts"]])
        self.assertEqual([(r["name"], r["name_en"], r["status"], r["level"]) for r in ja["runs"]],
                         [(r["name"], r["name_en"], r["status"], r["level"]) for r in en["runs"]])

    def test_rusutsu_hours_from_feed(self):
        self.assertEqual(self.lifts["rusutsu"]["West No.1 Quad Lift"]["hours"], "09:00-16:30")


class TestCommon(unittest.TestCase):
    def test_hours(self):
        self.assertEqual(clean_hours("08:30〜16:00"), "08:30-16:00")
        self.assertEqual(clean_hours("8:30 AM – 4:30 PM"), "08:30-16:30")
        self.assertEqual(clean_hours("12:00PM-12:30AM"), "12:00-00:30")
        self.assertEqual(clean_hours("9:00-12:00<br />\n13:00-15:30"), "09:00-15:30")
        self.assertEqual(clean_hours("〜"), "N/A")
        self.assertEqual(clean_hours(None), "N/A")

    def test_numbers(self):
        self.assertEqual(to_number("40"), 40)
        self.assertEqual(to_number("-5"), -5)
        self.assertEqual(to_number("−2.5℃"), -2.5)
        self.assertIsNone(to_number("-"))
        self.assertIsNone(to_number(""))

    def test_status_words(self):
        cases = {
            "Operating": "open", "OPEN": "open", "平常運転": "open", "運行中": "open", "○": "open",
            "Temporarily suspended": "hold", "Temporally Suspended": "hold", "Stand-by": "hold",
            "Weather Pending": "hold", "運転見合わせ": "hold", "△": "hold",
            "Suspended": "closed", "Not Operating": "closed", "CLOSED": "closed", "Opening Soon": "closed",
            "運休/閉鎖中": "closed", "×": "closed", "-": "closed", "Suspension of operations": "closed",
            "something new": "unknown",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(status_from_text(raw), expected)

    def test_run_status(self):
        cases = {
            "○": "open", "OPEN": "open", "滑走可": "open", "オープン": "open",
            "△": "partial", "Partially Open": "partial", "一部規制あり": "partial",
            "×": "closed", "Closed": "closed", "滑走不可": "closed", "Opening Soon": "closed",
            "クローズ": "closed", "CLOSE 圧雪 [夜間]": "closed",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(run_status_from_text(raw), expected)

    def test_levels(self):
        cases = {
            "初級": "Beginner", "最上級": "Expert", "上級": "Advanced", "ELEMENTARY": "Beginner",
            "INTERMEDIATE LEVEL": "Intermediate", "初中級": "Beginner/Intermediate",
            "Intermediate to advanced level": "Intermediate/Advanced", "": "N/A",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(level_en(raw), expected)

    def test_lift_type(self):
        self.assertEqual(guess_lift_type("温泉第2クワット"), "Quad")
        self.assertEqual(guess_lift_type("Nagasaka gondola-link Double"), "Pair")
        self.assertEqual(guess_lift_type("Landau (51-seater ropeway)"), "Ropeway")
        self.assertEqual(guess_lift_type("Tilbury (3 seater Chairlift)"), "Triple")
        self.assertEqual(guess_lift_type("King Sixpack Lift #3"), "Six")
        self.assertEqual(guess_lift_type(None, "スカイケーブル"), "N/A")

    def test_season(self):
        self.assertEqual(season_of("2026-11-27"), "2026-27")
        self.assertEqual(season_of("2027-04-30"), "2026-27")
        self.assertEqual(season_of("2027-07-01"), "2027-28")


class TestSaving(unittest.TestCase):
    """How run.py merges results into the season files."""

    def ok(self, depth, temp, n_lifts=3):
        return {"scraped_at": "x", "ok": True, "snow_depth_cm": depth, "temperature_c": temp,
                "lifts": [], "_lifts_total": n_lifts, "_runs_total": 10}

    def test_rerun_replaces_but_failure_keeps_success(self):
        season = {"season": "2026-27", "days": []}
        store_result(season, "2026-12-01", "a", self.ok(50, -3))
        store_result(season, "2026-12-01", "a", self.ok(60, -4))
        self.assertEqual(season["days"][0]["results"]["a"]["snow_depth_cm"], 60)
        store_result(season, "2026-12-01", "a", {"scraped_at": "y", "ok": False, "error": "boom", "lifts": []})
        self.assertTrue(season["days"][0]["results"]["a"]["ok"])
        self.assertNotIn("_lifts_total", season["days"][0]["results"]["a"])

    def test_rerun_with_fewer_lifts_keeps_earlier_result(self):
        lift = {"name": "x", "status": "open"}
        season = {"season": "2026-27", "days": []}
        store_result(season, "2026-12-01", "a", dict(self.ok(50, -3), lifts=[lift] * 11))
        partial = dict(self.ok(50, -3), lifts=[lift] * 4, _lifts_total=4)
        store_result(season, "2026-12-01", "a", partial)
        self.assertEqual(len(season["days"][0]["results"]["a"]["lifts"]), 11)
        self.assertEqual(partial["_lifts_total"], 11)  # season total isn't lowered either

    def test_season_summary(self):
        season = {"season": "2026-27", "days": []}
        for date, depth, temp, new in [("2026-12-01", 50, -3, 0), ("2026-12-02", 80, -10, 15), ("2026-12-03", 80, 2, 4)]:
            store_result(season, date, "a", dict(self.ok(depth, temp), new_snow_cm=new))
        summary = {}
        update_summary(summary, season, "a", self.ok(80, 2, n_lifts=7))
        self.assertEqual(summary, {
            "lifts_total": 7, "runs_total": 10,
            "snow_depth_max_cm": 80, "snow_depth_max_date": "2026-12-02",
            # No daily temperatures recorded in this test (see TestTemperatures).
            "summit_min_c": None, "summit_max_c": None, "base_min_c": None, "base_max_c": None,
            "summit_lowest_mean_c": None, "summit_highest_mean_c": None,
            "base_lowest_mean_c": None, "base_highest_mean_c": None,
            "summit_mean_c": None, "base_mean_c": None, "snow_depth_mean_cm": 70.0,
            "new_snow_min_cm": 0, "new_snow_max_cm": 15, "new_snow_mean_cm": 6.3,
            "days_recorded": 3,
        })

    def test_season_file_is_compact_and_round_trips(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            season = {"season": "2026-27", "days": [{"date": "2026-12-01", "results": {"a": {"ok": True}}}]}
            save_season(season, Path(tmp))
            text = (Path(tmp) / "seasons" / "2026-27.json").read_text(encoding="utf-8")
            self.assertEqual(text.count("\n"), 1, "season files are one line (no indentation)")
            self.assertEqual(load_season("2026-27", Path(tmp)), season)
            self.assertEqual(load_season("2030-31", Path(tmp)), {"season": "2030-31", "days": []})


class TestLive(unittest.TestCase):
    """live.json: latest lift/run status, rewritten only when something changes."""

    def result(self, statuses, ok=True):
        lifts = [{"name": f"L{i}", "status": s} for i, s in enumerate(statuses)]
        if not ok:
            return {"ok": False, "error": "boom"}
        return {"ok": True, "lifts_open": statuses.count("open"), "runs_open": None, "lifts": lifts, "runs": []}

    def test_only_rewritten_when_status_changes(self):
        import json, tempfile
        from scraper.run import update_live
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "live.json"
            self.assertTrue(update_live({"a": self.result(["closed", "open"])}, "2026-12-01", "2026-12-01T07:00:00+09:00", path))
            self.assertFalse(update_live({"a": self.result(["closed", "open"])}, "2026-12-01", "2026-12-01T07:30:00+09:00", path))
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["updated"], "2026-12-01T07:00:00+09:00")
            self.assertTrue(update_live({"a": self.result(["open", "open"])}, "2026-12-01", "2026-12-01T08:00:00+09:00", path))
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual((data["updated"], data["results"]["a"]["lifts_open"]), ("2026-12-01T08:00:00+09:00", 2))

    def test_failure_or_shorter_list_keeps_earlier_status_today(self):
        import json, tempfile
        from scraper.run import update_live
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "live.json"
            update_live({"a": self.result(["open", "open", "closed"]), "b": self.result(["open"])}, "2026-12-01", "t1", path)
            # b's first failure is a change (it starts "failing_since"); the status itself is kept
            self.assertTrue(update_live({"a": self.result(["closed"]), "b": self.result([], ok=False)}, "2026-12-01", "t2", path))
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(len(data["results"]["a"]["lifts"]), 3)
            self.assertTrue(data["results"]["b"]["ok"])
            self.assertEqual(data["results"]["b"]["failing_since"], "t2")
            self.assertNotIn("failing_since", data["results"]["a"])
            # still failing: nothing new to commit
            self.assertFalse(update_live({"a": self.result(["closed"]), "b": self.result([], ok=False)}, "2026-12-01", "t3", path))

    def test_failing_since_kept_across_midnight_and_cleared_when_working(self):
        import json, tempfile
        from scraper.run import update_live
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "live.json"
            update_live({"a": self.result([], ok=False)}, "2026-12-01", "2026-12-01T20:00:00+09:00", path)
            update_live({"a": self.result([], ok=False)}, "2026-12-02", "2026-12-02T09:08:00+09:00", path)
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(data["results"]["a"]["failing_since"], "2026-12-01T20:00:00+09:00")
            self.assertFalse(data["results"]["a"]["ok"])
            self.assertTrue(update_live({"a": self.result(["open"])}, "2026-12-02", "2026-12-02T09:53:00+09:00", path))
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertNotIn("failing_since", data["results"]["a"])

    def test_todays_daily_record_is_the_baseline_for_a_new_live_file(self):
        import json, tempfile
        from scraper.run import live_entry, update_live
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "live.json"
            baseline = {"a": live_entry(self.result(["open"] * 11))}
            update_live({"a": self.result(["closed"] * 4)}, "2026-12-01", "t1", path, baseline=baseline)
            self.assertEqual(len(json.loads(path.read_text(encoding="utf-8"))["results"]["a"]["lifts"]), 11)

    def test_new_day_replaces_yesterday(self):
        import json, tempfile
        from scraper.run import update_live
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "live.json"
            update_live({"a": self.result(["open", "open"])}, "2026-12-01", "t1", path)
            self.assertTrue(update_live({"a": self.result(["closed"])}, "2026-12-02", "t2", path))  # new day: no carry-over
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual((data["date"], len(data["results"]["a"]["lifts"])), ("2026-12-02", 1))


class TestAlerts(unittest.TestCase):
    """scraper/alerts.py: GitHub issues when a resort's scraper looks broken."""
    RESORT = {"id": "a", "name": "Resort A", "url": "https://example.com/", "parser": "a"}

    def test_down_only_after_six_hours(self):
        from datetime import datetime
        from scraper.alerts import down_problem
        entry = {"ok": False, "failing_since": "2026-12-01T09:08:00+09:00", "error": "ConnectTimeout"}
        self.assertIsNone(down_problem(self.RESORT, entry, datetime.fromisoformat("2026-12-01T14:00:00+09:00")))
        p = down_problem(self.RESORT, entry, datetime.fromisoformat("2026-12-01T15:08:00+09:00"))
        self.assertEqual(p["key"], "down:a")
        self.assertIn("1 Dec 09:08 JST", p["title"])
        self.assertIn("ConnectTimeout", p["body"])
        self.assertIsNone(down_problem(self.RESORT, {"ok": True}, datetime.fromisoformat("2026-12-01T15:08:00+09:00")))

    def test_drop_compares_with_most_seen_this_season(self):
        from scraper.alerts import drop_problems
        day = lambda date, lifts, runs: {"date": date, "results": {"a": {"ok": True, "lifts": [{}] * lifts, "runs": [{}] * runs}}}
        season = {"days": [day("2026-12-01", 12, 20), day("2026-12-02", 10, 20)]}
        today = lambda lifts, runs: {"ok": True, "lifts": [{}] * lifts, "runs": [{}] * runs}
        self.assertEqual(drop_problems(self.RESORT, today(12, 20), season, "2026-12-03"), [])
        self.assertEqual(drop_problems(self.RESORT, today(9, 15), season, "2026-12-03"), [])   # 75% is fine
        keys = [p["key"] for p in drop_problems(self.RESORT, today(5, 0), season, "2026-12-03")]
        self.assertEqual(keys, ["drop-lifts:a", "drop-runs:a"])
        # a resort that never lists runs is never "missing" them
        no_runs = {"days": [day("2026-12-01", 12, 0)]}
        self.assertEqual(drop_problems(self.RESORT, today(12, 0), no_runs, "2026-12-03"), [])

    def test_plan_opens_new_closes_fixed_and_leaves_unchecked(self):
        from scraper.alerts import plan
        open_issues = [{"number": 1, "body": "x <!-- alert-key: down:a -->"},
                       {"number": 2, "body": "x <!-- alert-key: down:b -->"},
                       {"number": 3, "body": "x <!-- alert-key: drop-lifts:c -->"}]
        report = {"problems": [{"key": "down:a"}, {"key": "down:d"}],
                  "checked": ["down:b", "down:c"]}  # drop-lifts:c not checked (not a daily run)
        create, close = plan(open_issues, report)
        self.assertEqual([p["key"] for p in create], ["down:d"])
        self.assertEqual(close, [(2, "down:b")])

    def test_daily_record_written_by_first_run_after_0930(self):
        from scraper.run import daily_due
        season = {"days": [{"date": "2026-12-01", "results": {}}]}
        self.assertFalse(daily_due(season, "2026-12-02", "09:00", "09:30"))  # too early
        self.assertTrue(daily_due(season, "2026-12-02", "09:30", "09:30"))
        self.assertTrue(daily_due(season, "2026-12-02", "10:12", "09:30"))   # 09:30 run was late
        season["days"].append({"date": "2026-12-02", "results": {}})
        self.assertFalse(daily_due(season, "2026-12-02", "10:30", "09:30"))  # already written today


class TestRetries(unittest.TestCase):
    """fetch() retries refused connections, timeouts and server errors, but not 404s."""

    def run_fetch(self, outcomes):
        from unittest import mock
        import requests
        from scraper import common
        calls = []

        def fake_get(url, headers, timeout):
            outcome = outcomes[len(calls)]
            calls.append(url)
            if isinstance(outcome, Exception):
                raise outcome
            resp = mock.Mock(status_code=outcome, text="<html>ok</html>", encoding="utf-8")
            resp.raise_for_status = mock.Mock(side_effect=None if outcome < 400 else requests.HTTPError(f"{outcome}"))
            return resp

        with mock.patch.object(common.requests, "get", side_effect=fake_get), mock.patch.object(common.time, "sleep"):
            try:
                return common.fetch("https://example.test/"), len(calls)
            except Exception as e:
                return e, len(calls)

    def test_retries_then_succeeds(self):
        import requests
        result, calls = self.run_fetch([requests.ConnectionError("refused"), requests.Timeout("slow"), 200])
        self.assertEqual((result, calls), ("<html>ok</html>", 3))

    def test_gives_up_after_three_tries(self):
        import requests
        result, calls = self.run_fetch([requests.ConnectionError("x")] * 3)
        self.assertIsInstance(result, requests.ConnectionError)
        self.assertEqual(calls, 3)

    def test_server_error_retried_but_404_not(self):
        import requests
        result, calls = self.run_fetch([503, 200])
        self.assertEqual((result, calls), ("<html>ok</html>", 2))
        result, calls = self.run_fetch([404])
        self.assertIsInstance(result, requests.HTTPError)
        self.assertEqual(calls, 1)


class TestSeasonMonths(unittest.TestCase):
    def test_in_season_across_new_year(self):
        self.assertEqual([m for m in range(1, 13) if in_season(m, 11, 4)], [1, 2, 3, 4, 11, 12])
        self.assertEqual([m for m in range(1, 13) if in_season(m, 6, 8)], [6, 7, 8])

    def test_monthly_check_in(self):
        index = {"last_checked": "2027-05-20T09:17:00+09:00"}
        self.assertFalse(monthly_check_in(index, "2027-05-28T09:17:00+09:00"))  # same month: no change
        self.assertTrue(monthly_check_in(index, "2027-06-01T09:17:00+09:00"))   # new month: check in
        self.assertEqual(index["last_checked"], "2027-06-01T09:17:00+09:00")
        self.assertTrue(monthly_check_in({"last_checked": None}, "2027-06-01T09:17:00+09:00"))


class TestGroupsAndLocalTime(unittest.TestCase):
    """Resorts abroad: groups (separate data files), time zones and local scraping hours."""

    def test_every_resort_has_a_known_group_country_and_time_zone(self):
        from zoneinfo import ZoneInfo
        from scraper.run import groups_of, load_settings
        groups = groups_of(load_settings())
        for r in load_config():
            with self.subTest(resort=r["id"]):
                self.assertIn(r["group"], groups)
                self.assertTrue(r["country"])
                ZoneInfo(r["timezone"])  # raises if unknown
        self.assertEqual({r["group"] for r in load_config() if r["country"] == "Japan"}, {"japan"})

    def test_areas_list_existing_resorts_once(self):
        from scraper.run import area_info, load_settings, refresh_resorts
        settings, resorts = load_settings(), load_config()
        ids = {r["id"] for r in resorts}
        seen = set()
        for a in settings.get("areas") or []:
            with self.subTest(area=a["id"]):
                self.assertNotIn(a["id"], ids, "an area id must differ from every resort id")
                self.assertTrue(set(a["resorts"]) <= ids, "unknown resort in area")
                self.assertFalse(seen & set(a["resorts"]), "a resort can only be in one area")
                seen |= set(a["resorts"])
        index = {"resorts": {}, "seasons": {}}
        refresh_resorts(index, resorts, settings.get("areas"))
        self.assertEqual(index["areas"]["niseko-united"]["resorts"],
                         ["niseko-hirafu", "niseko-annupuri", "niseko-village", "niseko-hanazono"])
        self.assertEqual(index["areas"]["niseko-united"]["timezone"], "Asia/Tokyo")

    def test_group_defaults_fill_in_missing_fields(self):
        from scraper.run import resolve
        groups = {"japan": {"country": "Japan", "timezone": "Asia/Tokyo"}, "europe": {"timezone": "Europe/Rome"}}
        self.assertEqual({k: resolve({"id": "a"}, groups)[k] for k in ("group", "country", "timezone")},
                         {"group": "japan", "country": "Japan", "timezone": "Asia/Tokyo"})
        r = resolve({"id": "b", "group": "europe", "country": "Austria", "timezone": "Europe/Vienna"}, groups)
        self.assertEqual((r["country"], r["timezone"]), ("Austria", "Europe/Vienna"))
        with self.assertRaises(ValueError):
            resolve({"id": "c", "group": "mars"}, groups)

    def test_scraping_hours_are_local(self):
        from scraper.run import in_hours
        s = {"hours": ["09:00", "21:00"], "until": "22:00"}
        self.assertEqual([h for h in ("08:59", "09:00", "15:30", "21:40", "22:00", "22:01") if in_hours(h, s)],
                         ["09:00", "15:30", "21:40", "22:00"])

    def test_daily_record_is_per_resort(self):
        from scraper.run import daily_due
        season = {"days": [{"date": "2026-12-02", "results": {"a": {}}}]}
        self.assertFalse(daily_due(season, "2026-12-02", "10:00", "09:30", "a"))  # a already recorded today
        self.assertTrue(daily_due(season, "2026-12-02", "10:00", "09:30", "b"))   # b (new resort) not yet
        self.assertFalse(daily_due(season, "2026-12-02", "09:00", "09:30", "b"))  # too early there

    def test_live_entries_keep_their_own_local_date(self):
        import json, tempfile
        from scraper.run import update_live
        ok = lambda n: {"ok": True, "lifts_open": n, "runs_open": None, "lifts": [{"status": "open"}] * n, "runs": []}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "live.json"
            update_live({"jp": ok(3)}, {"jp": "2026-12-02"}, "2026-12-02T00:10:00+00:00", path)
            # later, a run that only scrapes another resort (on its own, earlier, local date)
            self.assertTrue(update_live({"us": ok(5)}, {"us": "2026-12-01"}, "2026-12-02T01:00:00+00:00", path))
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual({k: (v["date"], v["lifts_open"]) for k, v in data["results"].items()},
                             {"jp": ("2026-12-02", 3), "us": ("2026-12-01", 5)})
            # `changed`: when that resort's status last changed (jp untouched by the second run)
            self.assertEqual(data["results"]["jp"]["changed"], "2026-12-02T00:10:00+00:00")
            self.assertEqual(data["results"]["us"]["changed"], "2026-12-02T01:00:00+00:00")
            # same status again: nothing written
            self.assertFalse(update_live({"us": ok(5)}, {"us": "2026-12-01"}, "2026-12-02T01:45:00+00:00", path))

    def test_open_today_remembers_lifts_and_resets_next_day(self):
        import json, tempfile
        from scraper.run import update_live
        res = lambda *st: {"ok": True, "lifts_open": st.count("open"), "runs_open": None, "runs": [],
                           "lifts": [{"name": f"L{i}", "status": s} for i, s in enumerate(st)]}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "live.json"
            update_live({"a": res("open", "closed")}, "2026-12-01", "t1", path)
            update_live({"a": res("closed", "open")}, "2026-12-01", "t2", path)   # L0 closed for the day
            update_live({"a": res("closed", "closed")}, "2026-12-01", "t3", path)
            entry = json.loads(path.read_text(encoding="utf-8"))["results"]["a"]
            self.assertEqual(entry["open_today"], {"lifts": ["L0", "L1"], "runs": []})
            update_live({"a": res("closed", "closed")}, "2026-12-02", "t4", path)  # next morning
            self.assertNotIn("open_today", json.loads(path.read_text(encoding="utf-8"))["results"]["a"])

    def test_old_live_file_without_entry_dates_still_works(self):
        import json, tempfile
        from scraper.run import update_live
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "live.json"
            path.write_text(json.dumps({"date": "2026-12-01", "updated": "t0", "results": {
                "a": {"ok": True, "lifts_open": 2, "runs_open": None, "lifts": [{}] * 11, "runs": []}}}), encoding="utf-8")
            short = {"ok": True, "lifts_open": 1, "runs_open": None, "lifts": [{}] * 4, "runs": []}
            update_live({"a": short}, "2026-12-01", "t1", path)  # same day, fewer lifts: earlier entry kept
            self.assertEqual(len(json.loads(path.read_text(encoding="utf-8"))["results"]["a"]["lifts"]), 11)


class TestTemperatures(unittest.TestCase):
    """Forecast for today, final values for past days (scraper/weather.py)."""

    RESORT = {"id": "a", "location": {"lat": 1, "lon": 2}, "elevation": {"summit": 1200, "base": 260}}

    def season(self, *dates):
        return {"season": "2026-27", "days": [{"date": d, "results": {"a": {"ok": True}}} for d in dates]}

    def values(self, lo, hi):
        return {"summit": {"min_c": lo, "max_c": hi}, "base": {"min_c": lo + 5, "max_c": hi + 5}}

    def test_parse_open_meteo_response(self):
        from scraper.weather import parse_response
        points = [(self.RESORT, "summit"), (self.RESORT, "base")]
        data = [
            {"daily": {"time": ["2026-11-26", "2026-11-27"], "temperature_2m_min": [-13.3, -11.4], "temperature_2m_max": [-1.6, 1.0]}},
            {"daily": {"time": ["2026-11-26", "2026-11-27"], "temperature_2m_min": [-7.2, None], "temperature_2m_max": [4.5, 7.1]}},
        ]
        out = parse_response(data, points)
        self.assertEqual(out["a"]["2026-11-26"], {"summit": {"min_c": -13.3, "max_c": -1.6}, "base": {"min_c": -7.2, "max_c": 4.5}})
        self.assertEqual(out["a"]["2026-11-27"], {"summit": {"min_c": -11.4, "max_c": 1.0}})  # missing value skipped
        with self.assertRaises(ValueError):
            parse_response(data[:1], points)

    def response(self):
        """Fake Open-Meteo answer: 26 Nov (complete, snowed 4 h at summit), 27 Nov (today,
        12 h so far), 28 Nov light snow, 29 Nov 5.3 cm."""
        dates = ["2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"]
        hours = [f"2026-11-26T{h:02d}:00" for h in range(24)] + [f"2026-11-27T{h:02d}:00" for h in range(12)]
        entry = lambda base, snow_hours: {
            "daily": {"time": dates, "temperature_2m_min": [base - 5] * 4, "temperature_2m_max": [base + 5] * 4,
                      "temperature_2m_mean": [base - 0.04] * 4, "snowfall_sum": [2.0, 0.0, 0.4, 5.3]},
            "hourly": {"time": hours, "snowfall": [0.5 if i < snow_hours else 0.0 for i in range(len(hours))]},
        }
        from scraper.weather import parse_response
        return parse_response([entry(-10, 4), entry(-3, 1)], [(self.RESORT, "summit"), (self.RESORT, "base")])

    def test_parse_snow_and_mean(self):
        out = self.response()["a"]
        self.assertEqual(out["2026-11-26"]["summit"], {"min_c": -15, "max_c": -5, "mean_c": -10.0})
        self.assertEqual(out["2026-11-26"]["snow_hours"], {"summit": 4, "base": 1})
        self.assertNotIn("snow_hours", out["2026-11-27"])  # only 12 hours so far: incomplete day
        self.assertEqual(out["2026-11-29"]["snowfall_cm"]["summit"], 5.3)

    def test_snow_outlook_today_and_final_day_snow_hours(self):
        from scraper.weather import apply_temps, snow_outlook
        out = self.response()["a"]
        self.assertEqual(snow_outlook(out, "2026-11-27"), {"date": "2026-11-29", "days": 2, "cm": 5.3})  # 0.4 cm is too little
        self.assertEqual(snow_outlook(out, "2026-11-30"), {"date": None, "days": None, "within_days": 16})

        season = self.season("2026-11-26", "2026-11-27")
        season["days"][0]["results"]["a"]["snow_outlook"] = {"date": "2026-11-29", "days": 3, "cm": 5}  # yesterday's
        apply_temps(season, self.RESORT, out, today="2026-11-27")
        past, today = (season["days"][i]["results"]["a"] for i in (0, 1))
        self.assertEqual((past["temps"]["kind"], past["temps"]["snow_hours"], past["temps"]["snowed"]), ("final", 4, True))
        self.assertEqual(past["temps"]["snowfall_cm"], 2.0)  # the day's model snowfall at the summit
        self.assertNotIn("snow_outlook", past)  # deleted once the day is over
        self.assertEqual(today["temps"]["kind"], "forecast")
        self.assertNotIn("snow_hours", today["temps"])
        self.assertEqual(today["snow_outlook"]["days"], 2)

    def test_less_than_three_hours_is_not_snowed(self):
        from scraper.weather import temps_record
        rec = temps_record("final", {"summit": {"min_c": 0, "max_c": 1}, "snow_hours": {"summit": 2}},
                           {"summit": 1200, "base": 260})
        self.assertEqual((rec["snow_hours"], rec["snowed"]), (2, False))

    def test_today_forecast_then_final_next_day(self):
        from scraper.weather import apply_temps
        season = self.season("2026-11-27")
        apply_temps(season, self.RESORT, {"2026-11-27": self.values(-11.4, 1.0)}, today="2026-11-27")
        t = season["days"][0]["results"]["a"]["temps"]
        self.assertEqual(t["kind"], "forecast")
        self.assertEqual(t["summit"], {"elevation_m": 1200, "min_c": -11.4, "max_c": 1.0})
        self.assertEqual(t["base"]["elevation_m"], 260)

        # Next morning: yesterday's forecast is replaced by the final values.
        season["days"].append({"date": "2026-11-28", "results": {"a": {"ok": True}}})
        changed = apply_temps(season, self.RESORT, {"2026-11-27": self.values(-13.0, 0.5),
                                                    "2026-11-28": self.values(-9.0, 2.0)}, today="2026-11-28")
        self.assertEqual(changed, ["2026-11-27", "2026-11-28"])
        y = season["days"][0]["results"]["a"]["temps"]
        self.assertEqual((y["kind"], y["summit"]["min_c"], y["summit"]["max_c"]), ("final", -13.0, 0.5))
        self.assertEqual(season["days"][1]["results"]["a"]["temps"]["kind"], "forecast")

    def test_final_values_are_not_overwritten_and_missed_days_catch_up(self):
        from scraper.weather import apply_temps
        season = self.season("2026-11-25", "2026-11-26", "2026-11-28")
        apply_temps(season, self.RESORT, {"2026-11-25": self.values(-5, 0)}, today="2026-11-26")
        # A later run sees slightly different numbers for the 25th: the final values stay.
        changed = apply_temps(season, self.RESORT, {"2026-11-25": self.values(-6, 1),
                                                    "2026-11-26": self.values(-7, 2),
                                                    "2026-11-27": self.values(-8, 3)}, today="2026-11-28")
        self.assertEqual(changed, ["2026-11-26"])  # 27th wasn't recorded (no run that day): skipped
        self.assertEqual(season["days"][0]["results"]["a"]["temps"]["summit"]["min_c"], -5)

    def test_season_summary_uses_final_temperatures_only(self):
        from scraper.weather import apply_temps
        season = self.season("2026-12-01", "2026-12-02", "2026-12-03")
        apply_temps(season, self.RESORT, {"2026-12-01": self.values(-10, 0), "2026-12-02": self.values(-4, 3),
                                          "2026-12-03": self.values(-30, 20)}, today="2026-12-03")
        summary = {}
        update_summary(summary, season, "a", None)
        # The 3rd is only a forecast, so its -30/20 don't count.
        self.assertEqual((summary["summit_min_c"], summary["summit_max_c"]), (-10, 3))
        self.assertEqual((summary["base_min_c"], summary["base_max_c"]), (-5, 8))

    def test_pending_forecast_detection(self):
        from scraper.run import has_pending_forecasts
        from scraper.weather import apply_temps
        season = self.season("2027-04-30")
        apply_temps(season, self.RESORT, {"2027-04-30": self.values(-3, 5)}, today="2027-04-30")
        self.assertTrue(has_pending_forecasts(season, "2027-05-01"))   # 1 May: finish 30 April
        self.assertFalse(has_pending_forecasts(season, "2027-05-20"))  # too old to look up


if __name__ == "__main__":
    unittest.main()
