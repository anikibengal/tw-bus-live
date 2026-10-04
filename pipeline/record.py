"""記錄器：定時存下台北市（或新北市）全市公車即時資料的原始檔，供事後驗證到站推估。

存原始全市檔、不先篩路線，所以之後任何路線都能拿來分析。內容沒變就不重存。

用法：
    python pipeline/record.py --start 21:40 --end 23:59 [--interval 30] [--out logs] [--source ntpcbus --label ntpc]
    兩市要同時錄就各開一個，用 --label 分開存（例如 day 與 day-ntpc）。

輸出（<營運日> 為開始時的日期）：
    logs/<營運日>/<檔名>/<HHMMSS>.gz     原始檔
    logs/<營運日>/manifest.jsonl          每次輪詢一行（成功與否、大小、雜湊、資料更新時間）
    logs/<營運日>/status.json             最新狀態，方便中途查看
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
import time
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BLOB = "https://tcgbusfs.blob.core.windows.net/{}/{}.gz"
SOURCES = ("blobbus", "ntpcbus")     # 台北市、新北市：同一個主機的不同資料夾，格式相同
DEFAULT_FILES = ("GetBusData", "GetEstimateTime", "GetBusEvent")


def keep_awake(on: bool) -> None:
    """Windows：記錄期間要求系統不要進入睡眠（行程結束自動失效，不改任何設定）。"""
    if sys.platform != "win32":
        return
    import ctypes
    ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
    ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if on else 0))


def at_time(hhmm: str, after: datetime) -> datetime:
    h, m = map(int, hhmm.split(":"))
    t = after.replace(hour=h, minute=m, second=0, microsecond=0)
    return t if t >= after - timedelta(minutes=1) else t + timedelta(days=1)


def fetch(name: str, source: str = "blobbus", timeout: float = 25) -> bytes:
    req = urllib.request.Request(BLOB.format(source, name), headers={"User-Agent": "bus-last-trip-map/record"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def update_time(raw: bytes) -> str | None:
    try:
        return json.loads(gzip.decompress(raw).decode("utf-8-sig"))["EssentialInfo"]["UpdateTime"]
    except Exception:
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True, help="HH:MM（本機時間）")
    ap.add_argument("--end", required=True, help="HH:MM；早於開始時間就算隔天")
    ap.add_argument("--interval", type=int, default=30, help="秒")
    ap.add_argument("--files", default=",".join(DEFAULT_FILES))
    ap.add_argument("--out", default=str(ROOT / "logs"))
    ap.add_argument("--label", default="", help="同一天多次記錄時區分用，例如 day、night")
    ap.add_argument("--source", default="blobbus", choices=SOURCES, help="blobbus＝台北市（預設）、ntpcbus＝新北市")
    a = ap.parse_args()

    now = datetime.now()
    start = at_time(a.start, now)
    end = at_time(a.end, start)
    files = [f.strip() for f in a.files.split(",") if f.strip()]
    day_dir = Path(a.out) / (start.strftime("%Y-%m-%d") + (f"-{a.label}" if a.label else ""))
    day_dir.mkdir(parents=True, exist_ok=True)
    manifest = day_dir / "manifest.jsonl"
    print(f"記錄 {a.source} {files}：{start:%m-%d %H:%M} → {end:%m-%d %H:%M}，每 {a.interval} 秒，存到 {day_dir}", flush=True)

    keep_awake(True)
    try:
        while datetime.now() < start:
            time.sleep(min(60, (start - datetime.now()).total_seconds() + 0.1))
        last_hash: dict[str, str] = {}
        stats = {f: {"polls": 0, "ok": 0, "saved": 0, "errors": 0, "lastUpdate": None} for f in files}
        n = 0
        while datetime.now() < end:
            t0 = time.monotonic()
            polled = datetime.now()
            for f in files:
                rec = {"polled": polled.isoformat(timespec="seconds"), "file": f, "ok": False}
                stats[f]["polls"] += 1
                try:
                    raw = fetch(f, a.source)
                    h = hashlib.sha1(raw).hexdigest()
                    rec.update(ok=True, bytes=len(raw), sha1=h, updateTime=update_time(raw))
                    stats[f]["ok"] += 1
                    stats[f]["lastUpdate"] = rec["updateTime"]
                    if last_hash.get(f) != h:
                        p = day_dir / f / f"{polled:%H%M%S}.gz"
                        p.parent.mkdir(exist_ok=True)
                        p.write_bytes(raw)
                        rec["saved"] = str(p.relative_to(day_dir).as_posix())
                        last_hash[f] = h
                        stats[f]["saved"] += 1
                except Exception as e:  # 網路錯誤不中斷，記下來繼續
                    rec["error"] = f"{type(e).__name__}: {e}"[:300]
                    stats[f]["errors"] += 1
                with manifest.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
            (day_dir / "status.json").write_text(json.dumps(
                {"lastPoll": polled.isoformat(timespec="seconds"), "end": end.isoformat(timespec="minutes"),
                 "stats": stats}, ensure_ascii=False, indent=1), encoding="utf-8")
            if n % 10 == 0:
                print(f"{polled:%H:%M:%S} " + "；".join(
                    f"{f} 存{s['saved']}/錯{s['errors']}" for f, s in stats.items()), flush=True)
            time.sleep(max(0, a.interval - (time.monotonic() - t0)))
        print("結束：" + json.dumps(stats, ensure_ascii=False), flush=True)
    finally:
        keep_awake(False)


if __name__ == "__main__":
    main()
