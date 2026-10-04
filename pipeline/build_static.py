"""靜態建置：任一路線 → 通用格式（變體、方向、線型、站與公里數、末班發車、來源與檢查）。

用法：
    python pipeline/build_static.py --route 307 [--city Taipei] [--offline]

輸出：
    data/routes/<city>-<route>.json      完整資料（含來源與檢查結果）；重播驗證讀這個
網頁用的合併資料由 build_app.py 依 config/app.json 產生。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from geo import Polyline, orient_to_stops, project_stops_in_order  # noqa: E402
from sources import TDX  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
OFFSET_WARN_M = 80          # 站點離線型超過這個距離就警告
SERVICE_DAY_ROLLOVER_H = 3  # 03:00 前的時刻算前一天的營運日


def belongs(route_name: str, query: str) -> bool:
    """TDX 以路線名稱查詢會連帶回傳前綴相同的路線（307 → 307西藏三民）。
    只收「同名」或「同名後面接非數字」者，避免 1 抓到 12、307 抓到 3071。"""
    if route_name == query:
        return True
    return route_name.startswith(query) and not route_name[len(query)].isdigit()


def to_minutes(hhmm: str) -> int:
    hhmm = hhmm.replace(":", "")
    h, m = int(hhmm[:2]), int(hhmm[2:4])
    if h < SERVICE_DAY_ROLLOVER_H:
        h += 24
    return h * 60 + m


def fmt(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def parse_wkt(wkt: str) -> list[tuple[float, float]]:
    nums = re.findall(r"(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)", wkt)
    return [(float(a), float(b)) for a, b in nums]


def variant_names(sub_name: str, route_name: str) -> tuple[str, str, str]:
    """子路線名稱 → (變體字樣, 乘客看到的路線名, 名稱裡寫的開往方向)。

    307莒光往撫遠街（路線 307）        → 莒光、307莒光、撫遠街
    307西藏往撫遠街（路線 307西藏三民） → 西藏、307西藏、撫遠街
    265區(三重)（路線 265區）          → 三重、265區、（空）   括號裡是營運業者，對乘客是同一條路線
    """
    base = re.match(r"^[0-9A-Za-z]+", route_name)
    if sub_name.startswith(route_name):
        rest = sub_name[len(route_name):]
    elif base and sub_name.startswith(base.group(0)):
        rest = sub_name[len(base.group(0)):]
    else:
        rest = sub_name
    head, _, toward = rest.partition("往")
    head = head.strip()
    op = re.fullmatch(r"[(（](.+?)[)）](.*)", head)
    if op:
        return (op.group(1) + op.group(2)).strip(), route_name, toward.strip()
    if head:
        return head, (base.group(0) if base else route_name) + head, toward.strip()
    return route_name, route_name, toward.strip()


def last_departures(sched: dict | None) -> tuple[dict, str]:
    """每個星期幾的末班發車時刻。逐班表取各班起點發車的最大值；班距表取各時段結束時間的最大值。"""
    if not sched:
        return {}, "無班表"
    best: dict[str, int] = {}
    if sched.get("Timetables"):
        for trip in sched["Timetables"]:
            st = sorted(trip.get("StopTimes", []), key=lambda s: s["StopSequence"])
            if not st:
                continue
            t = to_minutes(st[0]["DepartureTime"])
            for day, key in zip(DAYS, DAY_KEYS):
                if trip["ServiceDay"].get(day):
                    best[key] = max(best.get(key, -1), t)
        how = "TDX Schedule.Timetables：各班起點發車時刻取最大值"
    elif sched.get("Frequencys"):
        for f in sched["Frequencys"]:
            t = to_minutes(f["EndTime"])
            for day, key in zip(DAYS, DAY_KEYS):
                if f["ServiceDay"].get(day):
                    best[key] = max(best.get(key, -1), t)
        how = "TDX Schedule.Frequencys：各時段 EndTime 取最大值（假設 EndTime＝該時段最後發車）"
    else:
        return {}, "班表為空"
    return {k: fmt(v) for k, v in best.items()}, how


def schedule_info(sched: dict | None) -> dict:
    """起點發車班表，給網頁補上「還沒離站的下一班」。
    逐班表 → 每個星期幾的發車時刻清單；班距表 → 各時段的班距範圍。"""
    if not sched:
        return {"type": "none"}
    if sched.get("Timetables"):
        by_day: dict[str, list[int]] = {k: [] for k in DAY_KEYS}
        for trip in sched["Timetables"]:
            st = sorted(trip.get("StopTimes", []), key=lambda s: s["StopSequence"])
            if not st:
                continue
            t = to_minutes(st[0]["DepartureTime"])
            for day, key in zip(DAYS, DAY_KEYS):
                if trip["ServiceDay"].get(day):
                    by_day[key].append(t)
        return {"type": "timetable",
                "byDay": {k: [fmt(t) for t in sorted(set(v))] for k, v in by_day.items() if v}}
    if sched.get("Frequencys"):
        windows = []
        for f in sched["Frequencys"]:
            days = [key for day, key in zip(DAYS, DAY_KEYS) if f["ServiceDay"].get(day)]
            windows.append({"start": fmt(to_minutes(f["StartTime"])), "end": fmt(to_minutes(f["EndTime"])),
                            "minHeadway": f.get("MinHeadwayMins"), "maxHeadway": f.get("MaxHeadwayMins"),
                            "days": days})
        windows.sort(key=lambda w: (w["days"], w["start"]))
        return {"type": "frequency", "windows": windows}
    return {"type": "none"}


def build(route: str, city: str, offline: bool) -> dict:
    tdx = TDX(ROOT / "cache", allow_network=not offline)
    raw, srcs = {}, {}
    for ep in ("Route", "StopOfRoute", "Shape", "Schedule"):
        raw[ep], srcs[ep] = tdx.get(city, route, ep)

    routes = [r for r in raw["Route"] if belongs(r["RouteName"]["Zh_tw"], route)]
    shapes = {(s["RouteUID"], s["Direction"]): s for s in raw["Shape"]}
    # 同一個子路線編號可能涵蓋去返兩向（例：265區），所以一律用（子路線, 方向）當鍵
    sched = {(s["SubRouteUID"], s["Direction"]): s for s in raw["Schedule"]}
    stop_of = {(s["SubRouteUID"], s["Direction"]): s for s in raw["StopOfRoute"]}

    variants, warnings = [], []
    for r in routes:
        rname = r["RouteName"]["Zh_tw"]
        for sub in r["SubRoutes"]:
            uid, d = sub["SubRouteUID"], sub["Direction"]
            sname = sub["SubRouteName"]["Zh_tw"]
            sor = stop_of.get((uid, d))
            shp = shapes.get((r["RouteUID"], d))
            if not sor or not shp:
                warnings.append(f"{sname}：缺站序或線型，略過")
                continue
            stops_raw = sorted(sor["Stops"], key=lambda s: s["StopSequence"])
            pts = [(s["StopPosition"]["PositionLon"], s["StopPosition"]["PositionLat"]) for s in stops_raw]
            coords, flipped = orient_to_stops(parse_wkt(shp["Geometry"]), pts[0], pts[-1])
            pl = Polyline(coords)
            projs = project_stops_in_order(pl, pts)

            stops, prev_km = [], -1.0
            for s, p in zip(stops_raw, projs):
                if p.km < prev_km - 1e-6:
                    warnings.append(f"{sname}：{s['StopName']['Zh_tw']} 的公里數倒退")
                if p.offset_m > OFFSET_WARN_M:
                    warnings.append(f"{sname}：{s['StopName']['Zh_tw']} 離線型 {p.offset_m:.0f} m")
                prev_km = p.km
                stops.append({
                    "id": s["StopID"], "uid": s["StopUID"], "station": s.get("StationID"),
                    "name": s["StopName"]["Zh_tw"], "seq": s["StopSequence"],
                    "boarding": s.get("StopBoarding"),
                    "lon": round(s["StopPosition"]["PositionLon"], 6),
                    "lat": round(s["StopPosition"]["PositionLat"], 6),
                    "km": round(p.km, 4), "offsetM": round(p.offset_m, 1),
                })

            last, how = last_departures(sched.get((uid, d)))
            declared = {"weekday": sub.get("LastBusTime"), "holiday": sub.get("HolidayLastBusTime")}
            for key in DAY_KEYS:
                ref = declared["holiday" if key in ("sat", "sun") else "weekday"]
                if ref and key in last and last[key] != f"{ref[:2]}:{ref[2:]}":
                    warnings.append(f"{sname}：{key} 班表末班 {last[key]} ≠ 路線資料 LastBusTime {ref}")

            label, display, toward = variant_names(sname, rname)
            if not toward:      # 名稱沒寫方向：去程開往路線終點，返程開往路線起點
                toward = (r.get("DestinationStopNameZh") if d == 0 else r.get("DepartureStopNameZh")) or stops[-1]["name"]
            variants.append({
                "key": f"{rname}|{sub['SubRouteID']}|{d}",
                "tid": f"{sub['SubRouteID']}|{d}",          # 即時資料的對應鍵：車輛回報的 RouteID｜GoBack
                "routeName": rname, "routeId": r["RouteID"],
                "subRouteId": sub["SubRouteID"], "subRouteName": sname,
                "label": label, "display": display, "toward": toward,
                "direction": d,
                "from": stops[0]["name"], "to": stops[-1]["name"],
                "lastDeparture": last, "lastDepartureHow": how,
                "declaredLastBus": declared,
                "declaredFirstBus": {"weekday": sub.get("FirstBusTime"), "holiday": sub.get("HolidayFirstBusTime")},
                "schedule": schedule_info(sched.get((uid, d))),
                "shapeFlipped": flipped,
                "lengthKm": round(pl.length_km, 4),
                "shape": [[round(x, 6), round(y, 6)] for x, y in coords],
                "shapeKm": [round(k, 4) for k in pl.cum_km()],
                "stops": stops,
            })

    # 同方向變體之間的共用站（以 StationID＝實體站位比對）
    shared = {}
    for d in sorted({v["direction"] for v in variants}):
        vs = [v for v in variants if v["direction"] == d]
        if len(vs) >= 2:
            sets = [{s["station"] for s in v["stops"]} for v in vs]
            shared[str(d)] = len(set.intersection(*sets))

    return {
        "schema": 1,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "route": route, "city": city,
        "operators": sorted({o["OperatorName"]["Zh_tw"] for r in routes for o in r["Operators"]}),
        "sources": srcs,
        "variants": variants,
        "checks": {
            "variants": len(variants),
            "stops": {v["key"]: len(v["stops"]) for v in variants},
            "maxStopOffsetM": {v["key"]: max(s["offsetM"] for s in v["stops"]) for v in variants},
            "sharedStationsByDirection": shared,
            "warnings": warnings,
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--route", required=True)
    ap.add_argument("--city", default="Taipei")
    ap.add_argument("--offline", action="store_true", help="只用快取，不連網")
    a = ap.parse_args()

    data = build(a.route, a.city, a.offline)
    out_json = ROOT / "data" / "routes" / f"{a.city}-{a.route}.json"
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    c = data["checks"]
    print(f"{a.city} {a.route}：{c['variants']} 個變體，站數 {c['stops']}")
    print(f"站點離線型最大距離（m）：{c['maxStopOffsetM']}")
    print(f"同方向共用站：{c['sharedStationsByDirection']}")
    for v in data["variants"]:
        print(f"  {v['subRouteName']}（{v['display']}，{'去' if v['direction'] == 0 else '返'}程往{v['toward']}）：{len(v['stops'])} 站、{v['lengthKm']:.2f} km、"
              f"末班 {sorted(set(v['lastDeparture'].values())) or '無班表'}")
    print(f"警告 {len(c['warnings'])} 則" + ("：" if c["warnings"] else ""))
    for w in c["warnings"]:
        print("  -", w)
    print(f"輸出：{out_json.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
