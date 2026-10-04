"""全市索引：台北市＋新北市所有路線與站牌，給網頁的搜尋、附近站牌、站牌看板用。

用法：
    python pipeline/build_city.py [--offline]

輸出：
    web/data/city-index.json            路線清單＋實體站牌（座標、哪些路線停、各自的站牌編號、行車方位、地址、月台）
    web/data/routes/<來源>-<路線>.json   每條路線的變體（站序、公里數、班距），使用者追蹤某條路線時才載入

資料來自兩市的公車開放資料靜態檔（GetRoute、GetStop、GetPathDetail、GetBusShape、GetStopLocation），格式相同。
線型用路線軌跡（GetBusShape）：依站序逐站投影，每一站都落在軌跡 100 m 內、公里數不倒退才採用，並裁到這個變體實際行駛的區間。
套不上的變體（繞駛線沒有自己的軌跡、環狀線方向判斷不了）退回「站與站之間的直線」近似（shapeApprox），公里數沿站點折線累計，彎道會略短。
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_app import merge_same_service  # noqa: E402
from geo import Polyline, orient_to_stops  # noqa: E402
from sources import BLOB_HOST, BLOB_SOURCES, BlobStatic  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WEEKDAYS, WEEKEND = ["mon", "tue", "wed", "thu", "fri"], ["sat", "sun"]
APPROX_MAX_OFFSET_M = 400      # 直線近似的路線：車離折線這麼遠以內都算在路線上（彎道、橋、匝道會偏離弦線）
SHAPE_FIT_M = 100              # 路線軌跡要每一站都在這個距離內才算套得上
SHAPE_BACKTRACK_KM = 0.05      # 逐站投影容許的倒退（站牌在路口兩側時會有幾十公尺的前後誤差）
SIMPLIFY_M = 4                 # 軌跡化簡的容許偏差：直線路段上多餘的點拿掉，檔案才不會太大
HEADING_SPAN_KM = 0.1          # 站牌的行車方位：看離站後這麼長的一段路往哪個方位走
HEADING_MIN_R = 0.85           # 會停這根站牌的各路線方位要夠一致（單位向量平均後的長度）才標；總站各路線出站方向不一，不標
BAY_RE = re.compile(r"第(?:[一二三四五六七八九十]+|\d+)月台")
# 地址開頭的縣市與行政區不寫（站名已經說了在哪一帶）。行政區用名單比對，不用「兩三個字加區」去猜：
# 「茂林社區」「皇家特區」是地名的一部分，猜的話會被削掉。舊制的「新店市」「汐止市」資料裡還有，一併認得。
ADDR_CITY_RE = re.compile(r"^(?:臺北市|台北市|新北市|北市|基隆市|桃園市|桃園縣|臺北縣|台北縣)")
ADDR_DISTRICTS = ("中正 大同 中山 松山 大安 萬華 信義 士林 北投 內湖 南港 文山 "
                  "板橋 三重 中和 永和 新莊 新店 樹林 鶯歌 三峽 淡水 汐止 瑞芳 土城 蘆洲 五股 泰山 林口 深坑 石碇 坪林 三芝 石門 八里 平溪 雙溪 貢寮 金山 萬里 烏來 "
                  "仁愛 安樂 暖暖 七堵 桃園 中壢 大溪 楊梅 蘆竹 大園 龜山 八德 龍潭 平鎮 新屋 觀音 復興").split()
ADDR_DISTRICT_RE = re.compile(r"^(?:" + "|".join(ADDR_DISTRICTS) + r")[區市鎮鄉](?=.)")


def parse_wkt(wkt: str) -> list[tuple[float, float]]:
    return [(float(a), float(b)) for a, b in re.findall(r"(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)", wkt or "")]


def _gap_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot((b[0] - a[0]) * 111.32 * math.cos(math.radians(a[1])), (b[1] - a[1]) * 110.54)


def project_in_order(pl: Polyline, pts: list[tuple[float, float]], first_global: bool) -> list:
    """依站序逐站投影到軌跡上。

    第一站：一般從軌跡起點附近找；區間車的起點在軌跡中段，改成全線找（first_global）。
    其餘各站只在前一站之後找，視窗依「到這一站的直線距離」放寬——國道路線兩站可能隔十幾公里。
    """
    out, prev, last = [], None, None
    for lon, lat in pts:
        if prev is None:
            q = pl.project(lon, lat) if first_global else pl.project(lon, lat, km_min=0.0, km_max=6.0)
        else:
            q = pl.project(lon, lat, km_min=max(0.0, prev - SHAPE_BACKTRACK_KM),
                           km_max=prev + max(6.0, _gap_km(last, (lon, lat)) * 2 + 3))
        out.append(q)
        prev = q.km if prev is None else max(prev, q.km)
        last = (lon, lat)
    return out


def simplify(coords: list[tuple[float, float]], tol_m: float = SIMPLIFY_M) -> list[tuple[float, float]]:
    """Douglas–Peucker：拿掉偏離不到 tol_m 的中間點，頭尾保留。"""
    if len(coords) <= 2:
        return list(coords)
    pl = Polyline(coords)
    xy = pl.pts
    keep = [False] * len(xy)
    keep[0] = keep[-1] = True
    stack = [(0, len(xy) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = xy[a], xy[b]
        dx, dy = x2 - x1, y2 - y1
        l2 = dx * dx + dy * dy
        far, idx = 0.0, -1
        for i in range(a + 1, b):
            px, py = xy[i]
            t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / l2))
            d = math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
            if d > far:
                far, idx = d, i
        if far > tol_m:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [c for c, k in zip(coords, keep) if k]


def cut_line(pl: Polyline, k0: float, k1: float) -> list[tuple[float, float]]:
    """取出軌跡上 k0～k1 公里的那一段（頭尾內插）。"""
    cum = pl.cum_km()

    def at(k: float) -> tuple[float, float]:
        for i in range(len(cum) - 1):
            if cum[i] <= k <= cum[i + 1]:
                f = 0.0 if cum[i + 1] == cum[i] else (k - cum[i]) / (cum[i + 1] - cum[i])
                (x1, y1), (x2, y2) = pl.coords[i], pl.coords[i + 1]
                return (x1 + (x2 - x1) * f, y1 + (y2 - y1) * f)
        return pl.coords[-1] if k > cum[-1] else pl.coords[0]

    mid = [c for c, k in zip(pl.coords, cum) if k0 < k < k1]
    return [at(k0)] + mid + [at(k1)]


def fit_shape(coords: list[tuple[float, float]], pts: list[tuple[float, float]]) -> tuple[list, list[float]] | None:
    """把一條路線軌跡套到一個變體的站序上。套得上回傳 (線型, 各站公里數)，套不上回傳 None。

    套得上＝依站序逐站往前找，每一站離軌跡都在 SHAPE_FIT_M 內（站序倒退的站在往前的視窗裡找不到，偏離會很大，自然被擋掉）。線型裁到第一站～最後一站之間並化簡，
    各站公里數是對「最後這條線型」重新投影的結果——網頁用同一條線型算車的位置，兩邊才一致。
    """
    if len(coords) < 2 or len(pts) < 2:
        return None
    coords, _ = orient_to_stops(coords, pts[0], pts[-1])
    pl = Polyline(coords)
    for first_global in (False, True):
        pr = project_in_order(pl, pts, first_global)
        if max(q.offset_m for q in pr) > SHAPE_FIT_M:
            continue
        k0, k1 = pr[0].km, max(q.km for q in pr)
        if k1 - k0 < 0.05:
            continue
        line = simplify(cut_line(pl, k0, k1))
        if len(line) < 2:
            continue
        final = Polyline(line)
        kms, prev = [], 0.0
        for q in project_in_order(final, pts, False):
            prev = max(prev, q.km)                     # 公里數不倒退
            kms.append(prev)
        return line, kms
    return None


def hhmm(s: str | None) -> str | None:
    """'0500' → '05:00'；空白或格式不對回傳 None。"""
    s = (s or "").strip()
    if not re.fullmatch(r"\d{4}", s) or int(s[:2]) > 29 or int(s[2:]) > 59:
        return None
    return f"{s[:2]}:{s[2:]}"


def parse_headway(s: str | None) -> tuple[int, int] | None:
    """班距欄位 → (最短, 最長) 分鐘。'0406' → (4, 6)；'12' → (12, 12)；'510' → (5, 10)；空白 → None。"""
    s = (s or "").strip()
    if not s.isdigit():
        return None
    if len(s) == 4:
        lo, hi = int(s[:2]), int(s[2:])
    elif len(s) == 3:
        lo, hi = int(s[0]), int(s[1:])
    elif len(s) <= 2:
        lo = hi = int(s)
    else:
        return None
    if lo <= 0 or hi <= 0:
        return None
    return (min(lo, hi), max(lo, hi))


def frequency_schedule(route: dict, go_back: int) -> tuple[dict, dict]:
    """路線資料的首末班與班距 → (班距表, 各星期幾的末班時刻)。沒有班距（逐班表路線）時班距表是 none。"""
    side = "go" if go_back == 0 else "back"
    side_h = "holidayGo" if go_back == 0 else "holidayBack"
    windows, last = [], {}
    for days, first_k, last_k, peaks in (
        (WEEKDAYS, f"{side}FirstBusTime", f"{side}LastBusTime", ("peakHeadway", "offPeakHeadway")),
        (WEEKEND, f"{side_h}FirstBusTime", f"{side_h}LastBusTime", ("holidayPeakHeadway", "holidayOffPeakHeadway")),
    ):
        start = hhmm(route.get(first_k)) or hhmm(route.get(f"{side}FirstBusTime"))
        end = hhmm(route.get(last_k)) or hhmm(route.get(f"{side}LastBusTime"))
        if end:
            for d in days:
                last[d] = end
        hs = [h for h in (parse_headway(route.get(k)) for k in peaks) if h]
        if not hs:                                    # 假日欄位空白時沿用平日班距
            hs = [h for h in (parse_headway(route.get(k)) for k in ("peakHeadway", "offPeakHeadway")) if h]
        if start and end and hs and start < end:
            windows.append({"days": days, "start": start, "end": end,
                            "minHeadway": min(h[0] for h in hs), "maxHeadway": max(h[1] for h in hs)})
    return ({"type": "frequency", "windows": windows} if windows else {"type": "none"}), last


def build_route(src: str, subs: list[dict], stop_by_id: dict, paths: dict, shapes: dict | None = None) -> list[dict]:
    """一條路線（同一個主路線編號的所有子路線）→ 變體清單。

    一個子路線編號可能涵蓋去返兩向，也可能只有單向；所以以（子路線, 方向）為單位，
    站序相同的子路線（不同營運業者、區間車重複登錄）再併成一個。
    """
    route = subs[0]
    name, rid = route["nameZh"], route["Id"]
    variants, seen = [], set()
    for sub in subs:
        pid = sub["pathAttributeId"]
        if pid in seen:               # 共營路線：同一個子路線每家業者各登錄一列
            continue
        seen.add(pid)
        by_dir: dict[int, list] = defaultdict(list)
        for seq, stop_id in sorted(paths.get(pid, [])):
            s = stop_by_id.get(stop_id)
            if s:
                by_dir[int(s["goBack"])].append(s)
        for g, ss in sorted(by_dir.items()):
            if len(ss) < 2:
                continue
            coords = [(float(s["longitude"]), float(s["latitude"])) for s in ss]
            pl = Polyline(coords)
            kms = pl.cum_km()
            schedule, last = frequency_schedule(sub, g)
            variants.append({
                "key": f"{name}|{pid}|{g}", "tid": f"{pid}|{g}", "src": src,
                "routeName": name, "routeId": rid, "subRouteId": pid,
                "subRouteName": sub.get("pathAttributeName") or name,
                "label": name, "display": name,
                "toward": (sub.get("destinationZh") if g == 0 else sub.get("departureZh")) or ss[-1]["nameZh"],
                "direction": g, "from": ss[0]["nameZh"], "to": ss[-1]["nameZh"],
                "lastDeparture": last, "schedule": schedule,
                "lengthKm": round(pl.length_km, 4),
                "shapeApprox": True, "maxOffsetM": APPROX_MAX_OFFSET_M,
                "shape": [[round(x, 6), round(y, 6)] for x, y in coords],
                "shapeKm": [round(k, 4) for k in kms],
                "stops": [{"id": s["Id"], "station": s["stopLocationId"], "name": s["nameZh"], "seq": int(s["seqNo"]),
                           "lon": round(x, 6), "lat": round(y, 6), "km": round(k, 4)}
                          for s, (x, y), k in zip(ss, coords, kms)],
            })
    out = merge_same_service(variants)
    # 線型：先找這個變體自己的子路線軌跡，再找主路線的；套不上就維持站間直線
    for v in out:
        g = v["direction"]
        cands = [c for tid in v["tids"] for c in (shapes or {}).get((rid, int(tid.split("|")[0]), g), [])]
        cands += (shapes or {}).get((rid, -1, g), [])
        pts = [(st["lon"], st["lat"]) for st in v["stops"]]
        for coords in cands:
            hit = fit_shape(coords, pts)
            if not hit:
                continue
            line, kms = hit
            v["shape"] = [[round(x, 6), round(y, 6)] for x, y in line]
            v["shapeKm"] = [round(k, 4) for k in Polyline([tuple(c) for c in v["shape"]]).cum_km()]
            v["lengthKm"] = v["shapeKm"][-1]
            for st, k in zip(v["stops"], kms):
                st["km"] = round(min(k, v["lengthKm"]), 4)
            v.pop("shapeApprox", None)
            v.pop("maxOffsetM", None)
            break
    # 同方向還有不只一個變體（站序不同：繞駛、區間）時，用子路線名稱區分；只有一個就直接叫路線名
    per_dir = defaultdict(list)
    for v in out:
        per_dir[v["direction"]].append(v)
    for vs in per_dir.values():
        if len(vs) > 1:
            for v in vs:
                v["label"] = v["display"] = v["subRouteName"]
    return out


def build_source(src: str, routes: list[dict], stops: list[dict], path_rows: list[dict],
                 shape_rows: list[dict] | None = None) -> tuple[dict, list, dict]:
    """一個來源 → ({路線鍵: 路線檔內容}, 路線清單列, {站牌編號: 站牌})。"""
    shapes: dict[tuple, list] = defaultdict(list)          # (主路線, 子路線或 -1, 方向) → [軌跡…]
    for r in shape_rows or []:
        coords = parse_wkt(r.get("wkt"))
        if len(coords) >= 2:
            shapes[(r["RouteID"], int(r["SubRouteID"]), int(r["GoBack"]))].append(coords)
    stop_by_id = {s["Id"]: s for s in stops}
    paths: dict[int, list] = defaultdict(list)
    for p in path_rows:
        paths[p["pathAttributeId"]].append((int(p["sequenceNo"]), p["stopId"]))
    subs_of: dict[int, list] = defaultdict(list)
    for r in routes:
        subs_of[r["Id"]].append(r)

    files, listing = {}, []
    for rid, subs in subs_of.items():
        variants = build_route(src, subs, stop_by_id, paths, shapes)
        if not variants:
            continue
        key = f"{src}:{rid}"
        for v in variants:
            v["family"] = subs[0]["nameZh"]
        files[key] = {"key": key, "src": src, "name": subs[0]["nameZh"], "routeId": rid, "variants": variants}
        listing.append({"key": key, "name": subs[0]["nameZh"], "src": src, "routeId": rid,
                        "dep": subs[0].get("departureZh") or "", "dest": subs[0].get("destinationZh") or ""})

    # 實體站牌：同一個站牌編號（stopLocationId）上所有路線的站。終點站只下不上，不列。
    last_seq: dict[tuple, int] = {}
    for s in stops:
        k = (s["routeId"], s["goBack"])
        last_seq[k] = max(last_seq.get(k, -1), int(s["seqNo"]))
    plats: dict[int, dict] = {}
    for s in stops:
        key = f"{src}:{s['routeId']}"
        if key not in files or int(s["seqNo"]) == last_seq[(s["routeId"], s["goBack"])]:
            continue
        p = plats.setdefault(s["stopLocationId"], {"id": s["stopLocationId"], "name": s["nameZh"],
                                                   "lat": round(float(s["latitude"]), 6), "lon": round(float(s["longitude"]), 6),
                                                   "entries": []})
        e = (key, int(s["goBack"]), s["Id"])
        if e not in p["entries"]:
            p["entries"].append(e)
    return files, listing, plats


def _point_at(shape: list, shape_km: list, k: float) -> tuple[float, float]:
    """線型上第 k 公里的點（線性內插）。"""
    if k <= shape_km[0]:
        return tuple(shape[0])
    for i in range(1, len(shape)):
        if k <= shape_km[i]:
            span = shape_km[i] - shape_km[i - 1]
            f = (k - shape_km[i - 1]) / span if span else 0.0
            (x0, y0), (x1, y1) = shape[i - 1], shape[i]
            return (x0 + (x1 - x0) * f, y0 + (y1 - y0) * f)
    return tuple(shape[-1])


def heading_at(v: dict, i: int) -> float | None:
    """變體在第 i 站離站後的行進方位（0＝北、90＝東，順時針）。終點站沒有「離站後」，回傳 None。"""
    stops = v["stops"]
    if i >= len(stops) - 1:
        return None
    k0 = stops[i]["km"]
    a = _point_at(v["shape"], v["shapeKm"], k0)
    b = _point_at(v["shape"], v["shapeKm"], min(k0 + HEADING_SPAN_KM, v["lengthKm"]))
    dx = (b[0] - a[0]) * math.cos(math.radians(a[1]))
    dy = b[1] - a[1]
    if dx == 0 and dy == 0:              # 兩站疊在同一點：方位無從判斷
        return None
    return math.degrees(math.atan2(dx, dy)) % 360


def pole_headings(files: dict) -> dict:
    """站牌編號 → 行車方位（整數度）。

    一根站牌只在路的一側，會停它的路線離站後原則上往同一個方位走；用這個方位來標「往東行的站牌」，
    標籤就不必靠任何一條路線的終點站名。各路線方位不一致的站牌（總站、路口的轉彎站）不給。
    """
    vecs: dict = defaultdict(list)
    for f in files.values():
        for v in f["variants"]:
            for i, st in enumerate(v["stops"]):
                h = heading_at(v, i)
                if h is not None:
                    vecs[st["station"]].append((math.sin(math.radians(h)), math.cos(math.radians(h))))
    out = {}
    for station, vs in vecs.items():
        x = sum(a for a, _ in vs) / len(vs)
        y = sum(b for _, b in vs) / len(vs)
        if math.hypot(x, y) >= HEADING_MIN_R:
            out[station] = round(math.degrees(math.atan2(x, y))) % 360
    return out


def pole_bay(address: str | None) -> str:
    """站牌地址裡寫的月台（「縣民大道公車專用月台第三月台(向東)」→「第三月台」）；沒有編號的月台（下客月台、接駁月台）不算，回傳空字串。"""
    m = BAY_RE.search(address or "")
    return m.group(0) if m else ""


def short_address(address: str | None) -> str:
    """站牌地址縮短成畫面上認得出是哪一根的寫法。

    拿掉：括號裡的補充（「(向東)」只有四個方向、和實際行車方位對不上一半，不能當方位用）、開頭的縣市與行政區、
    結尾的「同向」「路側」。「對面」「對向」留著——那是地址的一部分（在那個門牌的馬路對面）。
    """
    s = re.sub(r"[(（][^)）]*[)）]", "", address or "").strip()
    s = ADDR_DISTRICT_RE.sub("", ADDR_CITY_RE.sub("", s))
    return re.sub(r"(同向|路側)$", "", s).strip()


def build_city(raw: dict[str, dict]) -> tuple[dict, dict]:
    """raw: {來源: {"GetRoute": [...], "GetStop": [...], "GetPathDetail": [...]}} → (索引, {路線鍵: 路線檔})。

    "GetBusShape"（路線軌跡）與 "GetStopLocation"（站牌地址）可以不給：沒有軌跡就用站間直線，沒有地址就留空。
    """
    files, listing, plats = {}, [], {}
    address: dict = {}                                # 站牌編號 → 地址（兩市共用的站牌以先讀到的為準）
    for src, d in raw.items():
        for r in d.get("GetStopLocation") or []:
            if r.get("address"):
                address.setdefault(r["id"], r["address"])
        f, lst, pl = build_source(src, d["GetRoute"], d["GetStop"], d["GetPathDetail"], d.get("GetBusShape"))
        files.update(f)
        listing += lst
        for pid, p in pl.items():                     # 兩市共用站牌編號：同一根站牌的路線併在一起
            if pid in plats:
                plats[pid]["entries"] += p["entries"]
            else:
                plats[pid] = p
    # 兩市的路線編號、子路線編號、站牌編號目前互不重複；網頁把兩個來源的即時資料合在一起用，萬一哪天撞號要立刻知道
    stop_owner: dict = {}
    for f in files.values():
        for v in f["variants"]:
            for st in v["stops"]:
                stop_owner.setdefault(st["id"], set()).add(f["src"])
    for what, ids in (("主路線編號", [f["routeId"] for f in files.values()]),
                      ("車輛回報編號", [t for f in files.values() for v in f["variants"] for t in v["tids"]])):
        if len(ids) != len(set(ids)):
            seen, dup = set(), set()
            for x in ids:
                (dup if x in seen else seen).add(x)
            raise ValueError(f"{what}在不同來源或路線之間重複：{sorted(dup)[:5]}")
    clash = sorted(k for k, srcs in stop_owner.items() if len(srcs) > 1)
    if clash:
        raise ValueError(f"站牌編號在不同來源之間重複：{clash[:5]}")
    listing.sort(key=lambda r: (r["name"], r["key"]))
    idx_of = {r["key"]: i for i, r in enumerate(listing)}
    headings = pole_headings(files)

    def plat_row(p: dict) -> list:
        row = [p["id"], p["name"], p["lat"], p["lon"], [[idx_of[k], g, sid] for k, g, sid in p["entries"]],
               headings.get(p["id"], -1), short_address(address.get(p["id"]))]
        bay = pole_bay(address.get(p["id"]))
        return row + [bay] if bay else row

    index = {
        "schema": 3, "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "sources": {s: {"name": BLOB_SOURCES[s]["name"], "base": f"{BLOB_HOST}{BLOB_SOURCES[s]['container']}/"} for s in raw},
        # 精簡成陣列以縮小檔案：路線 [鍵, 名稱, 來源, 主路線編號, 起點, 終點]；
        # 站牌 [編號, 站名, 緯度, 經度, [[路線序號, 方向, 站牌編號]...], 行車方位（度；各路線不一致時 -1）, 短地址（沒有就空字串）, 月台（有才有這一欄）]
        "routes": [[r["key"], r["name"], r["src"], r["routeId"], r["dep"], r["dest"]] for r in listing],
        "plats": [plat_row(p) for p in sorted(plats.values(), key=lambda p: p["id"])],
    }
    return index, files


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="只用快取，不連網")
    ap.add_argument("--sources", default=",".join(BLOB_SOURCES), help="要建置的來源，逗號分隔（預設全部）")
    a = ap.parse_args()
    blob = BlobStatic(ROOT / "cache", allow_network=not a.offline)
    raw, notes = {}, []
    for src in a.sources.split(","):
        raw[src] = {}
        for name in ("GetRoute", "GetStop", "GetPathDetail", "GetBusShape", "GetStopLocation"):
            raw[src][name], info = blob.get(src, name)
            notes.append(f"{src} {name}：{len(raw[src][name])} 筆（{info['note']}，資料更新 {info['updateTime']}）")
    index, files = build_city(raw)

    out = ROOT / "web" / "data"
    rdir = out / "routes"
    rdir.mkdir(parents=True, exist_ok=True)
    keep = set()
    for key, f in files.items():
        p = rdir / (key.replace(":", "-") + ".json")
        p.write_text(json.dumps(f, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        keep.add(p.name)
    for p in rdir.glob("*.json"):                     # 已經不存在的路線：移除舊檔
        if p.name not in keep:
            p.unlink()
    ipath = out / "city-index.json"
    ipath.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    for n in notes:
        print(n)
    total = sum(p.stat().st_size for p in rdir.glob("*.json"))
    nvar = sum(len(f["variants"]) for f in files.values())
    print(f"路線 {len(files)} 條（{nvar} 個變體）→ web/data/routes/（共 {total // 1024} KB）")
    print(f"實體站牌 {len(index['plats'])} 根、停靠 {sum(len(p[4]) for p in index['plats'])} 筆 → web/data/city-index.json（{ipath.stat().st_size // 1024} KB）")
    print(f"站牌有地址的 {sum(1 for p in index['plats'] if p[6])} 根、地址寫了月台的 {sum(1 for p in index['plats'] if len(p) > 7)} 根")
    for src in raw:
        vs = [v for f in files.values() if f["src"] == src for v in f["variants"]]
        approx = sum(1 for v in vs if v.get("shapeApprox"))
        print(f"{src} 線型：{len(vs) - approx} 個變體用路線軌跡、{approx} 個套不上（站間直線近似）")
    nosched = sum(1 for f in files.values() for v in f["variants"] if v["schedule"]["type"] == "none")
    print(f"沒有班距資料的變體 {nosched} 個（逐班表路線；這些路線起點未發車的班次不會補列）")


if __name__ == "__main__":
    main()
