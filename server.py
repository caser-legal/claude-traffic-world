#!/usr/bin/env python3
"""tl — Claude Code in traffic.

Zero-dependency (stdlib only) server for the intersection diorama:
  * serves the static app from this directory
  * /api/sessions  — newest Claude Code session transcripts across projects
  * /api/tail      — incremental byte-range tail of one session file
  * /api/weather   — open-meteo proxy (no API key) for the real sky

Run:  python3 server.py [port]     (default 8765)
"""
import json
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECTS = Path.home() / ".claude" / "projects"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
CHUNK = 1 << 20  # 1 MiB max per tail response

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}

_wx_cache = {}  # zip -> (fetched_at, payload)
_wx_lock = threading.Lock()


def _fetch_json(url, timeout=8):
    req = urllib.request.Request(url, headers={"User-Agent": "tl-diorama/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def weather_for(zip_code):
    zip_code = "".join(c for c in zip_code if c.isalnum() and ord(c) < 128)[:16]
    if not zip_code:
        return {"error": "no zip"}
    with _wx_lock:
        hit = _wx_cache.get(zip_code)
        if hit and time.time() - hit[0] < 600:
            return hit[1]

    lat = lon = None
    city = state = ""
    try:  # US zips: precise lat/lon + place name
        geo = _fetch_json(f"https://api.zippopotam.us/us/{urllib.parse.quote(zip_code)}")
        place = geo["places"][0]
        lat, lon = float(place["latitude"]), float(place["longitude"])
        city, state = place.get("place name", ""), place.get("state", "")
    except Exception:
        try:  # international postal codes via open-meteo geocoding
            geo = _fetch_json(
                f"https://geocoding-api.open-meteo.com/v1/search?name={urllib.parse.quote(zip_code)}&count=1"
            )
            hit_place = geo["results"][0]
            lat, lon = hit_place["latitude"], hit_place["longitude"]
            city = hit_place.get("name", "")
        except Exception:
            return {"error": "geocode failed for zip"}
    try:
        wx = _fetch_json(
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lon}"
            "&current=temperature_2m,weather_code,cloud_cover,precipitation,"
            "wind_speed_10m,wind_direction_10m,is_day"
            "&daily=sunrise,sunset&timezone=auto&forecast_days=1"
        )
    except Exception:
        return {"error": "weather fetch failed"}

    out = {
        "zip": zip_code, "city": city, "state": state, "lat": lat, "lon": lon,
        "current": wx.get("current"), "daily": wx.get("daily"),
    }
    with _wx_lock:
        _wx_cache[zip_code] = (time.time(), out)
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/api/sessions":
            sessions = []
            if PROJECTS.is_dir():
                for proj in PROJECTS.iterdir():
                    if not proj.is_dir():
                        continue
                    try:
                        files = list(proj.glob("*.jsonl"))
                    except OSError:
                        continue
                    if not files:
                        continue
                    newest = max(files, key=lambda f: f.stat().st_mtime)
                    st = newest.stat()
                    sessions.append({
                        "project": proj.name,
                        "label": proj.name,
                        "file": str(newest),
                        "size": st.st_size,
                        "mtime": st.st_mtime,
                    })
            sessions.sort(key=lambda s: s["mtime"], reverse=True)
            return self._json({"sessions": sessions[:8]})

        if parsed.path == "/api/tail":
            try:
                target = Path(query.get("file", [""])[0])
                target.resolve().relative_to(PROJECTS.resolve())
            except Exception:
                return self._json({"error": "path must live under ~/.claude/projects"}, 400)
            if not target.is_file():
                return self._json({"error": "missing"}, 404)
            try:
                offset = max(0, int(query.get("offset", ["0"])[0]))
            except ValueError:
                offset = 0
            size = target.stat().st_size
            if offset > size:
                offset = 0
            with target.open("rb") as fh:
                fh.seek(offset)
                data = fh.read(CHUNK)
            return self._json({
                "size": size, "offset": offset,
                "data": data.decode("utf-8", "replace"),
                "more": offset + len(data) < size,
            })

        if parsed.path == "/api/weather":
            return self._json(weather_for(query.get("zip", [""])[0]))

        # ---- static ----
        rel = "index.html" if parsed.path in ("/", "") else parsed.path.lstrip("/")
        path = (ROOT / rel).resolve()
        try:
            path.relative_to(ROOT)
        except ValueError:
            return self.send_error(403)
        if not path.is_file():
            return self.send_error(404)
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(path.suffix, "application/octet-stream"))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    print(f"tl — Claude Code in traffic  →  http://localhost:{PORT}")
    Server(("127.0.0.1", PORT), Handler).serve_forever()
