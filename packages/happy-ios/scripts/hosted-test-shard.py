#!/usr/bin/env python3
"""Which hosted UIKit test classes one CI shard runs.

    hosted-test-shard.py SHARD COUNT

prints `-only-testing:` arguments for shard SHARD (1-based) of COUNT. Every
XCTestCase class under Tests/HappyUIKitHostedTests is in exactly one shard.
Classes are spread by their seconds on a Mac's simulator, heaviest first,
each to the lightest shard so far; a class not listed counts as a light one.
"""
import re
import sys
from pathlib import Path

# The slow ones, in seconds on an M-series Mac's simulator (CI's run 2-5x).
SECONDS = {
    'HostedListResizeTests': 90,
    'HostedHomeListPerfTests': 82,
    'HostedHomeStaleRowsTests': 74,
    'HostedSupportVoiceSettingsTests': 45,
    'HostedChatNavigationTests': 41,
    'HostedSessionInfoTests': 40,
    'HostedOfferSheetsTests': 39,
    'HostedChatFollowTests': 36,
    'HostedComposeTargetTests': 36,
    'HostedHomeInsetsTests': 36,
    'HostedBrowserStatesTests': 28,
    'HostedAttachMenuTests': 26,
    'HostedSettingsSwitchTests': 25,
    'HostedSendFlightTests': 24,
    'HostedVideoStreamTests': 23,
}
LIGHT = 8


def main():
    shard, count = int(sys.argv[1]), int(sys.argv[2])
    if not 1 <= shard <= count:
        raise SystemExit(f'shard {shard} is not one of 1...{count}')
    root = Path(__file__).resolve().parent.parent / 'Tests/HappyUIKitHostedTests'
    classes = sorted({
        name
        for path in root.glob('*.swift')
        for name in re.findall(r'^\s*(?:final\s+)?class\s+(\w+)\s*:\s*XCTestCase\b', path.read_text(), re.M)
    })
    if not classes:
        raise SystemExit(f'no test classes under {root}')
    loads = [0] * count
    shards = [[] for _ in range(count)]
    for name in sorted(classes, key=lambda name: (-SECONDS.get(name, LIGHT), name)):
        lightest = loads.index(min(loads))
        loads[lightest] += SECONDS.get(name, LIGHT)
        shards[lightest].append(name)
    for name in sorted(shards[shard - 1]):
        print(f'-only-testing:HappyUIKitHostedTests/{name}')


if __name__ == '__main__':
    main()
