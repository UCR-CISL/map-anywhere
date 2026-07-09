#!/usr/bin/env python3
"""Serve the model-browser app + reverse-proxy /fixer/* to the Difix fixer.

Static hosting (GitHub Pages) can't reach the cluster GPU: browsers on other
machines resolve 127.0.0.1:8750 to themselves, and Safari blocks https->http
localhost fetches anyway. This one-file stdlib server fixes both by putting the
app and the fixer behind ONE origin:

    /...        -> static files from this directory (models/ symlinks included)
    /fixer/...  -> http://127.0.0.1:8750/...  (webapps/fixer-live/server.py)

Run:  python webapps/model-browser/serve.py --port 8790
      (start the fixer first: python webapps/fixer-live/server.py --port 8750)
"""
import argparse
import http.server
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXER_UPSTREAM = "http://127.0.0.1:8750"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(HERE), **k)

    def _proxy(self):
        if not self.path.startswith("/fixer/"):
            return False
        url = FIXER_UPSTREAM + self.path[len("/fixer"):]
        body = None
        if self.command == "POST":
            body = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
        req = urllib.request.Request(url, data=body, method=self.command)
        if self.headers.get("Content-Type"):
            req.add_header("Content-Type", self.headers["Content-Type"])
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                data = r.read()
                self.send_response(r.status)
                self.send_header("Content-Type", r.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.URLError as e:
            self.send_error(502, f"fixer upstream unreachable ({e}) — start it: python webapps/fixer-live/server.py --port 8750")
        return True

    def do_GET(self):
        if not self._proxy():
            super().do_GET()

    def do_POST(self):
        if not self._proxy():
            self.send_error(404)

    def log_message(self, fmt, *args):   # quiet: only proxy errors matter
        if "/fixer/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    print(f"[model-browser] http://{a.host}:{a.port}/app.html  (fixer proxied at /fixer -> {FIXER_UPSTREAM})", flush=True)
    http.server.ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()
