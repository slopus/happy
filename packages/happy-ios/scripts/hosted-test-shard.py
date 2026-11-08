#!/usr/bin/env python3
"""Which hosted UIKit tests one CI shard runs.

    hosted-test-shard.py SHARD COUNT
    hosted-test-shard.py perf

The first prints `-only-testing:` arguments for shard SHARD (1-based) of
COUNT, and `-skip-testing:` for the perf plan's tests in its classes. Every
XCTestCase class under Tests/HappyUIKitHostedTests not wholly in the perf
plan is in exactly one shard. Classes are spread by their seconds on a Mac's
simulator, heaviest first, each to the lightest shard so far; a class not
listed counts as a light one.

`perf` prints `-only-testing:` for the perf plan (`hosted-perf-tests.txt`).
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


def perf_plan(classes):
    """The perf plan's entries, each a class or Class/testMethod."""
    path = Path(__file__).resolve().parent / 'hosted-perf-tests.txt'
    entries = [line.split('#')[0].strip() for line in path.read_text().splitlines()]
    entries = [entry for entry in entries if entry]
    for entry in entries:
        if entry.split('/')[0] not in classes:
            raise SystemExit(f'{path.name}: no hosted test class {entry}')
    return entries


def main():
    root = Path(__file__).resolve().parent.parent / 'Tests/HappyUIKitHostedTests'
    classes = sorted({
        name
        for path in root.glob('*.swift')
        for name in re.findall(r'^\s*(?:final\s+)?class\s+(\w+)\s*:\s*XCTestCase\b', path.read_text(), re.M)
    })
    if not classes:
        raise SystemExit(f'no test classes under {root}')
    perf = perf_plan(classes)
    if sys.argv[1:2] == ['perf']:
        for entry in perf:
            print(f'-only-testing:HappyUIKitHostedTests/{entry}')
        return
    shard, count = int(sys.argv[1]), int(sys.argv[2])
    if not 1 <= shard <= count:
        raise SystemExit(f'shard {shard} is not one of 1...{count}')
    classes = [name for name in classes if name not in perf]
    loads = [0] * count
    shards = [[] for _ in range(count)]
    for name in sorted(classes, key=lambda name: (-SECONDS.get(name, LIGHT), name)):
        lightest = loads.index(min(loads))
        loads[lightest] += SECONDS.get(name, LIGHT)
        shards[lightest].append(name)
    for name in sorted(shards[shard - 1]):
        print(f'-only-testing:HappyUIKitHostedTests/{name}')
        for entry in perf:
            if entry.startswith(name + '/'):
                print(f'-skip-testing:HappyUIKitHostedTests/{entry}')


if __name__ == '__main__':
    main()
