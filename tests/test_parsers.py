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

from scraper.common import (NA, RUN_STATUSES, STATUSES, clean_hours, guess_lift_type, level_en,
                            run_status_from_text, status_from_text, to_number)
from scraper.run import (in_season, load_config, load_season, monthly_check_in, save_season,
                         season_of, store_result, update_summary)

FIXTURES = Path(__file__).parent / "fixtures"
LIFT_TYPES = {"Ropeway", "Gondola", "Magic carpet", "Six", "Quad", "Triple", "Pair", "Single", NA}
LEVELS = {"First timer", "Beginner", "Intermediate", "Advanced", "Expert", NA}
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
}


def fixture_for(resort: dict) -> Path:
    ext = ".json" if resort.get("data_url") else ".html"
    return FIXTURES / f"{resort['parser']}{ext}"


def parse_fixture(resort: dict) -> dict:
    parser = importlib.import_module(f"scraper.parsers.{resort['parser']}")
    return parser.parse(fixture_for(resort).read_text(encoding="utf-8"), resort.get("options") or {})


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
                self.assertEqual(r["temperature_c"], temp, "temperature")

    def test_lift_records_are_well_formed(self):
        for rid, r in self.results.items():
            with self.subTest(resort=rid):
                names = [l["name"] for l in r["lifts"]]
                self.assertEqual(len(names), len(set(names)), "lift names must be unique")
                for l in r["lifts"]:
                    self.assertEqual(set(l), {"name", "name_en", "status", "raw", "hours", "lift_type"})
                    self.assertTrue(l["name"] and l["name_en"], l)
                    self.assertIn(l["status"], STATUSES, l)
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
                    self.assertRegex(r["source_updated"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$")


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

    def test_furano_duplicate_names_get_zone(self):
        self.assertIn("Snow Escalator (Furano)", self.lifts["furano"])
        self.assertIn("Snow Escalator (Kitanomine)", self.lifts["furano"])

    def test_kokusai_open_when_hours_shown(self):
        l = self.lifts["sapporo-kokusai"]["SkyCabin8"]
        self.assertEqual((l["status"], l["hours"], l["lift_type"]), ("open", "09:00-15:20", "Gondola"))

    def test_hakuba_skips_night_sessions(self):
        self.assertFalse(any("Night" in n for n in self.lifts["hakuba-goryu"]))

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
        for date, depth, temp in [("2026-12-01", 50, -3), ("2026-12-02", 80, -10), ("2026-12-03", 80, 2)]:
            store_result(season, date, "a", self.ok(depth, temp))
        summary = {}
        update_summary(summary, season, "a", self.ok(80, 2, n_lifts=7))
        self.assertEqual(summary, {
            "lifts_total": 7, "runs_total": 10,
            "snow_depth_max_cm": 80, "snow_depth_max_date": "2026-12-02",
            # No daily low/high temperatures recorded in this test (see TestTemperatures).
            "summit_min_c": None, "summit_max_c": None, "base_min_c": None, "base_max_c": None,
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
