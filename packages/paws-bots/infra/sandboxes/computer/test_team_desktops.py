"""Offline Docker lifecycle smoke, invoked by team-desktops.docker.test.ts."""

from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.request import urlopen
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time


def run(commands, key):
    result = subprocess.run(
        ["bash", "-c", commands[key]], text=True, capture_output=True, timeout=90
    )
    if result.returncode:
        raise RuntimeError(f"{key} failed: {result.stderr} {result.stdout}")


def websocket(port, token):
    connection = socket.create_connection(("127.0.0.1", port), 3)
    connection.settimeout(4)
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET /websockify?token={token} HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    connection.sendall(request.encode())
    return connection, connection.recv(8192)


class Page(BaseHTTPRequestHandler):
    def do_GET(self):
        bot = self.path.strip("/")
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        setting = "" if bot == "read" else f"document.cookie='bot_{bot}=saved; Max-Age=86400; Path=/';"
        self.wfile.write(f"<script>{setting} document.title=document.cookie;</script>".encode())

    def log_message(self, *_args):
        pass


def running_programs():
    names = set()
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            argv = (proc / "cmdline").read_bytes().split(b"\0", 1)[0]
        except OSError:
            continue
        if argv:
            names.add(argv.decode(errors="replace").rsplit("/", 1)[-1])
    return names


def assert_file_chooser_portals():
    # Basename match: xdg-desktop-portal-gtk contains the frontend name.
    required = ("xdg-desktop-portal", "xdg-desktop-portal-gtk")
    missing = list(required)
    for _ in range(50):
        running = running_programs()
        missing = [name for name in required if name not in running]
        if not missing:
            return
        time.sleep(0.1)
    raise AssertionError(
        f"file-chooser portal daemons not running: {', '.join(missing)}; see /tmp/rakazo/portal.log and /tmp/rakazo/portal-gtk.log"
    )


def assert_browser_cookies(commands, bot):
    pages = []
    for _ in range(100):
        try:
            with urlopen(f"http://127.0.0.1:{commands['debug' + bot]}/json/list", timeout=1) as response:
                pages = json.load(response)
            if any(f"bot_{bot}=saved" in page.get("title", "") for page in pages):
                assert all(f"bot_{other}=saved" not in page.get("title", "") for page in pages for other in "abc" if other != bot), pages
                return
        except OSError:
            pass
        time.sleep(0.1)
    raise AssertionError(f"Bot {bot}'s independent browser cookie did not load: {pages}")


def main():
    with open(sys.argv[1]) as source:
        commands = json.load(source)
    for port in [8090, 8091]:
        server = ThreadingHTTPServer(("127.0.0.1", port), Page)
        Thread(target=server.serve_forever, daemon=True).start()
    run(commands, "reset")
    run(commands, "gh")
    run(commands, "ensurea")
    assert_file_chooser_portals()
    run(commands, "seed")
    run(commands, "ensureb")
    menu = Path(f"/tmp/fluxbox-home-{commands['displayb']}/.fluxbox/menu").read_text()
    assert "(Terminal)" in menu, f"generated screen menu is missing its Terminal entry: {menu}"
    with ThreadPoolExecutor(2) as pool:
        list(pool.map(lambda step: run(commands, step), ["opena", "openb"]))
    for bot in "ab":
        assert_browser_cookies(commands, bot)
    run(commands, "controla")
    view_port, control_port = int(commands["viewPort"]), int(commands["controlPort"])
    viewer, response = websocket(view_port, "view-a")
    assert b"101 Switching Protocols" in response, response
    peer, response = websocket(view_port, "view-b")
    assert b"101 Switching Protocols" in response, response
    old_targets = [
        line.split(": ", 1)[1].strip().split(":", 1)[1]
        for file in Path("/tmp/rakazo/desktop-targets").glob("*")
        for line in file.read_text().splitlines()
        if line.startswith(("view-a: ", "control-a: "))
    ]
    assert len(old_targets) == 2
    controller, response = websocket(control_port, "control-a")
    assert b"101 Switching Protocols" in response, response

    profile = Path(commands["profilea"])
    login = profile / "fake-login"
    login.write_text("preserved-after-browser-restart")
    # Reopen the same bot after Chromium stops, before any checkpoint/release.
    key = profile.name.removeprefix("chromium-bot-")
    pid = int(Path(f"/tmp/rakazo/browser-pid-{key}").read_text())
    os.kill(pid, 15)
    for _ in range(100):
        if not Path(f"/proc/{pid}/cmdline").exists():
            break
        if not Path(f"/proc/{pid}/cmdline").read_bytes():
            break
        time.sleep(0.1)
    run(commands, "ensurea")
    assert login.read_text() == "preserved-after-browser-restart"
    run(commands, "opena")
    assert_browser_cookies(commands, "a")
    run(commands, "stopa")
    assert login.read_text() == "preserved-after-browser-restart"

    # Old clients must disconnect before the primary slot is reused.
    for connection in [viewer, controller]:
        try:
            while connection.recv(8192):
                pass
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            connection.close()
    run(commands, "ensurec")
    run(commands, "controlc")
    run(commands, "openc")
    assert_browser_cookies(commands, "c")
    assert not (Path(commands["profilec"]) / "fake-login").exists()
    assert_browser_cookies(commands, "b")
    # A delayed lookup of an old mapping must not reach the recycled display.
    for target in old_targets:
        assert not Path(target).exists(), target
    # A peer viewer must stay connected while A is released and C starts.
    mask = os.urandom(4)
    peer.sendall(bytes([0x89, 0x84]) + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(b"peer")))
    data = b""
    while b"\x8a\x04peer" not in data:
        chunk = peer.recv(8192)
        assert chunk, "peer viewer disconnected"
        data += chunk
    peer.close()
    for port, old, current in [(view_port, "view-a", "view-c"), (control_port, "control-a", "control-c")]:
        connection, response = websocket(port, old)
        connection.close()
        assert b"101 Switching Protocols" not in response, response
        connection, response = websocket(port, current)
        connection.close()
        assert b"101 Switching Protocols" in response, response
    assert Path(commands["profileb"]).is_dir()
    run(commands, "closeall")
    run(commands, "ensureb")
    commands["readb"] = commands["openb"].replace("/b </dev/null", "/read </dev/null")
    run(commands, "readb")
    assert_browser_cookies(commands, "b")
    run(commands, "stopb")
    run(commands, "stopc")
    run(commands, "ensurea")
    commands["reada"] = commands["opena"].replace("/a </dev/null", "/read </dev/null")
    run(commands, "reada")
    assert_browser_cookies(commands, "a")
    assert login.read_text() == "preserved-after-browser-restart"
    run(commands, "opena")
    assert_browser_cookies(commands, "a")
    run(commands, "stopa")
    print("PASS: parallel desktops, independent cookies, persistent profiles, desktop cleanup, stale view/control token rejection, and file-chooser portals")


if __name__ == "__main__":
    main()
