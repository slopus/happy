#!/usr/bin/env python3
"""Send deduplicated operational alerts using a root-owned Slack webhook config."""

import fcntl
import hashlib
import json
import os
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


def notify(
    key,
    message,
    config_path=Path("/etc/rakazo/alerts.json"),
    state_dir=Path("/var/lib/rakazo/alerts"),
):
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_file = state_dir / (hashlib.sha256(key.encode()).hexdigest() + ".json")
    with open(
        state_file.with_suffix(".lock"),
        "a",
        opener=lambda path, flags: os.open(path, flags, 0o600),
    ) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        _deliver(key, message, config_path, state_file)


def _deliver(key, message, config_path, state_file):
    try:
        previous = json.loads(state_file.read_text())
    except FileNotFoundError:
        previous = {}
    now = time.time()
    changed = message != previous.get("message", "")
    reminder = bool(message) and now - previous.get("sent_at", 0) >= 86400
    if not changed and not reminder:
        return
    text = ("Rakazo alert: " + message) if message else ("Rakazo recovered: " + key)
    try:
        config = json.loads(config_path.read_text())
    except FileNotFoundError:
        # Journal-only monitoring needs no external service or credentials.
        print(text)
    else:
        webhook = config["slack_webhook"]
        if not webhook.startswith("https://hooks.slack.com/services/"):
            raise ValueError("Expected a Slack incoming webhook")
        request = urllib.request.Request(
            webhook,
            json.dumps({"text": text}).encode(),
            {"Content-Type": "application/json"},
            method="POST",
        )
        # Only record delivery after Slack accepts it. Failures retry on the next check.
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status != 200 or response.read().strip() != b"ok":
                raise RuntimeError("Slack did not accept the alert")
    # Unique files also avoid stale temporary files from interrupted deliveries.
    fd, name = tempfile.mkstemp(dir=state_file.parent, suffix=".tmp")
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump({"message": message, "sent_at": now}, output)
        temporary.replace(state_file)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        key = sys.argv[1]
        message = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read().strip()
        notify(key, message)
    except Exception as error:
        # Never log exception URLs, which can contain the webhook credential.
        print(
            "Operational alert delivery failed: " + type(error).__name__,
            file=sys.stderr,
        )
        sys.exit(1)
