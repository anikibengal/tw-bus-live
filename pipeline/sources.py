"""資料來源轉接器。每個來源負責「抓＋快取」，不做任何正規化。

目前只有 TDX（靜態：路線、站序、線型、班表）。即時資料由網頁與記錄器直接讀台北市 blob。
新北市路線改 city="NewTaipei" 即可走同一個 TDX 轉接器；即時資料來源屆時另接。
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

TDX_BASE = "https://tdx.transportdata.tw/api/basic/v2/Bus"
TDX_TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token"
TDX_ENDPOINTS = ("Route", "StopOfRoute", "Shape", "Schedule")
UA = "Mozilla/5.0 (bus-last-trip-map)"


def _tdx_token() -> str | None:
    """有設 TDX_CLIENT_ID / TDX_CLIENT_SECRET 才取 token。此路徑尚未實測（目前沒有金鑰）。"""
    cid, secret = os.environ.get("TDX_CLIENT_ID"), os.environ.get("TDX_CLIENT_SECRET")
    if not cid or not secret:
        return None
    body = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": cid,
                                   "client_secret": secret}).encode()
    req = urllib.request.Request(TDX_TOKEN_URL, data=body, headers={
        "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["access_token"]


def _rel(path: Path, cache_root: Path) -> str:
    """快取檔相對於專案根目錄的位置（例：cache/tdx/Taipei/307/Route.json）。

    產出檔（web/data/app-data.js 等）會帶著這個欄位公開出去，不能寫絕對路徑：那會洩漏本機的使用者名稱與資料夾結構。
    """
    try:
        return path.resolve().relative_to(cache_root.resolve().parent).as_posix()
    except ValueError:
        return path.name


class TDX:
    def __init__(self, cache_root: Path, allow_network: bool = True):
        self.cache_root = cache_root
        self.allow_network = allow_network
        self._token: str | None = None
        self._token_tried = False

    def cache_path(self, city: str, route: str, endpoint: str) -> Path:
        return self.cache_root / "tdx" / city / route / f"{endpoint}.json"

    def get(self, city: str, route: str, endpoint: str) -> tuple[list, dict]:
        """回傳 (資料, 來源說明)。有快取就用快取。"""
        path = self.cache_path(city, route, endpoint)
        url = f"{TDX_BASE}/{endpoint}/City/{city}/{urllib.parse.quote(route)}?%24format=JSON"
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            fetched = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(path.stat().st_mtime))
            return data, {"url": url, "cache": _rel(path, self.cache_root), "fetched": fetched}
        if not self.allow_network:
            raise FileNotFoundError(f"快取不存在且禁止連網：{path}")
        if not self._token_tried:
            self._token, self._token_tried = _tdx_token(), True
            if self._token is None:
                print("提醒：沒有 TDX 金鑰，走匿名額度（每 IP 每天 20 次）。", file=sys.stderr)
        headers = {"User-Agent": UA}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            remaining = r.headers.get("X-RateLimit-Remaining-Day")
        data = json.loads(raw.decode("utf-8"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        if remaining is not None:
            print(f"TDX 匿名額度今日剩餘：{remaining}", file=sys.stderr)
        return data, {"url": url, "cache": _rel(path, self.cache_root),
                      "fetched": time.strftime("%Y-%m-%dT%H:%M:%S")}


# ---------------------------------------------------------------- 台北市／新北市公車開放資料（靜態檔）
# 兩市放在同一個主機的不同資料夾，格式相同、免金鑰、允許跨網域。即時檔（GetBusData、GetEstimateTime）由網頁與記錄器直接讀；
# 這裡只抓每天更新一次的靜態檔：路線、站牌、站序。
BLOB_HOST = "https://tcgbusfs.blob.core.windows.net/"
BLOB_SOURCES = {
    "tpe": {"name": "台北市", "container": "blobbus"},
    "ntpc": {"name": "新北市", "container": "ntpcbus"},
}


class BlobStatic:
    def __init__(self, cache_root: Path, allow_network: bool = True, max_age_h: float = 20):
        self.cache_root = cache_root
        self.allow_network = allow_network
        self.max_age_h = max_age_h

    def get(self, src: str, name: str) -> tuple[list, dict]:
        """回傳 (BusInfo 列, 來源說明)。快取夠新就用快取；抓不到而有舊快取時用舊的並註明。"""
        import gzip
        url = f"{BLOB_HOST}{BLOB_SOURCES[src]['container']}/{name}.gz"
        path = self.cache_root / "blob" / src / f"{name}.gz"
        fresh = path.exists() and (time.time() - path.stat().st_mtime) < self.max_age_h * 3600
        note = "快取"
        if not fresh and self.allow_network:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=60) as r:
                    raw = r.read()
                gzip.decompress(raw)                                   # 壞檔不要蓋掉好的快取
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
                note = "剛抓"
            except Exception as e:                                     # noqa: BLE001
                if not path.exists():
                    raise
                note = f"抓取失敗（{e}），沿用舊快取"
        if not path.exists():
            raise FileNotFoundError(f"快取不存在且禁止連網：{path}")
        doc = json.loads(gzip.decompress(path.read_bytes()).decode("utf-8-sig"))
        # 多數檔是 {EssentialInfo, BusInfo}；路線軌跡（GetBusShape）直接是一個陣列
        rows = doc if isinstance(doc, list) else (doc.get("BusInfo") or [])
        info = {"url": url, "cache": _rel(path, self.cache_root), "note": note,
                "updateTime": None if isinstance(doc, list) else (doc.get("EssentialInfo") or {}).get("UpdateTime"),
                "fetched": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(path.stat().st_mtime))}
        return rows, info
