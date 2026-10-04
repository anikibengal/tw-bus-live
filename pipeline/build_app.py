"""網頁用資料：依 config/app.json 把多條路線合成一份，並算出每個常用地點的月台（實體站位）。

用法：
    python pipeline/build_app.py [--offline]

輸出：web/data/app-data.js（window.BUS_APP_DATA）

地點與月台的概念來自 tw-bus：人站的是「一根實體站牌」，同一根站牌上甲路線可能算去程、乙路線算返程，
所以用實體站位（StationID）分組，而不是用去／返程。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_static import build  # noqa: E402
from sources import BLOB_HOST, BLOB_SOURCES  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def platforms_for(place: dict, variants: list[dict]) -> list[dict]:
    """這個地點的月台：站名符合、且是使用者會搭的路線；同一個實體站位併成一個月台。"""
    match, routes = set(place["match"]), set(place["routes"])
    plats: dict[str, dict] = {}
    for v in variants:
        if v["routeName"] not in routes:
            continue
        for si, s in enumerate(v["stops"]):
            if s["name"] not in match or si == len(v["stops"]) - 1:      # 終點站只下不上，不列
                continue
            key = str(s["station"] or f'{s["name"]}@{s["lat"]},{s["lon"]}')
            p = plats.setdefault(key, {"station": key, "name": s["name"], "lat": s["lat"], "lon": s["lon"],
                                       "entries": [], "toward": []})
            p["entries"].append({"key": v["key"], "si": si})
            if v["toward"] not in p["toward"]:
                p["toward"].append(v["toward"])
    out = sorted(plats.values(), key=lambda p: (p["toward"], p["name"]))
    for p in out:
        p["label"] = "往 " + "、".join(p["toward"])
    return out


def merge_same_service(variants: list[dict]) -> list[dict]:
    """同一條路線、同方向、站序完全相同的子路線（例：265區 的三重客運與大南汽車）併成一個變體。

    對乘客是同一班車；官方預估到站也是整條路線共用一個數字，分開追蹤會把同一個數字重複分給不同業者的車。
    併完後 tids 列出所有會出現在車輛回報裡的編號，班距表取較寬的營運時段。
    """
    out, index = [], {}
    for v in variants:
        sig = (v["routeId"], v["direction"], tuple(s["id"] for s in v["stops"]))
        m = index.get(sig)
        if m is None:
            m = dict(v, tids=[v["tid"]], merged=[v["subRouteName"]])
            index[sig] = m
            out.append(m)
            continue
        m["tids"].append(v["tid"])
        m["merged"].append(v["subRouteName"])
        for day, t in v["lastDeparture"].items():
            if t > m["lastDeparture"].get(day, ""):
                m["lastDeparture"] = dict(m["lastDeparture"], **{day: t})
        a, b = m["schedule"], v["schedule"]
        if a["type"] == "none":
            m["schedule"] = b
        elif a["type"] == "frequency" and b["type"] == "frequency":
            wins = {tuple(w["days"]): dict(w) for w in a["windows"]}
            for w in b["windows"]:
                k = tuple(w["days"])
                if k not in wins:
                    wins[k] = dict(w)
                    continue
                x = wins[k]
                x["start"], x["end"] = min(x["start"], w["start"]), max(x["end"], w["end"])
                x["minHeadway"] = min(x["minHeadway"], w["minHeadway"])
                x["maxHeadway"] = max(x["maxHeadway"], w["maxHeadway"])
            # 任何一邊的班距只是登記數字（nominal）：合併後也是，不能因為重組就變成可以拿來補班次
            flag = {"nominal": True} if a.get("nominal") or b.get("nominal") else {}
            m["schedule"] = {"type": "frequency", **flag, "windows": list(wins.values())}
    for m in out:
        if len(m["merged"]) > 1:
            m["label"] = m["display"]
    return out


def use_official_names(variants: list[dict], ends: dict) -> None:
    """顯示名稱與「往哪裡」統一用官方公布的，和全市索引、找公車頁一致（2026-10-04 使用者：路線名統一用官方的）。

    build_static 依子路線名稱取的簡稱（307莒光、307西藏）只有內建路線才有，其他路線都是官方名稱，同一個畫面上會兩種寫法並存。
    同一條路線同方向只有一個變體時直接叫路線名；有好幾個（區間、繞駛）才保留子路線取的名稱來區分。
    「往哪裡」用全市索引的起迄點（去程往迄點、返程往起點）；索引裡查不到的路線維持原樣。
    ends: {主路線編號（字串）: (起點, 迄點)}
    """
    per = defaultdict(list)
    for v in variants:
        per[(v["routeName"], v["direction"])].append(v)
    for (name, _), vs in per.items():
        if len(vs) == 1:
            vs[0]["display"] = name
    for v in variants:
        dep, dest = ends.get(str(v["routeId"]), ("", ""))
        toward = dest if v["direction"] == 0 else dep
        if toward:
            v["toward"] = toward


def official_ends() -> dict:
    """全市索引裡每條路線的起迄點：{主路線編號（字串）: (起點, 迄點)}。索引由 build_city.py 產生；沒有就回傳空的。"""
    path = ROOT / "web" / "data" / "city-index.json"
    if not path.exists():
        return {}
    return {str(r[3]): (r[4], r[5]) for r in json.loads(path.read_text(encoding="utf-8"))["routes"]}


def build_app(cfg: dict, offline: bool) -> dict:
    variants, sources, warnings, operators = [], {}, [], set()
    for q in cfg["routes"]:
        d = build(q, cfg["city"], offline)
        for v in merge_same_service(d["variants"]):
            v["family"] = q                    # 路線分頁用：同一次查詢回來的變體算一家（307 與 307西藏三民）
            variants.append(v)
        sources[q] = d["sources"]
        operators.update(d["operators"])
        warnings += [f"{q}：{w}" for w in d["checks"]["warnings"]]

    ends = official_ends()
    if not ends:
        warnings.append("找不到全市索引（先跑 build_city.py）：「往哪裡」沿用 TDX 的站名，可能和找公車頁不一致")
    use_official_names(variants, ends)

    keys = [v["key"] for v in variants]
    tids = [t for v in variants for t in v["tids"]]
    assert len(set(keys)) == len(keys), "變體 key 重複"
    assert len(set(tids)) == len(tids), "變體 tid 重複"

    places = []
    for pl in cfg["places"]:
        plats = platforms_for(pl, variants)
        if not plats:
            warnings.append(f"地點「{pl['name']}」找不到符合的站牌：{pl['match']}")
        loaded = {v["routeName"] for v in variants}
        # 網頁在執行時依站名（match）重新找站牌，使用者追蹤的其他路線才會一起列進來；platforms 只是建置時的檢查結果
        places.append({"name": pl["name"], "match": pl["match"], "platforms": plats,
                       "routes": [r for r in pl["routes"] if r in loaded],
                       "missing": [r for r in pl["routes"] if r not in loaded]})
    for v in variants:
        v["src"] = "tpe"                       # 內建路線目前都是台北市轄（TDX City=Taipei）
    follow, missing = resolve_follow(cfg.get("follow", []))
    warnings += [f"預設追蹤的路線「{n}」在全市索引裡找不到（先跑 build_city.py）" for n in missing]
    return {"schema": 3, "generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "city": cfg["city"],
            "families": cfg["routes"], "operators": sorted(operators),
            "sources": {s: {"name": BLOB_SOURCES[s]["name"], "base": f"{BLOB_HOST}{BLOB_SOURCES[s]['container']}/"}
                        for s in cfg.get("sources", ["tpe"])},
            "follow": follow,
            "show": cfg.get("show", cfg["routes"]),      # 第一次打開時開著的路線；其餘載入但先關著，由使用者自己開
            "variants": variants, "places": places, "tdx": sources,
            "checks": {"variants": len(variants), "warnings": warnings}}


def resolve_follow(names: list[str]) -> tuple[list[str], list[str]]:
    """預設追蹤的路線名稱 → 全市索引的路線鍵（「來源:主路線編號」）。索引由 build_city.py 產生。"""
    path = ROOT / "web" / "data" / "city-index.json"
    if not names:
        return [], []
    if not path.exists():
        return [], list(names)
    by_name: dict[str, list[str]] = {}
    for key, name, *_ in json.loads(path.read_text(encoding="utf-8"))["routes"]:
        by_name.setdefault(name, []).append(key)
    keys, missing = [], []
    for n in names:
        if n in by_name:
            keys += by_name[n]
        else:
            missing.append(n)
    return keys, missing


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "config" / "app.json"))
    ap.add_argument("--offline", action="store_true", help="只用快取，不連網")
    a = ap.parse_args()
    cfg = json.loads(Path(a.config).read_text(encoding="utf-8"))
    data = build_app(cfg, a.offline)
    out = ROOT / "web" / "data" / "app-data.js"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("window.BUS_APP_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n",
                   encoding="utf-8")
    print(f"{len(data['variants'])} 個變體（{'、'.join(data['families'])}）→ {out.relative_to(ROOT)}（{out.stat().st_size // 1024} KB）")
    for pl in data["places"]:
        print(f"地點 {pl['name']}：{len(pl['platforms'])} 個月台（內建路線）" + (f"；設定了但沒載入 {pl['missing']}" if pl["missing"] else ""))
        by_key = {v["key"]: v for v in data["variants"]}
        for p in pl["platforms"]:
            who = sorted({by_key[e["key"]]["display"] for e in p["entries"]})
            print(f"  {p['name']}（{p['label']}）：{'、'.join(who)}，{len(p['entries'])} 個變體")
    print(f"預設追蹤 {data['follow']}；即時資料來源 {list(data['sources'])}")
    w = data["checks"]["warnings"]
    print(f"警告 {len(w)} 則")
    for x in w:
        print("  -", x)


if __name__ == "__main__":
    main()
