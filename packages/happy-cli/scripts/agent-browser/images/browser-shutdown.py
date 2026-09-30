#!/usr/bin/env python3
"""Ask Chromium to flush its profile through its normal browser shutdown path."""
import json
import urllib.request
from urllib.parse import urlsplit
import websocket

# Local control only. Do not route the browser's shutdown through an egress proxy.
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open("http://127.0.0.1:9222/json/version", timeout=2) as response:
    endpoint = json.load(response)["webSocketDebuggerUrl"]
parsed = urlsplit(endpoint)
if parsed.scheme != "ws" or parsed.hostname not in ("127.0.0.1", "localhost") or parsed.port != 9222:
    raise RuntimeError("unexpected local Chromium endpoint")
connection = websocket.create_connection(endpoint, timeout=2, suppress_origin=True,
                                         http_no_proxy=["127.0.0.1", "localhost"])
try:
    # Chromium may exit before replying. The entrypoint verifies the process exit itself.
    connection.send(json.dumps({"id": 1, "method": "Browser.close"}))
finally:
    connection.close(timeout=1)
