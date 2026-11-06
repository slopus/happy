#!/usr/bin/env python3
"""The iPhone simulator CI tests on, from `xcrun simctl list devices available
--json` at PATH: prints HAPPY_IOS_SIMULATOR_ID=<udid> for $GITHUB_ENV.

    ci-simulator.py PATH
"""
import json
import re
import sys
from pathlib import Path

devices = json.loads(Path(sys.argv[1]).read_text())['devices']
candidates = []
for runtime, entries in devices.items():
    version = re.fullmatch(r'com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?', runtime)
    if not version:
        continue
    numbers = tuple(int(part or 0) for part in version.groups())
    if numbers < (17, 0, 0):
        continue
    for entry in entries:
        if entry.get('isAvailable') and entry['name'].startswith('iPhone'):
            candidates.append((numbers, entry['name'], entry['udid']))
if not candidates:
    raise SystemExit('No available iPhone simulator with iOS 17 or later')
# The device and iOS the tests are checked on locally: an iPhone
# 17-class phone (3x, 402 points wide) on iOS 27.0; otherwise the
# newest iPhone there is.
preferred = ['iPhone 17 Pro', 'iPhone 17', 'iPhone 18 Pro']
local = [c for c in candidates if c[0][:2] == (27, 0) and c[1] in preferred]
if local:
    _, _, device_id = min(local, key=lambda c: preferred.index(c[1]))
else:
    _, _, device_id = max(candidates)
if not re.fullmatch(r'[0-9A-Fa-f-]{36}', device_id):
    raise SystemExit('Invalid simulator UUID')
print(f'HAPPY_IOS_SIMULATOR_ID={device_id}')
