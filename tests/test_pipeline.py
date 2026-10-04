"""管線測試：python -m unittest discover -s tests -v"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))

from build_static import belongs, build, last_departures, to_minutes  # noqa: E402
from geo import Polyline, orient_to_stops, project_stops_in_order  # noqa: E402

LON0, LAT0 = 121.5, 25.05
DEG_PER_KM_LON = 1 / (111.32 * 0.9060)   # cos(25.05°) ≈ 0.9060
DEG_PER_KM_LAT = 1 / 110.54


def pt(x_km, y_km):
    return (LON0 + x_km * DEG_PER_KM_LON, LAT0 + y_km * DEG_PER_KM_LAT)


class GeoTest(unittest.TestCase):
    def test_straight_line(self):
        pl = Polyline([pt(0, 0), pt(10, 0)])
        p = pl.project(*pt(3, 0.05))
        self.assertAlmostEqual(p.km, 3.0, delta=0.01)
        self.assertAlmostEqual(p.offset_m, 50, delta=2)
        self.assertAlmostEqual(pl.length_km, 10.0, delta=0.02)

    def test_hairpin_window_picks_return_leg(self):
        # 去程 0→5 km、回程在北邊 30 m 平行折返：同一個點靠近兩段
        pl = Polyline([pt(0, 0), pt(5, 0), pt(5, 0.03), pt(0, 0.03)])
        stop = pt(2, 0.010)                                            # 離去程 10 m、回程 20 m
        self.assertLess(pl.project(*stop).km, 5)                       # 不設視窗→落在去程
        self.assertGreater(pl.project(*stop, km_min=5.5).km, 5)        # 設視窗→落在回程

    def test_stops_in_order_on_hairpin(self):
        pl = Polyline([pt(0, 0), pt(5, 0), pt(5, 0.03), pt(0, 0.03)])
        # 回程的兩站座標偏向去程（離去程 12 m、回程 18 m），只有依站序的視窗能把它們放回回程
        stops = [pt(1, 0.01), pt(4, 0.01), pt(5, 0.015), pt(4, 0.012), pt(1, 0.012)]
        km = [p.km for p in project_stops_in_order(pl, stops)]
        self.assertEqual(km, sorted(km), f"公里數應遞增：{km}")
        self.assertGreater(km[-1], 8.5)   # 最後一站在回程 1 km 處 ≈ 9.03 km

    def test_orient_reverses_when_stops_reversed(self):
        coords = [pt(0, 0), pt(10, 0)]
        out, flipped = orient_to_stops(coords, pt(10, 0), pt(0, 0))
        self.assertTrue(flipped)
        self.assertEqual(out[0], coords[-1])
        out, flipped = orient_to_stops(coords, pt(0, 0), pt(10, 0))
        self.assertFalse(flipped)


class ScheduleTest(unittest.TestCase):
    def test_belongs(self):
        self.assertTrue(belongs("307", "307"))
        self.assertTrue(belongs("307西藏三民", "307"))
        self.assertFalse(belongs("3071", "307"))
        self.assertFalse(belongs("12", "1"))

    def test_after_midnight_is_later(self):
        self.assertGreater(to_minutes("00:30"), to_minutes("23:50"))
        sched = {"Timetables": [
            {"ServiceDay": {"Saturday": 1}, "StopTimes": [{"StopSequence": 1, "DepartureTime": "23:50"}]},
            {"ServiceDay": {"Saturday": 1}, "StopTimes": [{"StopSequence": 1, "DepartureTime": "00:20"}]},
            {"ServiceDay": {"Sunday": 1}, "StopTimes": [{"StopSequence": 1, "DepartureTime": "22:00"}]},
        ]}
        last, _ = last_departures(sched)
        self.assertEqual(last["sat"], "24:20")
        self.assertEqual(last["sun"], "22:00")

    def test_frequency_uses_end_time(self):
        sched = {"Frequencys": [
            {"StartTime": "05:00", "EndTime": "21:00", "ServiceDay": {"Monday": 1}},
            {"StartTime": "21:00", "EndTime": "22:10", "ServiceDay": {"Monday": 1}},
        ]}
        self.assertEqual(last_departures(sched)[0], {"mon": "22:10"})


class BuildIntegrationTest(unittest.TestCase):
    """用快取的 307 真實資料跑一次建置（不連網）。"""

    @classmethod
    def setUpClass(cls):
        cls.data = build("307", "Taipei", offline=True)

    def test_four_variants(self):
        names = {v["subRouteName"] for v in self.data["variants"]}
        self.assertEqual(names, {"307莒光往板橋前站", "307莒光往撫遠街", "307西藏往板橋前站", "307西藏往撫遠街"})

    def test_stops_monotonic_and_close(self):
        for v in self.data["variants"]:
            km = [s["km"] for s in v["stops"]]
            self.assertEqual(km, sorted(km), v["subRouteName"])
            self.assertLess(max(s["offsetM"] for s in v["stops"]), 80, v["subRouteName"])
            self.assertLessEqual(km[-1], v["lengthKm"] + 1e-6)

    def test_last_departures(self):
        for v in self.data["variants"]:
            want = "22:10" if v["label"] == "莒光" else "22:00"
            self.assertEqual(set(v["lastDeparture"].values()), {want}, v["subRouteName"])

    def test_no_warnings(self):
        self.assertEqual(self.data["checks"]["warnings"], [])

    def test_schedule_info(self):
        for v in self.data["variants"]:
            s = v["schedule"]
            if v["label"] == "西藏":
                self.assertEqual(s["type"], "timetable")
                sat = s["byDay"]["sat"]
                self.assertEqual(sat, sorted(sat))
                self.assertEqual(sat[-1], "22:00")            # 與末班一致
                self.assertGreater(len(sat), 30)
            else:
                self.assertEqual(s["type"], "frequency")
                self.assertTrue(any(w["end"] == "22:10" for w in s["windows"]))


class ScheduleInfoTest(unittest.TestCase):
    def test_timetable_by_day_sorted_and_deduped(self):
        from build_static import schedule_info
        sched = {"Timetables": [
            {"ServiceDay": {"Monday": 1}, "StopTimes": [{"StopSequence": 1, "DepartureTime": "09:30"}]},
            {"ServiceDay": {"Monday": 1}, "StopTimes": [{"StopSequence": 1, "DepartureTime": "08:00"}]},
            {"ServiceDay": {"Monday": 1}, "StopTimes": [{"StopSequence": 1, "DepartureTime": "08:00"}]},
        ]}
        self.assertEqual(schedule_info(sched), {"type": "timetable", "byDay": {"mon": ["08:00", "09:30"]}})


def _variant(sub, direction, stop_ids, schedule=None, last=None, route_id="900"):
    return {"routeId": route_id, "subRouteId": sub, "direction": direction, "tid": f"{sub}|{direction}",
            "key": f"測試|{sub}|{direction}", "subRouteName": f"測試({sub})", "label": sub, "display": "測試",
            "stops": [{"id": i} for i in stop_ids], "schedule": schedule or {"type": "none"},
            "lastDeparture": last or {}}


class MergeSameServiceTest(unittest.TestCase):
    """站序相同的營運業者子路線併成一個變體（265區 的三重客運與大南汽車）。"""

    def test_identical_stop_sequences_merge(self):
        from build_app import merge_same_service
        freq = lambda a, b, lo, hi: {"type": "frequency", "windows": [  # noqa: E731
            {"days": ["sat"], "start": a, "end": b, "minHeadway": lo, "maxHeadway": hi}]}
        vs = [_variant("A", 0, [1, 2, 3], freq("04:40", "22:20", 15, 20), {"sat": "22:20"}),
              _variant("B", 0, [1, 2, 3], freq("05:10", "22:30", 12, 18), {"sat": "22:30"}),
              _variant("A", 1, [3, 2, 1]),
              _variant("C", 0, [1, 2, 3])]
        out = merge_same_service(vs)
        self.assertEqual([v["tids"] for v in out], [["A|0", "B|0", "C|0"], ["A|1"]])
        m = out[0]
        self.assertEqual(m["tid"], "A|0")
        self.assertEqual(m["label"], "測試")                      # 合併後不再標單一業者
        self.assertEqual(m["lastDeparture"], {"sat": "22:30"})     # 取較晚的末班
        w = m["schedule"]["windows"][0]
        self.assertEqual((w["start"], w["end"], w["minHeadway"], w["maxHeadway"]), ("04:40", "22:30", 12, 20))
        self.assertEqual(out[1]["label"], "A")                     # 沒被合併的維持原樣
        self.assertEqual(vs[0]["lastDeparture"], {"sat": "22:20"}, "不能改到輸入")
        self.assertNotIn("nominal", m["schedule"], "兩邊都是可信的班距表：合併後不會憑空多出 nominal")
        # 班距只是登記數字（nominal）的標記，合併後要留著：任何一邊有就算
        nom = lambda a, b, lo, hi: dict(freq(a, b, lo, hi), nominal=True)  # noqa: E731
        for first, second in ((nom, nom), (nom, freq), (freq, nom)):
            pair = [_variant("A", 0, [1, 2, 3], first("04:40", "22:20", 15, 20)), _variant("B", 0, [1, 2, 3], second("05:10", "22:30", 12, 18))]
            sch = merge_same_service(pair)[0]["schedule"]
            self.assertIs(sch.get("nominal"), True)
            self.assertEqual((sch["type"], len(sch["windows"]), sch["windows"][0]["end"]), ("frequency", 1, "22:30"))
        # 第一個沒有班距表、後面的有：整個沿用後面的（含標記）
        late = merge_same_service([_variant("A", 0, [1, 2, 3]), _variant("B", 0, [1, 2, 3], nom("05:10", "22:30", 12, 18))])[0]["schedule"]
        self.assertIs(late.get("nominal"), True)

    def test_different_stops_or_direction_or_route_do_not_merge(self):
        from build_app import merge_same_service
        vs = [_variant("A", 0, [1, 2, 3]), _variant("B", 0, [1, 2, 4]), _variant("C", 1, [1, 2, 3]),
              _variant("D", 0, [1, 2, 3], route_id="901")]
        self.assertEqual([v["tids"] for v in merge_same_service(vs)], [["A|0"], ["B|0"], ["C|1"], ["D|0"]])

    def test_schedule_fills_from_later_variant(self):
        from build_app import merge_same_service
        tt = {"type": "timetable", "byDay": {"sat": ["06:00"]}}
        out = merge_same_service([_variant("A", 0, [1, 2]), _variant("B", 0, [1, 2], tt)])
        self.assertEqual(out[0]["schedule"], tt)


class NoLocalPathTest(unittest.TestCase):
    def test_cache_location_is_relative_to_the_project(self):
        """產出檔會公開：來源說明裡不能有本機的絕對路徑（使用者名稱、資料夾結構）。"""
        import tempfile
        from sources import TDX, BlobStatic, _rel
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "某人的資料夾" / "專案"
            cache = root / "cache"
            f = cache / "tdx" / "Taipei" / "307" / "Route.json"
            f.parent.mkdir(parents=True)
            f.write_text("[]", encoding="utf-8")
            self.assertEqual(_rel(f, cache), "cache/tdx/Taipei/307/Route.json")
            _, info = TDX(cache, allow_network=False).get("Taipei", "307", "Route")
            self.assertEqual(info["cache"], "cache/tdx/Taipei/307/Route.json")
            self.assertNotIn("某人的資料夾", json.dumps(info, ensure_ascii=False))
            import gzip
            g = cache / "blob" / "tpe" / "GetRoute.gz"
            g.parent.mkdir(parents=True)
            g.write_bytes(gzip.compress(json.dumps({"EssentialInfo": {"UpdateTime": "x"}, "BusInfo": []}).encode("utf-8")))
            _, binfo = BlobStatic(cache, allow_network=False).get("tpe", "GetRoute")
            self.assertEqual(binfo["cache"], "cache/blob/tpe/GetRoute.gz")
            # 快取不在專案底下（不該發生）：只留檔名，也不寫絕對路徑
            self.assertEqual(_rel(Path(d) / "別處" / "x.json", cache), "x.json")

    def test_published_data_has_no_local_paths(self):
        """實際要公開的資料檔裡不能有磁碟機代號開頭的路徑或使用者資料夾。"""
        import re
        bad = re.compile(r"[A-Za-z]:[\/]+Users|/Users/|/home/")
        for rel in ("web/data/app-data.js", "web/data/calibration.js", "web/data/city-index.json", "web/index.html", "web/app.js", "web/core.js"):
            text = (ROOT / rel).read_text(encoding="utf-8")
            self.assertIsNone(bad.search(text), f"{rel} 裡有本機路徑")


class OfficialNameTest(unittest.TestCase):
    def test_display_and_toward_follow_the_official_listing(self):
        from build_app import use_official_names
        v = lambda name, rid, d, display, toward: {"routeName": name, "routeId": rid, "direction": d, "display": display, "toward": toward}  # noqa: E731
        vs = [v("307", "16111", 0, "307莒光", "撫遠街"), v("307", "16111", 1, "307莒光", "板橋前站"),
              v("307西藏三民", "19108", 1, "307西藏", "板橋前站"),
              v("900", "9", 0, "900", "甲地"), v("900", "9", 0, "900區間", "甲地"),          # 同方向兩個變體：保留各自的名稱
              v("901", "77", 0, "901簡稱", "乙地")]                                         # 索引裡沒有這條路線
        use_official_names(vs, {"16111": ("板橋", "撫遠街"), "19108": ("板橋", "撫遠街"), "9": ("起", "迄")})
        self.assertEqual([x["display"] for x in vs], ["307", "307", "307西藏三民", "900", "900區間", "901"])
        self.assertEqual([x["toward"] for x in vs], ["撫遠街", "板橋", "板橋", "迄", "迄", "乙地"],
                         "去程往迄點、返程往起點；索引查不到的維持原樣")
        # 索引的起迄點是空字串時不要把「往哪裡」清掉
        w = [v("902", "5", 1, "902", "原本的")]
        use_official_names(w, {"5": ("", "迄")})
        self.assertEqual(w[0]["toward"], "原本的")
        # 主路線編號在 TDX 是字串、在全市索引是數字：都要對得上
        n = [v("903", 42, 0, "903簡稱", "舊")]
        use_official_names(n, {"42": ("起", "迄")})
        self.assertEqual((n[0]["display"], n[0]["toward"]), ("903", "迄"))


class PublishedScheduleTest(unittest.TestCase):
    """已經建好、會公開的資料檔：哪些班距表可以拿來補班次要標對（改了建置規則卻忘了重建，這裡會紅）。"""

    def test_city_route_files_are_nominal_and_builtin_routes_are_not(self):
        import json
        web = Path(__file__).resolve().parent.parent / "web" / "data"
        if not (web / "routes").exists():
            self.skipTest("還沒建置 web/data/routes")
        kinds = {"frequency": 0, "nominal": 0}
        for f in (web / "routes").glob("*.json"):
            for v in json.loads(f.read_text(encoding="utf-8"))["variants"]:
                if v["schedule"]["type"] == "frequency":
                    kinds["frequency"] += 1
                    kinds["nominal"] += v["schedule"].get("nominal") is True
        self.assertGreater(kinds["frequency"], 100)
        self.assertEqual(kinds["nominal"], kinds["frequency"], "全市路線檔裡有班距表的變體都要標 nominal")
        src = (web / "app-data.js").read_text(encoding="utf-8")
        app = json.loads(src[src.index("=") + 1:].strip().rstrip(";"))
        freq = [v for v in app["variants"] if v["schedule"]["type"] == "frequency"]
        self.assertTrue(freq, "內建路線至少有一個班距表")
        self.assertFalse([v["key"] for v in freq if v["schedule"].get("nominal")], "內建路線（TDX 的分時段班距表）不標 nominal")


# ---------------------------------------------------------------- 全市索引（台北市＋新北市的開放資料靜態檔）
def _route(rid, pid, name="測", sub=None, **kw):
    base = {"Id": rid, "pathAttributeId": pid, "nameZh": name, "pathAttributeName": sub or name,
            "departureZh": "起點", "destinationZh": "終點",
            "goFirstBusTime": "0500", "goLastBusTime": "2210", "backFirstBusTime": "0530", "backLastBusTime": "2240",
            "peakHeadway": "0406", "offPeakHeadway": "0510", "holidayPeakHeadway": "0710", "holidayOffPeakHeadway": "",
            "holidayGoFirstBusTime": "0600", "holidayGoLastBusTime": "2200", "holidayBackFirstBusTime": "", "holidayBackLastBusTime": ""}
    base.update(kw)
    return base


def _stop(sid, rid, seq, go_back, x_km, loc=None, name=None):
    lon, lat = pt(x_km, 0)
    return {"Id": sid, "routeId": rid, "nameZh": name or f"站{sid}", "seqNo": seq, "goBack": str(go_back),
            "longitude": f"{lon:.6f}", "latitude": f"{lat:.6f}", "stopLocationId": loc or sid}


def _path(pid, stop_ids):
    return [{"pathAttributeId": pid, "stopId": sid, "sequenceNo": i} for i, sid in enumerate(stop_ids)]


class CityBuildTest(unittest.TestCase):
    def test_headway_and_time_fields(self):
        from build_city import hhmm, parse_headway
        self.assertEqual([parse_headway(x) for x in ("0406", "1520", "12", "510", "1005")],
                         [(4, 6), (15, 20), (12, 12), (5, 10), (5, 10)])
        self.assertEqual([parse_headway(x) for x in ("", None, "abc", "0000", "12345")], [None] * 5)
        self.assertEqual([hhmm(x) for x in ("0500", "2210", "", None, "2460", "9999", "500")],
                         ["05:00", "22:10", None, None, None, None, None])

    def test_frequency_schedule_by_direction_and_day_type(self):
        from build_city import frequency_schedule
        go, last = frequency_schedule(_route(1, 10), 0)
        self.assertEqual(go["windows"], [
            {"days": ["mon", "tue", "wed", "thu", "fri"], "start": "05:00", "end": "22:10", "minHeadway": 4, "maxHeadway": 10},
            {"days": ["sat", "sun"], "start": "06:00", "end": "22:00", "minHeadway": 7, "maxHeadway": 10}])
        self.assertEqual((last["mon"], last["sun"]), ("22:10", "22:00"))
        self.assertEqual({k: v for k, v in go.items() if k != "windows"}, {"type": "frequency", "nominal": True},
                         "全市路線的班距只是登記的尖峰／離峰數字：標 nominal，網頁不拿它補班次")
        back, last_b = frequency_schedule(_route(1, 10), 1)
        self.assertEqual([(w["start"], w["end"]) for w in back["windows"]], [("05:30", "22:40"), ("05:30", "22:40")],
                         "返程用返程的首末班；假日欄位空白時沿用平日")
        self.assertEqual(last_b["sat"], "22:40")
        # 假日班距空白：沿用平日班距
        wk = frequency_schedule(_route(1, 10, holidayPeakHeadway=""), 0)[0]["windows"][1]
        self.assertEqual((wk["minHeadway"], wk["maxHeadway"]), (4, 10))
        # 逐班表路線：沒有班距 → 不產生班距表，但末班時刻還在
        none, last_n = frequency_schedule(_route(1, 10, peakHeadway="", offPeakHeadway="", holidayPeakHeadway=""), 0)
        self.assertEqual(none, {"type": "none"})
        self.assertEqual(last_n["mon"], "22:10")

    def test_frequency_schedule_past_midnight(self):
        """末班在凌晨（比首班小、在 03:00 營運日換日點之前）＝跨午夜：時段的 end 寫成 24 時以後，末班時刻維持原本的寫法。"""
        from build_city import frequency_schedule, window_end
        ends = lambda r, g=0: [(w["start"], w["end"]) for w in frequency_schedule(r, g)[0].get("windows", [])]  # noqa: E731
        # 棕2、藍29 這一類：首班 05:40、末班 00:00（午夜那一班）；假日末班 00:30
        r = _route(1, 10, goFirstBusTime="0540", goLastBusTime="0000", holidayGoFirstBusTime="0600", holidayGoLastBusTime="0030")
        sch, last = frequency_schedule(r, 0)
        self.assertEqual(sch["windows"], [
            {"days": ["mon", "tue", "wed", "thu", "fri"], "start": "05:40", "end": "24:00", "minHeadway": 4, "maxHeadway": 10},
            {"days": ["sat", "sun"], "start": "06:00", "end": "24:30", "minHeadway": 7, "maxHeadway": 10}])
        self.assertEqual((last["mon"], last["fri"], last["sat"], last["sun"]), ("00:00", "00:00", "00:30", "00:30"),
                         "末班時刻不改寫：畫面上的「起站末班」照資料原本的寫法")
        self.assertEqual(ends(r, 1), [("05:30", "22:40"), ("05:30", "22:40")], "返程不跨午夜：不受影響")
        # 返程跨午夜、假日欄位空白沿用平日：兩個時段都跨午夜
        self.assertEqual(ends(_route(1, 10, backLastBusTime="0020"), 1), [("05:30", "24:20"), ("05:30", "24:20")])
        # 夜間公車：23:00 發到 00:20
        self.assertEqual(ends(_route(1, 10, goFirstBusTime="2300", goLastBusTime="0020",
                                     holidayGoFirstBusTime="", holidayGoLastBusTime="")), [("23:00", "24:20")] * 2)
        # 換日點：02:59 還是深夜那一班；03:00 起是清晨的時刻，比首班小就是資料有問題，不產生時段
        self.assertEqual([window_end("05:00", x) for x in ("00:00", "00:05", "02:59", "03:00", "04:59", "05:00", "22:10")],
                         ["24:00", "24:05", "26:59", "03:00", "04:59", "05:00", "22:10"])
        self.assertEqual(window_end("23:30", "00:05"), "24:05")
        self.assertEqual(window_end("01:00", "02:00"), "02:00", "末班比首班晚：不是跨午夜，不改寫")
        self.assertEqual(window_end("02:00", "02:00"), "02:00", "首末班同一個時刻：不是跨午夜")
        self.assertEqual(ends(_route(1, 10, goLastBusTime="0259"))[0], ("05:00", "26:59"))
        for bad in ("0300", "0459", "0500"):             # 0500＝首末班同一個時刻（一天一班）：時段長度是零
            sch_b, last_b = frequency_schedule(_route(1, 10, goLastBusTime=bad, holidayGoFirstBusTime="", holidayGoLastBusTime=""), 0)
            self.assertEqual(sch_b, {"type": "none"}, bad)
            self.assertEqual(last_b["mon"], f"{bad[:2]}:{bad[2:]}", "時段不產生，末班時刻還在")
        # 沒有班距（逐班表路線）：跨午夜也不產生班距表
        self.assertEqual(frequency_schedule(_route(1, 10, goLastBusTime="0000", peakHeadway="", offPeakHeadway="",
                                                   holidayPeakHeadway=""), 0)[0], {"type": "none"})

    def test_past_midnight_window_survives_operator_merge(self):
        """共營路線（站序相同的子路線併成一個）：跨午夜的時段和不跨午夜的併在一起時，end 取跨午夜的那個。"""
        from build_city import build_source
        routes = [_route(2, 20, sub="測(甲客運)", goLastBusTime="2330", holidayGoLastBusTime="2330"),
                  _route(2, 21, sub="測(乙客運)", goLastBusTime="0000", holidayGoLastBusTime="0030")]
        stops = [_stop(1, 2, 0, 0, 0), _stop(2, 2, 1, 0, 1)]
        for order in (routes, routes[::-1]):
            files, _, _ = build_source("tpe", order, stops, _path(20, [1, 2]) + _path(21, [1, 2]))
            (v,) = files["tpe:2"]["variants"]
            self.assertEqual([(w["start"], w["end"]) for w in v["schedule"]["windows"]], [("05:00", "24:00"), ("06:00", "24:30")])

    def _simple(self):
        """路線 1：子路線 10 涵蓋去返兩向；子路線 11 是去程的區間車（少一站）；子路線 10 被兩家業者各登錄一次。"""
        routes = [_route(1, 10), _route(1, 10), _route(1, 11, sub="測(區間)")]
        stops = [_stop(101, 1, 0, 0, 0), _stop(102, 1, 1, 0, 1), _stop(103, 1, 2, 0, 2), _stop(104, 1, 3, 0, 3),
                 _stop(201, 1, 0, 1, 3), _stop(202, 1, 1, 1, 1.5), _stop(203, 1, 2, 1, 0)]
        # 故意打亂列的順序：站序要靠 sequenceNo，不是靠檔案裡的先後
        paths = [{"pathAttributeId": 10, "stopId": sid, "sequenceNo": seq} for sid, seq in
                 ((104, 3), (201, 4), (101, 0), (202, 5), (103, 2), (203, 6), (102, 1))]
        paths += _path(11, [101, 102, 103])
        return routes, stops, paths

    def test_route_variants(self):
        from build_city import build_source
        files, listing, plats = build_source("tpe", *self._simple())
        got = {v["key"]: v for v in files["tpe:1"]["variants"]}
        self.assertEqual(sorted(got), ["測|10|0", "測|10|1", "測|11|0"])
        go, back, short = got["測|10|0"], got["測|10|1"], got["測|11|0"]
        self.assertEqual([s["id"] for s in go["stops"]], [101, 102, 103, 104])
        self.assertEqual([s["id"] for s in back["stops"]], [201, 202, 203])
        self.assertEqual([round(s["km"], 2) for s in go["stops"]], [0, 1, 2, 3])
        self.assertEqual([round(s["km"], 2) for s in back["stops"]], [0, 1.5, 3])
        self.assertEqual(go["shapeKm"], [s["km"] for s in go["stops"]])
        self.assertEqual((go["toward"], back["toward"]), ("終點", "起點"))
        self.assertEqual((go["tids"], go["routeId"], go["src"], go["family"]), (["10|0"], 1, "tpe", "測"))
        self.assertTrue(go["shapeApprox"] and go["maxOffsetM"] >= 300)
        # 去程有兩個站序不同的變體：用子路線名稱區分；返程只有一個：直接叫路線名
        self.assertEqual((go["display"], short["display"], back["display"]), ("測", "測(區間)", "測"))
        self.assertEqual(listing, [{"key": "tpe:1", "name": "測", "src": "tpe", "routeId": 1, "dep": "起點", "dest": "終點"}])

    def test_identical_sequences_merge(self):
        from build_city import build_source
        routes = [_route(2, 20, sub="測(甲客運)"), _route(2, 21, sub="測(乙客運)")]
        stops = [_stop(1, 2, 0, 0, 0), _stop(2, 2, 1, 0, 1)]
        files, _, _ = build_source("tpe", routes, stops, _path(20, [1, 2]) + _path(21, [1, 2]))
        self.assertEqual([(v["tids"], v["display"]) for v in files["tpe:2"]["variants"]], [(["20|0", "21|0"], "測")])

    def test_platforms_skip_terminal_and_share_location(self):
        from build_city import build_source
        routes = [_route(1, 10, name="甲"), _route(2, 20, name="乙")]
        stops = [_stop(101, 1, 0, 0, 0, loc=900), _stop(102, 1, 1, 0, 1, loc=901), _stop(103, 1, 2, 0, 2, loc=902),
                 _stop(201, 2, 0, 0, 0, loc=900), _stop(202, 2, 1, 0, 2, loc=902), _stop(203, 2, 2, 0, 3, loc=903)]
        _, _, plats = build_source("tpe", routes, stops, _path(10, [101, 102, 103]) + _path(20, [201, 202, 203]))
        self.assertEqual({k: sorted(p["entries"]) for k, p in plats.items()},
                         {900: [("tpe:1", 0, 101), ("tpe:2", 0, 201)], 901: [("tpe:1", 0, 102)], 902: [("tpe:2", 0, 202)]},
                         "902 是甲的終點（只下不上）、903 是乙的終點：都不列")

    def test_city_merges_shared_platforms_and_detects_id_collisions(self):
        from build_city import build_city
        tpe = {"GetRoute": [_route(1, 10, name="甲")], "GetStop": [_stop(101, 1, 0, 0, 0, loc=900), _stop(102, 1, 1, 0, 1, loc=901)],
               "GetPathDetail": _path(10, [101, 102])}
        ntpc = {"GetRoute": [_route(2, 20, name="乙")], "GetStop": [_stop(201, 2, 0, 0, 0, loc=900), _stop(202, 2, 1, 0, 1, loc=905)],
                "GetPathDetail": _path(20, [201, 202])}
        index, files = build_city({"tpe": tpe, "ntpc": ntpc})
        self.assertEqual([r[:4] for r in index["routes"]], [["ntpc:2", "乙", "ntpc", 2], ["tpe:1", "甲", "tpe", 1]])
        shared = next(p for p in index["plats"] if p[0] == 900)
        self.assertEqual(sorted(shared[4]), [[0, 0, 201], [1, 0, 101]], "兩市共用的站牌：兩邊的路線併在一起")
        self.assertEqual(sorted(files), ["ntpc:2", "tpe:1"])
        self.assertEqual(set(index["sources"]), {"tpe", "ntpc"})
        # 兩個來源的編號撞在一起：網頁把兩邊的即時資料合著用，一定要擋下來
        mk = lambda rid, pid, s1, s2: {"GetRoute": [_route(rid, pid, name="丙")],                      # noqa: E731
                                       "GetStop": [_stop(s1, rid, 0, 0, 0), _stop(s2, rid, 1, 0, 1)],
                                       "GetPathDetail": _path(pid, [s1, s2])}
        for bad, what in ((mk(1, 30, 301, 302), "主路線編號"), (mk(3, 10, 301, 302), "車輛回報編號"), (mk(3, 30, 101, 302), "站牌編號")):
            with self.assertRaises(ValueError) as cm:
                build_city({"tpe": tpe, "ntpc": bad})
            self.assertIn(what, str(cm.exception))


# ---------------------------------------------------------------- 路線軌跡（GetBusShape）
def _xy_stop(sid, rid, seq, go_back, x_km, y_km):
    lon, lat = pt(x_km, y_km)
    return {"Id": sid, "routeId": rid, "nameZh": f"站{sid}", "seqNo": seq, "goBack": str(go_back),
            "longitude": f"{lon:.6f}", "latitude": f"{lat:.6f}", "stopLocationId": sid}


def _track(rid, sub, go_back, km_points, step=0.05):
    """沿著折點每 step 公里放一個點的軌跡（模擬真實軌跡的密集點）。"""
    out = []
    for (x1, y1), (x2, y2) in zip(km_points, km_points[1:]):
        n = max(1, round(max(abs(x2 - x1), abs(y2 - y1)) / step))
        out += [pt(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n) for i in range(n)]
    out.append(pt(*km_points[-1]))
    return {"RouteID": rid, "SubRouteID": sub, "GoBack": go_back, "wkt": "LINESTRING (" + ", ".join(f"{a:.7f} {b:.7f}" for a, b in out) + ")"}


class ShapeFitTest(unittest.TestCase):
    def _one(self, stops_xy, tracks, go_back=0, sub=10):
        from build_city import build_source
        stops = [_xy_stop(100 + i, 1, i, go_back, x, y) for i, (x, y) in enumerate(stops_xy)]
        files, _, _ = build_source("tpe", [_route(1, sub)], stops, _path(sub, [s["Id"] for s in stops]), tracks)
        return files["tpe:1"]["variants"][0]

    def test_track_replaces_straight_line_and_km_follow_the_road(self):
        # 兩站在 L 形道路的兩端：直線 1.41 km，沿路 2 km
        v = self._one([(0, 0), (1, 1)], [_track(1, -1, 0, [(0, 0), (1, 0), (1, 1)])])
        self.assertNotIn("shapeApprox", v)
        self.assertNotIn("maxOffsetM", v)
        self.assertAlmostEqual(v["lengthKm"], 2.0, delta=0.01)
        self.assertEqual([round(s["km"], 2) for s in v["stops"]], [0, 2.0])
        self.assertEqual(len(v["shape"]), 3, "直線路段上多餘的點拿掉，只剩起點、轉角、終點")
        self.assertAlmostEqual(v["shapeKm"][-1], v["lengthKm"], places=4)
        # 沒有軌跡時：站間直線
        w = self._one([(0, 0), (1, 1)], [])
        self.assertTrue(w["shapeApprox"])
        self.assertAlmostEqual(w["lengthKm"], 1.414, delta=0.01)

    def test_reversed_track_is_oriented_to_stop_order(self):
        # 軌跡是從終點畫回起點的；兩站在 L 形的兩端，沿路 2 km（直線只有 1.41 km，分得出有沒有真的套上）
        v = self._one([(0, 0), (1, 1)], [_track(1, -1, 0, [(1, 1), (1, 0), (0, 0)])])
        self.assertNotIn("shapeApprox", v)
        self.assertEqual([round(s["km"], 2) for s in v["stops"]], [0, 2.0])
        self.assertAlmostEqual(v["shape"][0][0], pt(0, 0)[0], places=4)
        self.assertAlmostEqual(v["shape"][-1][1], pt(1, 1)[1], places=4)

    def test_short_turn_is_cut_to_its_own_section(self):
        # 區間車只跑 12 km 軌跡的 8～10 km 那一段（起點離軌跡開頭很遠）
        v = self._one([(8, 0), (9, 0), (10, 0)], [_track(1, -1, 0, [(0, 0), (12, 0)])])
        self.assertNotIn("shapeApprox", v)
        self.assertAlmostEqual(v["lengthKm"], 2.0, delta=0.01)
        self.assertEqual([round(s["km"], 2) for s in v["stops"]], [0, 1.0, 2.0])
        self.assertAlmostEqual(v["shape"][0][0], pt(8, 0)[0], places=4)
        self.assertAlmostEqual(v["shape"][-1][0], pt(10, 0)[0], places=4)

    def test_track_that_misses_a_stop_is_rejected(self):
        # 繞駛線的一站離主線軌跡 300 m：不能硬套
        v = self._one([(0, 0), (1, 0.3), (2, 0)], [_track(1, -1, 0, [(0, 0), (2, 0)])])
        self.assertTrue(v["shapeApprox"])
        self.assertGreaterEqual(v["maxOffsetM"], 300)
        # 80 m 以內算套得上（站牌在路邊，軌跡在路中央）
        ok = self._one([(0, 0), (1, 0.08), (2, 0)], [_track(1, -1, 0, [(0, 0), (2, 0)])])
        self.assertNotIn("shapeApprox", ok)

    def test_stop_order_against_the_track_is_rejected(self):
        v = self._one([(0, 0), (2, 0), (1, 0)], [_track(1, -1, 0, [(0, 0), (3, 0)])])
        self.assertTrue(v["shapeApprox"], "站序在軌跡上倒退：不採用")

    def test_own_sub_route_track_preferred_over_main(self):
        main = _track(1, -1, 0, [(0, 0), (2, 0)])
        own = _track(1, 10, 0, [(0, 0), (1, 0), (1, 1), (1, 0), (2, 0)])      # 中途繞進去再出來：4 km
        v = self._one([(0, 0), (2, 0)], [main, own])
        self.assertAlmostEqual(v["lengthKm"], 4.0, delta=0.02)
        self.assertAlmostEqual(self._one([(0, 0), (2, 0)], [main])["lengthKm"], 2.0, delta=0.01)
        # 別的子路線的軌跡不拿來用
        other = self._one([(0, 0), (2, 0)], [_track(1, 99, 0, [(0, 0), (2, 0)])])
        self.assertTrue(other["shapeApprox"])

    def test_direction_and_route_must_match(self):
        self.assertTrue(self._one([(0, 0), (2, 0)], [_track(1, -1, 1, [(0, 0), (2, 0)])])["shapeApprox"], "返程的軌跡不能套到去程")
        self.assertTrue(self._one([(0, 0), (2, 0)], [_track(2, -1, 0, [(0, 0), (2, 0)])])["shapeApprox"], "別條路線的軌跡")

    def test_long_gap_between_stops(self):
        # 國道路線：兩站隔 15 km
        v = self._one([(0, 0), (15, 0), (16, 0)], [_track(1, -1, 0, [(0, 0), (16, 0)], step=0.5)])
        self.assertNotIn("shapeApprox", v)
        self.assertEqual([round(s["km"], 1) for s in v["stops"]], [0, 15.0, 16.0])

    def test_simplify_keeps_shape_within_tolerance(self):
        from build_city import SIMPLIFY_M, simplify
        from geo import Polyline
        raw = [pt(x / 100, 0.002 * ((x // 10) % 2)) for x in range(0, 101)]       # 1 km，左右晃 2 m
        self.assertEqual(len(simplify(raw)), 2)
        self.assertEqual(len(simplify([pt(0, 0), pt(0.5, 0.02), pt(1, 0)])), 3, "偏出 20 m 的彎要留著")
        bend = [pt(0, 0), pt(0.5, 0), pt(1, 0), pt(1, 0.5), pt(1, 1)]
        out = simplify(bend)
        self.assertEqual(len(out), 3)
        pl = Polyline(out)
        self.assertLessEqual(max(pl.project(*c).offset_m for c in bend), SIMPLIFY_M)
        self.assertEqual((out[0], out[-1]), (bend[0], bend[-1]))


# ---------------------------------------------------------------- 站牌的行車方位（「往東行的站牌」、判斷哪一根是對面）
class PoleHeadingTest(unittest.TestCase):
    def _files(self, routes):
        """routes: [(主路線, 子路線, 方向, [(站牌編號, x, y)…], 軌跡或 None)] → 路線檔。"""
        from build_city import build_source
        rows, stops, paths, tracks = [], [], [], []
        for rid, sub, g, pts, track in routes:
            rows.append(_route(rid, sub, name=f"線{rid}"))
            ids = []
            for i, (loc, x, y) in enumerate(pts):
                s = _xy_stop(rid * 100 + i, rid, i, g, x, y)
                s["stopLocationId"] = loc
                stops.append(s)
                ids.append(s["Id"])
            paths += _path(sub, ids)
            if track:
                tracks.append(_track(rid, -1, g, track))
        return build_source("tpe", rows, stops, paths, tracks)[0]

    def test_heading_follows_the_road_not_the_chord(self):
        from build_city import heading_at
        east = self._files([(1, 10, 0, [(900, 0, 0), (901, 1, 0)], None)])["tpe:1"]["variants"][0]
        self.assertAlmostEqual(heading_at(east, 0), 90, delta=0.5)
        self.assertIsNone(heading_at(east, 1), "終點站沒有離站後的方位")
        north = self._files([(1, 10, 0, [(900, 0, 0), (901, 0, 1)], None)])["tpe:1"]["variants"][0]
        self.assertAlmostEqual(heading_at(north, 0), 0, delta=0.5)
        west = self._files([(1, 10, 0, [(900, 1, 0), (901, 0, 0)], None)])["tpe:1"]["variants"][0]
        self.assertAlmostEqual(heading_at(west, 0), 270, delta=0.5)
        # 下一站在東北方，但路是先往東再轉北：站牌的方位是「往東」，不是指向下一站的東北
        bent = self._files([(1, 10, 0, [(900, 0, 0), (901, 1, 1)], [(0, 0), (1, 0), (1, 1)])])["tpe:1"]["variants"][0]
        self.assertNotIn("shapeApprox", bent)
        self.assertAlmostEqual(heading_at(bent, 0), 90, delta=1)
        # 中途的站：看的是離站後那一小段，不是從起點算
        mid = self._files([(1, 10, 0, [(900, 0, 0), (901, 1, 0), (902, 1, 1)], [(0, 0), (1, 0), (1, 1)])])["tpe:1"]["variants"][0]
        self.assertAlmostEqual(heading_at(mid, 1), 0, delta=1)
        # 離站 50 m 就轉彎：看的是離站後 100 m 那個點（轉過去 50 m），不是整段路、也不是下一個折點
        hook = self._files([(1, 10, 0, [(900, 0, 0), (901, 0.05, 1)], [(0, 0), (0.05, 0), (0.05, 1)])])["tpe:1"]["variants"][0]
        self.assertNotIn("shapeApprox", hook)
        self.assertAlmostEqual(heading_at(hook, 0), 45, delta=2)

    def test_pole_heading_needs_routes_to_agree(self):
        from build_city import pole_headings
        files = self._files([
            (1, 10, 0, [(900, 0, 0), (901, 1, 0), (902, 2, 0)], None),            # 900、901 往東
            (2, 20, 0, [(900, 0, 0), (901, 1, 0.5), (903, 1, 2)], None),          # 900 往東偏北約 27 度；901 往北
            (3, 30, 0, [(905, 5, 5), (901, 1, 0), (906, 0, 0)], None),            # 901 往西
        ])
        h = pole_headings(files)
        self.assertAlmostEqual(h[900], 77, delta=2, msg="兩條路線差 27 度：取中間")
        self.assertNotIn(901, h, "同一根站牌有路線往東、往北、往西：不標方位")
        self.assertNotIn(902, h, "只當終點的站牌沒有方位")
        self.assertAlmostEqual(h[905], 219, delta=1)
        # 一條往東、一條往北（差 90 度）：不夠一致，不標；三條裡兩條往東、一條偏 30 度：夠一致
        split = pole_headings(self._files([(1, 10, 0, [(900, 0, 0), (901, 1, 0)], None), (2, 20, 0, [(900, 0, 0), (902, 0, 1)], None)]))
        self.assertNotIn(900, split)
        near = pole_headings(self._files([(1, 10, 0, [(900, 0, 0), (901, 1, 0)], None), (2, 20, 0, [(900, 0, 0), (902, 1, 0.01)], None),
                                          (3, 30, 0, [(900, 0, 0), (903, 1, 0.577)], None)]))
        self.assertAlmostEqual(near[900], 80, delta=2)
        # 正北附近（350 度與 10 度）平均要是 0，不是 180
        wrap = pole_headings(self._files([
            (1, 10, 0, [(900, 0, 0), (901, -0.176, 1)], None), (2, 20, 0, [(900, 0, 0), (902, 0.176, 1)], None)]))
        self.assertIn(wrap[900], (359, 0, 1))

    def test_index_carries_heading(self):
        from build_city import build_city
        raw = {"tpe": {"GetRoute": [_route(1, 10, name="甲"), _route(2, 20, name="乙")],
                       "GetStop": [_stop(101, 1, 0, 0, 0, loc=900), _stop(102, 1, 1, 0, 1, loc=901), _stop(103, 1, 2, 0, 2, loc=902),
                                   _stop(201, 2, 0, 0, 2, loc=901), _stop(202, 2, 1, 0, 0, loc=903)],
                       "GetPathDetail": _path(10, [101, 102, 103]) + _path(20, [201, 202])}}
        index, _ = build_city(raw)
        got = {p[0]: p[5] for p in index["plats"]}
        self.assertEqual(index["schema"], 3)
        self.assertEqual(got[900], 90)
        self.assertEqual(got[901], -1, "甲往東、乙往西共用的站牌：不一致，給 -1")


# ---------------------------------------------------------------- 站牌的地址與月台（等車頁的候車位置用它當標籤）
class PoleAddressTest(unittest.TestCase):
    def test_bay_needs_a_number(self):
        from build_city import pole_bay
        self.assertEqual([pole_bay(a) for a in (
            "縣民大道公車專用月台第三月台(向東)", "林口區文化三路一段6號第1月台(向北)", "轉運站第12月台", "淡水轉運站停車場側第二月台(向南)", "第十二月台")],
            ["第三月台", "第1月台", "第12月台", "第二月台", "第十二月台"])
        # 沒有編號的月台（下客月台、接駁月台、「交6月台站區」）認不出是第幾個，不算
        self.assertEqual([pole_bay(a) for a in (
            "大園區航站南路9號下客月台(向東南)", "北新路一段捷運站接駁月台(向西)", "臺北市中正區忠孝西路1段72號對面(交6月台站區)(向西)",
            "民族路290號同向(向東)", "第月台", "", None)], [""] * 7)

    def test_short_address(self):
        from build_city import short_address
        cases = {
            "民族路290號同向(向東)": "民族路290號",                                  # 括號與「同向」拿掉
            "中華路一段166號路側(向南)": "中華路一段166號",
            "中山北路一段30號對向(向北)": "中山北路一段30號對向",                     # 「對向」「對面」是地址的一部分，留著
            "板橋火車站西側門對面(向東)": "板橋火車站西側門對面",
            "新北市汐止區汐萬路三段252巷27號(向南)": "汐萬路三段252巷27號",          # 縣市與行政區拿掉
            "北市中正區鎮江街2號(向南)": "鎮江街2號",
            "臺北市中正區忠孝西路1段72號對面(交6月台站區)(向西)": "忠孝西路1段72號對面",
            "林口區文化三路一段6號第1月台(向北)": "文化三路一段6號第1月台",
            "新店市中正路100號": "中正路100號",                                       # 舊制的市
            "中華路一段台北憲兵隊前(捷運西門站2號出口)(向北)": "中華路一段台北憲兵隊前",   # 兩組括號都拿掉
            "民生路（向西）": "民生路",                                               # 全形括號
            "茂林社區活動中心前(向北)": "茂林社區活動中心前",                         # 「社區」不是行政區：不能削
            "皇家特區大門(向南)": "皇家特區大門",
            "中正路12號(向東)": "中正路12號",                                         # 路名開頭和行政區同名
            "林口區": "林口區",                                                       # 整個地址只有行政區：留著，不要變成空的
            "同向": "", "": "",
        }
        self.assertEqual({a: short_address(a) for a in cases}, cases)
        self.assertEqual(short_address(None), "")

    def test_index_carries_address_and_bay(self):
        from build_city import build_city
        base = {"GetRoute": [_route(1, 10, name="甲")],
                "GetStop": [_stop(101, 1, 0, 0, 0, loc=900), _stop(102, 1, 1, 0, 1, loc=901), _stop(103, 1, 2, 0, 2, loc=902), _stop(104, 1, 3, 0, 3, loc=903)],
                "GetPathDetail": _path(10, [101, 102, 103, 104])}
        loc = [{"id": 900, "address": "新北市板橋區縣民大道公車專用月台第三月台(向東)"}, {"id": 901, "address": "民族路290號同向(向東)"},
               {"id": 902, "address": ""}, {"id": 999, "address": "沒有這根站牌"}]
        index, _ = build_city({"tpe": {**base, "GetStopLocation": loc}})
        rows = {p[0]: p[5:] for p in index["plats"]}
        self.assertEqual(rows[900], [90, "縣民大道公車專用月台第三月台", "第三月台"], "有月台才多一欄")
        self.assertEqual(rows[901], [90, "民族路290號"])
        self.assertEqual(rows[902], [90, ""], "地址空白：空字串，不是 None、也不能少一欄")
        self.assertNotIn(903, rows, "終點站不列")
        # 沒有站牌地址檔：照樣建得出來，地址留空
        plain, _ = build_city({"tpe": base})
        self.assertEqual({p[0]: p[5:] for p in plain["plats"]}, {900: [90, ""], 901: [90, ""], 902: [90, ""]})
        # 兩市共用的站牌：地址以先讀到的來源為準，另一邊空白時不會把它蓋成空的
        other = {"GetRoute": [_route(2, 20, name="乙")], "GetStop": [_stop(201, 2, 0, 0, 0, loc=900), _stop(202, 2, 1, 0, 1, loc=905), _stop(203, 2, 2, 0, 2, loc=906)],
                 "GetPathDetail": _path(20, [201, 202, 203]), "GetStopLocation": [{"id": 900, "address": ""}, {"id": 905, "address": "新北市三重區重新路一段1號"}]}
        both, _ = build_city({"tpe": {**base, "GetStopLocation": loc}, "ntpc": other})
        got = {p[0]: p[6:] for p in both["plats"]}
        self.assertEqual((got[900], got[905]), (["縣民大道公車專用月台第三月台", "第三月台"], ["重新路一段1號"]))
        # 兩邊都有、寫法不同：以先讀到的為準
        other2 = {**other, "GetStopLocation": [{"id": 900, "address": "新北市板橋區另一種寫法"}]}
        first, _ = build_city({"tpe": {**base, "GetStopLocation": loc}, "ntpc": other2})
        self.assertEqual({p[0]: p[6:] for p in first["plats"]}[900], ["縣民大道公車專用月台第三月台", "第三月台"])
        # 先讀到的那一邊是空白：用另一邊的
        swapped, _ = build_city({"ntpc": other, "tpe": {**base, "GetStopLocation": loc}})
        self.assertEqual({p[0]: p[6:] for p in swapped["plats"]}[900], ["縣民大道公車專用月台第三月台", "第三月台"])


if __name__ == "__main__":
    unittest.main()
