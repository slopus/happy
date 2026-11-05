#!/usr/bin/env python3
"""Install the v8 story fixture into a capture copy of the repository.

    install.py --repo COPY [--shift-to today|none|YYYY-MM-DD] [--wide-chart] [--no-xcodegen] [--allow-checkout]

Writes into COPY/packages/happy-ios:
  Harness/StoryHarness.swift            fictional in-memory computer (this folder)
  Harness/StoryData.swift               ../../fixtures/StoryData.swift, times moved to --shift-to;
                                        --wide-chart caps the chart at 300 pt on wide columns
                                        (the approved Duo inner 05; every other set without it)
  Tests/HappyChatUITests/StoryV8CaptureUITests.swift
and routes `-screen story` in Harness/ChatHarness.swift to the story harness. Then
regenerates Happy.xcodeproj with xcodegen (macOS). The harness and test exist only in
DEBUG/HAPPY_FIXTURES builds of the HappyChat test host; nothing ships.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'lib'))
from capture_common import capture_copy, sha256  # noqa: E402
import story_fixture  # noqa: E402

FIELD = '    private var homeRenderer: HomeRendererHarness?'
ROUTE = '        if arguments.contains("-homeScrollDiagnostic") {'
STORY_ROUTE = '''        if let index = arguments.firstIndex(of: "-screen"), arguments.indices.contains(index + 1), arguments[index + 1] == "story" {
            storyHarness = StoryHarness(window: window, arguments: arguments)
            return
        }
'''
# Product behaviour the stills depend on, already on main (c1fe74714): a two-line account
# menu title so "Happy Engineering Team" is whole.
ACCOUNT_MENU = ('Sources/HappyUI/Navigation/AccountSwitcher.swift', 'let limit: CGFloat = 300')


def route_story(chat: Path) -> None:
    text = chat.read_text()
    if 'storyHarness = StoryHarness' in text:
        return
    for anchor in (FIELD, ROUTE):
        if text.count(anchor) != 1:
            raise SystemExit(f'{chat}: expected one "{anchor.strip()}"; ChatHarness changed, update ios/install.py')
    text = text.replace(FIELD, FIELD + '\n    private var storyHarness: StoryHarness?')
    text = text.replace(ROUTE, STORY_ROUTE + ROUTE)
    chat.write_text(text)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--repo', required=True, help='capture copy of the repository (not a Git checkout)')
    parser.add_argument('--shift-to', default='today', help='move fixture times to this day: today, none or YYYY-MM-DD')
    parser.add_argument('--wide-chart', action='store_true', help='phone-sized chart on wide chat columns (Duo inner 05)')
    parser.add_argument('--no-xcodegen', action='store_true', help='skip regenerating Happy.xcodeproj (Linux checks)')
    parser.add_argument('--allow-checkout', action='store_true', help='install into a Git checkout anyway')
    args = parser.parse_args()

    repo = capture_copy(args.repo, args.allow_checkout)
    ios = repo / 'packages/happy-ios'
    path, needle = ACCOUNT_MENU
    if needle not in (ios / path).read_text():
        raise SystemExit(f'{ios / path}: needs the two-line account menu title ({needle}); sync a newer main')

    story_fixture.check_roundtrip()
    days = story_fixture.days_until(args.shift_to)
    story_fixture.write_story(ios / 'Harness/StoryData.swift', days, args.wide_chart)
    shutil.copy(HERE / 'StoryHarness.swift', ios / 'Harness/StoryHarness.swift')
    shutil.copy(HERE / 'StoryV8CaptureUITests.swift', ios / 'Tests/HappyChatUITests/StoryV8CaptureUITests.swift')
    route_story(ios / 'Harness/ChatHarness.swift')
    if not args.no_xcodegen:
        subprocess.run(['xcodegen', 'generate'], cwd=ios, check=True, stdout=subprocess.DEVNULL)
    print(f'installed v8 story fixture into {ios} (times moved {days} day(s), wide chart {args.wide_chart}; '
          f'StoryData sha256 {sha256(ios / "Harness/StoryData.swift")[:12]})')


if __name__ == '__main__':
    main()
