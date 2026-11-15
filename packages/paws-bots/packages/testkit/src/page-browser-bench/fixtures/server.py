"""Serve the page-browser benchmark's fixture pages over HTTPS on two sites, and record what they submit.

Usage: server.py <cert.pem> <key.pem>. The pages are this file's folder. https://localhost:8443 is the
site under test; https://127.0.0.1:8444 serves the same files as a second site, for cross-site frames.
"""

from __future__ import annotations

import json
import os
import ssl
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
SUBMISSIONS: list[dict[str, object]] = []
LOCK = threading.Lock()
# The page's HTML, then the data its script loads, each arrive this many seconds late.
SLOW_SECONDS = 2.0
SEARCH_SECONDS = 0.2
COUNTRIES = [("ca", "Canada"), ("cv", "Cape Verde"), ("fr", "France"), ("jp", "Japan")]


def long_page() -> bytes:
    """A news-style page far larger than a snapshot's budget, with its only form at the very end."""
    parts = ["<!doctype html><title>Archive</title><h1>Archive</h1><nav>"]
    parts += [f'<a href="/index.html?section={n}">Section {n}</a> ' for n in range(60)]
    parts.append("</nav>")
    for n in range(300):
        parts.append(f"<article><h2>Story {n}</h2><p>Story {n} reports on the quarterly figures for region {n % 17}, "
                     f"with notes from {n % 11} analysts and a follow-up planned for week {n % 52}.</p>"
                     f'<a href="/index.html?story={n}">Read story {n}</a> <button type="button">Share story {n}</button>'
                     "</article>")
    parts.append('<form method="post" action="/submit"><label>Newsletter email <input name="email"></label>'
                 "<button>Subscribe</button></form>")
    return "".join(parts).encode()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs) -> None:  # type: ignore[no-untyped-def]
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass

    def send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        url = urlsplit(self.path)
        if url.path.endswith(".py") or url.path.endswith(".pem"):
            self.send(404, b"", "text/plain")
        elif url.path == "/long.html":
            self.send(200, long_page(), "text/html; charset=utf-8")
        elif url.path == "/api/slow":
            time.sleep(SLOW_SECONDS)
            self.send(200, b"ready", "text/plain")
        elif url.path == "/api/search":
            time.sleep(SEARCH_SECONDS)
            query = parse_qs(url.query).get("q", [""])[0].lower()
            found = [pair for pair in COUNTRIES if query and pair[1].lower().startswith(query)]
            self.send(200, json.dumps(found).encode(), "application/json")
        elif url.path == "/__submissions":
            run = parse_qs(url.query).get("run", [""])[0]
            with LOCK:
                found = [s for s in SUBMISSIONS if run and f"run={run}" in str(s["referer"])]
            self.send(200, json.dumps(found).encode(), "application/json")
        else:
            if url.path == "/slow.html":
                time.sleep(SLOW_SECONDS)
            super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if urlsplit(self.path).path != "/submit":
            self.send(404, b"", "text/plain")
            return
        length = min(int(self.headers.get("Content-Length") or 0), 65536)
        fields = {key: values[-1] for key, values in parse_qs(self.rfile.read(length).decode(), keep_blank_values=True).items()}
        with LOCK:
            SUBMISSIONS.append({"referer": self.headers.get("Referer") or "", "host": self.headers.get("Host") or "",
                                "fields": fields})
        self.send(200, b"<!doctype html><title>Received</title><h1>Received</h1>", "text/html; charset=utf-8")


def main() -> None:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(sys.argv[1], sys.argv[2])
    servers = [ThreadingHTTPServer(("127.0.0.1", port), Handler) for port in (8443, 8444)]
    for server in servers:
        server.socket = context.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Event().wait()


if __name__ == "__main__":
    main()
