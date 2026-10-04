"""路線幾何：把站點投影到線型上，算出沿線公里數。

座標一律 (lon, lat)。距離用以路線起點為原點的等距平面近似（台北範圍內誤差遠小於 1 m/km）。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON_EQ = 111_320.0


class LocalPlane:
    """經緯度 ↔ 公尺的局部平面。"""

    def __init__(self, lon0: float, lat0: float):
        self.lon0, self.lat0 = lon0, lat0
        self.kx = M_PER_DEG_LON_EQ * math.cos(math.radians(lat0))

    def xy(self, lon: float, lat: float) -> tuple[float, float]:
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * M_PER_DEG_LAT)


@dataclass
class Projection:
    km: float          # 沿線公里數
    offset_m: float    # 點到線型的垂直距離
    seg: int           # 落在第幾段


class Polyline:
    def __init__(self, coords: list[tuple[float, float]]):
        if len(coords) < 2:
            raise ValueError("線型至少要兩個點")
        self.coords = coords
        self.plane = LocalPlane(*coords[0])
        self.pts = [self.plane.xy(lon, lat) for lon, lat in coords]
        cum = [0.0]
        for (x1, y1), (x2, y2) in zip(self.pts, self.pts[1:]):
            cum.append(cum[-1] + math.hypot(x2 - x1, y2 - y1))
        self.cum_m = cum

    @property
    def length_km(self) -> float:
        return self.cum_m[-1] / 1000

    def cum_km(self) -> list[float]:
        return [c / 1000 for c in self.cum_m]

    def project(self, lon: float, lat: float, km_min: float | None = None,
                km_max: float | None = None) -> Projection:
        """回傳點在 [km_min, km_max] 範圍內最近的投影。範圍內沒有線段時退回全線。"""
        px, py = self.plane.xy(lon, lat)
        lo_m = -math.inf if km_min is None else km_min * 1000
        hi_m = math.inf if km_max is None else km_max * 1000
        best = None
        for i in range(len(self.pts) - 1):
            a0, a1 = self.cum_m[i], self.cum_m[i + 1]
            if a1 < lo_m or a0 > hi_m:
                continue
            (x1, y1), (x2, y2) = self.pts[i], self.pts[i + 1]
            dx, dy = x2 - x1, y2 - y1
            seg_len2 = dx * dx + dy * dy
            t = 0.0 if seg_len2 == 0 else ((px - x1) * dx + (py - y1) * dy) / seg_len2
            t = min(1.0, max(0.0, t))
            along = a0 + t * (a1 - a0)
            # 夾在視窗內：視窗只切到線段一部分時，投影點不能跑出視窗
            if along < lo_m or along > hi_m:
                along = min(hi_m, max(lo_m, along))
                t = 0.0 if a1 == a0 else (along - a0) / (a1 - a0)
            qx, qy = x1 + t * dx, y1 + t * dy
            d = math.hypot(px - qx, py - qy)
            if best is None or d < best.offset_m:
                best = Projection(km=along / 1000, offset_m=d, seg=i)
        if best is None:
            return self.project(lon, lat)
        return best


def orient_to_stops(coords: list[tuple[float, float]], first_stop: tuple[float, float],
                    last_stop: tuple[float, float]) -> tuple[list[tuple[float, float]], bool]:
    """線型方向若與站序相反就反轉。回傳 (線型, 是否反轉)。"""
    pl = Polyline(coords)
    a = pl.project(*first_stop).km
    b = pl.project(*last_stop).km
    if a > b:
        return list(reversed(coords)), True
    return coords, False


def project_stops_in_order(pl: Polyline, stops: list[tuple[float, float]],
                           lookahead_km: float = 6.0, backtrack_km: float = 0.05) -> list[Projection]:
    """依站序逐站投影，每站只在前一站之後的視窗內找，避免線型繞回時投到錯的那一段。"""
    out: list[Projection] = []
    prev = 0.0
    for lon, lat in stops:
        p = pl.project(lon, lat, km_min=max(0.0, prev - backtrack_km), km_max=prev + lookahead_km)
        out.append(p)
        prev = max(prev, p.km)
    return out
