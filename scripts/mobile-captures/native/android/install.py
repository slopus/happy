#!/usr/bin/env python3
"""Install the v8 story fixture into a capture copy for Android device tests.

    install.py --repo COPY [--shift-to today|none|YYYY-MM-DD] [--wide-chart] [--allow-checkout]

Writes into COPY/packages/happy-android/app/src/androidTest:
  assets/marketing/*.json       the StoryData records, as Android's wire fixtures want them
  assets/marketing/chart.html   the inline retention chart page
  assets/marketing/photos/      kirill.jpg, steve.jpg (neutral) from ../../fixtures/photos
  assets/marketing/icons/       the Feed and Home pictures from ../../fixtures/icons
  kotlin/com/slopus/happy/fixture/StoryV8DeviceShots.kt, StoryV8TabletShots.kt, StoryV8HeroMotion.kt
The tablet class is the phone class inside production ProvideWindowLayout; it is generated
here so both stay one source. If the copy predates main 7e32e0945 (two-line account menu
names), patches/account-menu-wrap.patch is applied to it.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'lib'))
from capture_common import capture_copy  # noqa: E402
import story_fixture  # noqa: E402

ACCOUNT_MENU = 'packages/happy-android/app/src/main/kotlin/com/slopus/happy/ui/home/AccountMenu.kt'
TABLET = [
    ('import com.slopus.happy.ui.theme.ThemePreference\n',
     'import com.slopus.happy.ui.theme.ThemePreference\nimport com.slopus.happy.ui.layout.ProvideWindowLayout\n'),
    ('class StoryV8DeviceShots {', 'class StoryV8TabletShots {'),
    ('{ HappyTheme(preference = ThemePreference.Light) { Screens() } }',
     '{ HappyTheme(preference = ThemePreference.Light) { ProvideWindowLayout { Screens() } } }'),
]


def android_record(name: str, value):
    """Android reads the same wire records with explicit order and visibility, and in UTC."""
    if name == 'home' or name.startswith('video'):
        for i, member in enumerate(value['taskMemberships']):
            member['orderKey'] = str(i)
        for i, bot in enumerate(value['bots']):
            bot['orderKey'] = str(i)
        for task in value['tasks']:
            for sub in task['agent'].get('subtasks', []):
                sub['userVisible'] = True
    if name in story_fixture.ANDROID_WALL_TIMES:
        value = story_fixture.wall_in_utc(value, story_fixture.ANDROID_WALL_TIMES[name])
    return value


def tablet_source(phone: str) -> str:
    for old, new in TABLET:
        if phone.count(old) != 1:
            raise SystemExit(f'StoryV8DeviceShots.kt changed near "{old.strip()}"; update TABLET in android/install.py')
        phone = phone.replace(old, new)
    return phone


def product_patch(repo: Path) -> bool:
    if 'labelMaxLines = 2' in (repo / ACCOUNT_MENU).read_text():
        return False
    subprocess.run(['patch', '-p1', '--forward', '--input', str(HERE / 'patches/account-menu-wrap.patch')], cwd=repo, check=True)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--repo', required=True, help='capture copy of the repository (not a Git checkout)')
    parser.add_argument('--shift-to', default='today', help='move fixture times to this day: today, none or YYYY-MM-DD')
    parser.add_argument('--wide-chart', action='store_true', help='phone-sized chart on wide columns (not used by the approved Android sets)')
    parser.add_argument('--allow-checkout', action='store_true')
    args = parser.parse_args()

    repo = capture_copy(args.repo, args.allow_checkout)
    patched = product_patch(repo)
    test = repo / 'packages/happy-android/app/src/androidTest'
    assets = test / 'assets/marketing'
    code = test / 'kotlin/com/slopus/happy/fixture'
    assets.mkdir(parents=True, exist_ok=True)
    code.mkdir(parents=True, exist_ok=True)

    story_fixture.check_roundtrip()
    days = story_fixture.days_until(args.shift_to)
    with tempfile.TemporaryDirectory() as work:
        story = Path(work) / 'StoryData.swift'
        story_fixture.write_story(story, days, args.wide_chart)
        for name, value in story_fixture.records(story).items():
            (assets / f'{name}.json').write_text(json.dumps(android_record(name, value), separators=(',', ':')))
        (assets / 'chart.html').write_text(story_fixture.chart_html(story))
    for folder in ('photos', 'icons'):
        shutil.copytree(story_fixture.FIXTURES / folder, assets / folder, dirs_exist_ok=True)

    phone = (HERE / 'StoryV8DeviceShots.kt').read_text()
    (code / 'StoryV8DeviceShots.kt').write_text(phone)
    (code / 'StoryV8TabletShots.kt').write_text(tablet_source(phone))
    shutil.copy(HERE / 'StoryV8HeroMotion.kt', code / 'StoryV8HeroMotion.kt')
    print(f'installed v8 story fixture into {test} (times moved {days} day(s), wide chart {args.wide_chart}'
          f'{", account-menu patch applied" if patched else ""})')


if __name__ == '__main__':
    main()
