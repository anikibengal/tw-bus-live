"""本機預覽伺服器：回應一律不快取，改了檔案後重新整理就是新版。

Python 內建的 http.server 不送 Cache-Control，瀏覽器會自行判斷沿用舊的 app.js／index.html。

用法：python serve.py [port]      預設 8768，只綁 127.0.0.1，根目錄是 web/
另外把 /logs/ 對到專案的 logs/（唯讀），給頁面的重播模式用：
    http://localhost:8768/?replay=2026-10-03-day&at=0940
"""
import functools
import http.server
import sys
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOGS = (ROOT / "logs").resolve()


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path):
        p = urllib.parse.unquote(path.split("?", 1)[0].split("#", 1)[0])
        if p.startswith("/logs/"):
            target = (LOGS / p[len("/logs/"):]).resolve()
            if target == LOGS or LOGS in target.parents:        # 不讓路徑跳出 logs/
                return str(target)
            return str(LOGS / "__not_allowed__")
        return super().translate_path(path)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8768
    handler = functools.partial(NoCacheHandler, directory=str(ROOT / "web"))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"http://127.0.0.1:{port}/", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
