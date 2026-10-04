"""看記錄器最新快照裡某條路線的狀況（車輛位置、勤務狀態、預估到站代碼分布）。

用法：python pipeline/peek.py [--route 307] [--city Taipei] [--day logs/2026-10-03]
"""
from __future__ import annotations

import argparse
import collections
import gzip
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
from geo import Polyline  # noqa: E402

CODES = {-1: "尚未發車", -2: "交管不停靠", -3: "末班車已過(規格)", -4: "今日未營運"}


def latest(day: Path, name: str) -> Path | None:
    files = sorted((day / name).glob("*.gz"))
    return files[-1] if files else None


def load(p: Path) -> dict:
    return json.loads(gzip.decompress(p.read_bytes()).decode("utf-8-sig"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--route", default="307")
    ap.add_argument("--city", default="Taipei")
    ap.add_argument("--day", help="logs/<日期> 目錄；預設取最新一天")
    a = ap.parse_args()

    day = Path(a.day) if a.day else sorted(p for p in (ROOT / "logs").iterdir() if p.is_dir())[-1]
    data = json.loads((ROOT / "data" / "routes" / f"{a.city}-{a.route}.json").read_text(encoding="utf-8"))
    V = {str(v["subRouteId"]): v for v in data["variants"]}
    status = day / "status.json"
    if status.exists():
        s = json.loads(status.read_text(encoding="utf-8"))
        print(f"記錄器：最後輪詢 {s['lastPoll']}，預計結束 {s['end']}")
        for f, st in s["stats"].items():
            print(f"  {f}: 輪詢 {st['polls']}、存 {st['saved']}、錯誤 {st['errors']}、資料時間 {st['lastUpdate']}")

    bd_path = latest(day, "GetBusData")
    if bd_path:
        bd = load(bd_path)
        print(f"\n車輛（{bd['EssentialInfo']['UpdateTime']}）")
        rows = [r for r in bd["BusInfo"] if str(r["RouteID"]) in V]
        for sid, v in sorted(V.items(), key=lambda kv: (kv[1]["direction"], kv[1]["label"])):
            pl = Polyline([tuple(p) for p in v["shape"]])
            buses = []
            for r in rows:
                if str(r["RouteID"]) != sid:
                    continue
                p = pl.project(float(r["Longitude"]), float(r["Latitude"]))
                buses.append((p.km, r, p.offset_m))
            buses.sort(key=lambda x: x[0])
            desc = "；".join(f"{r['BusID']} {km:.1f}km 勤務{r['DutyStatus']}{'(偏' + str(round(off)) + 'm)' if off > 150 else ''}"
                            for km, r, off in buses) or "無"
            print(f"  {v['subRouteName']}（{v['lengthKm']:.1f} km）：{desc}")

    et_path = latest(day, "GetEstimateTime")
    if et_path:
        et = load(et_path)
        print(f"\n預估到站代碼（{et['EssentialInfo']['UpdateTime']}）")
        for v in sorted(data["variants"], key=lambda v: (v["direction"], v["label"])):
            stop_ids = {str(s["id"]) for s in v["stops"]}
            vals = [int(r["EstimateTime"]) for r in et["BusInfo"]
                    if str(r["RouteID"]) == str(v["routeId"]) and str(r["GoBack"]) == str(v["direction"])
                    and str(r["StopID"]) in stop_ids]
            c = collections.Counter("有預估" if x >= 0 else CODES.get(x, str(x)) for x in vals)
            print(f"  {v['subRouteName']}：{dict(c)}（共 {len(vals)}/{len(v['stops'])} 站）")


if __name__ == "__main__":
    main()
