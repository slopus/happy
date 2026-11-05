"""SystemUI demo mode for store captures: 09:41, one validated Wi-Fi icon, no mobile
indicator, a full unplugged battery, no notifications.

Demo mode is entered only through the `sysui_tuner_demo_on` setting: an extra explicit
`enter` broadcast drew a second Wi-Fi icon on the API 35 emulator. Configure it after the
last `wm size`/`wm density` change, because those recreate SystemUI.
"""
from __future__ import annotations

import subprocess
import time

DEMO = ['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command']
COMMANDS = [
    DEMO + ['exit'],
    ['shell', 'settings', 'put', 'global', 'sysui_tuner_demo_on', '0'],
    ['shell', 'settings', 'put', 'global', 'development_settings_enabled', '1'],
    ['shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1'],
    ['shell', 'settings', 'put', 'global', 'sysui_tuner_demo_on', '1'],
    DEMO + ['clock', '-e', 'hhmm', '0941'],
    # One network transaction keeps the validated Wi-Fi state while hiding mobile data.
    DEMO + ['network', '-e', 'wifi', 'show', '-e', 'level', '4', '-e', 'fully', 'true', '-e', 'mobile', 'hide',
            '-e', 'sims', '1', '-e', 'airplane', 'hide', '-e', 'nosim', 'hide', '-e', 'carriernetworkchange', 'hide'],
    DEMO + ['battery', '-e', 'level', '100', '-e', 'plugged', 'false'],
    DEMO + ['notifications', '-e', 'visible', 'false'],
    DEMO + ['status', '-e', 'alarm', 'hide', '-e', 'bluetooth', 'hide', '-e', 'mute', 'hide', '-e', 'speakerphone', 'hide'],
]


def configure(adb: list[str]) -> list[dict]:
    """Reset and enter demo mode; returns the audit of every command and the settings read back."""
    audit = []
    for args in COMMANDS:
        r = subprocess.run(adb + args, check=True, capture_output=True, text=True)
        audit.append(dict(args=args, output=r.stdout, stderr=r.stderr))
        time.sleep(0.8 if args[:5] == ['shell', 'settings', 'put', 'global', 'sysui_tuner_demo_on'] else 0.15)
    for key in ('sysui_demo_allowed', 'sysui_tuner_demo_on'):
        r = subprocess.run(adb + ['shell', 'settings', 'get', 'global', key], check=True, capture_output=True, text=True)
        audit.append(dict(args=['settings', 'get', key], output=r.stdout.strip()))
    return audit


def leave(adb: list[str]) -> None:
    subprocess.run(adb + DEMO + ['exit'], check=False, capture_output=True)
    subprocess.run(adb + ['shell', 'settings', 'put', 'global', 'sysui_tuner_demo_on', '0'], check=False, capture_output=True)
