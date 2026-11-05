"""The v8 story fixture: one fictional StoryData.swift shared by iOS and Android.

`../fixtures/StoryData.swift` holds every wire record as a JSON literal
(`static let home = #"` ... `"#`, triple-quoted) plus base64 pictures and the chart page.
The records carry absolute times from the day they were written (09:30 in
America/Los_Angeles on 2026-11-05), so a capture on a later day would group
the Feed under an old date. `shift_to` moves every time by whole days, so the
clock reads the same and today's rows stay "Today"; usage resets keep their
weekday ("resets Thu 9:00 AM").
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

NATIVE = Path(__file__).resolve().parents[1]
FIXTURES = NATIVE.parent / 'fixtures'
STORY = FIXTURES / 'StoryData.swift'

# The morning the records were written for, in the iOS fixture's wall time.
WRITTEN = date(2026, 11, 5)
ZONE = ZoneInfo('America/Los_Angeles')
TIME_KEYS = {'capturedAt', 'createdAt', 'dueAt', 'endedAt', 'firstAt', 'lastAt', 'refreshedAt',
             'scannedAt', 'seenAt', 'since', 'startedAt', 'updatedAt'}
BLOCK = re.compile(r'(    static let (\w+) = #"""\n    )(.*?)(\n    """#)', re.S)


def records(source: Path = STORY) -> dict[str, object]:
    """Every JSON record in StoryData.swift by name (home, feed, video0, ...)."""
    return {name: json.loads(raw) for _, name, raw, _ in BLOCK.findall(source.read_text())}


def chart_html(source: Path = STORY) -> str:
    text = source.read_text()
    match = re.search(r'static let chartHTML = #"""\n(.*?)\n"""#', text, re.S)
    if not match:
        raise SystemExit(f'{source}: no chartHTML block')
    return match.group(1)


def days_until(target: str) -> int:
    """Whole days from the written morning to `target` (today, none or YYYY-MM-DD)."""
    if target == 'none':
        return 0
    day = datetime.now(ZONE).date() if target == 'today' else date.fromisoformat(target)
    return (day - WRITTEN).days


def _moved(ms: int | float, days: int) -> int | float:
    """The same wall-clock time `days` later in the fixture's zone (DST-safe)."""
    local = datetime.fromtimestamp(ms / 1000, ZONE)
    moved = datetime.combine(local.date() + timedelta(days=days), local.timetz().replace(tzinfo=None), ZONE)
    return type(ms)(round(moved.timestamp() * 1000)) if isinstance(ms, int) else moved.timestamp() * 1000


MORNING = datetime(2026, 11, 5, 9, 30, tzinfo=ZONE)


def shift(value, days: int, key: str | None = None):
    """The record with every time moved by `days`; a reset becomes the first one, on its
    written weekday and hour, after the moved morning."""
    if isinstance(value, dict):
        return {k: shift(v, days, k) for k, v in value.items()}
    if isinstance(value, list):
        return [shift(v, days, key) for v in value]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not days:
        return value
    if key in TIME_KEYS:
        return _moved(value, days)
    if key == 'resetsAt':
        morning = _moved(MORNING.timestamp() * 1000, days)
        weeks = (days // 7) - 1
        while _moved(value, weeks * 7) <= morning:
            weeks += 1
        return _moved(value, weeks * 7)
    return value


# The records whose wall times Android shows, and the keys that hold them (as captured for v8).
ANDROID_WALL_TIMES = {'page': {'startedAt', 'endedAt', 'createdAt'}, 'voicepage': {'startedAt', 'endedAt', 'createdAt'},
                      'feed': {'firstAt', 'lastAt', 'seenAt'}, 'usage': {'resetsAt'}}


def wall_in_utc(value, keys: set[str], key: str | None = None):
    """The record with each Los Angeles wall time under `keys` re-expressed as the same wall
    time in UTC. Android's fixture process runs in UTC, so "9:30 AM" must be 09:30Z there."""
    if isinstance(value, dict):
        return {k: wall_in_utc(v, keys, k) for k, v in value.items()}
    if isinstance(value, list):
        return [wall_in_utc(v, keys, key) for v in value]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or key not in keys:
        return value
    local = datetime.fromtimestamp(value / 1000, ZONE).replace(tzinfo=ZoneInfo('UTC'))
    return type(value)(round(local.timestamp() * 1000))


# Wide chat columns (the iPhone Duo's inner screen) keep the chart phone-sized, so the
# answer, chart, legend and caption share one screen. Phones (< 560 pt) are unchanged.
CHART_RULE = 'svg { display: block; width: 100%; height: auto; overflow: visible; }\n'
WIDE_CHART = (CHART_RULE + "/* Wide chat columns (iPad, the Duo's inner screen): keep the chart phone-sized so the\n"
              "   question, reply, chart and legend share one screen. Phones (< 560 pt) are unchanged. */\n"
              "@media (min-width: 560px) { svg { max-width: 300px; } }\n")


def with_wide_chart(text: str) -> str:
    if WIDE_CHART in text:
        return text
    if text.count(CHART_RULE) != 1:
        raise SystemExit('StoryData chartHTML changed; update WIDE_CHART in story_fixture.py')
    return text.replace(CHART_RULE, WIDE_CHART)


def write_story(destination: Path, days: int, wide_chart: bool = False, source: Path = STORY) -> None:
    """StoryData.swift moved by `days`; byte-identical to the source when days is 0 and
    wide_chart is off."""
    text = source.read_text()
    if wide_chart:
        text = with_wide_chart(text)
    if days:
        def moved(match: re.Match) -> str:
            value = shift(json.loads(match.group(3)), days)
            return match.group(1) + json.dumps(value, separators=(',', ':'), ensure_ascii=False) + match.group(4)
        text = BLOCK.sub(moved, text)
    destination.write_text(text)


def check_roundtrip(source: Path = STORY) -> None:
    """Every record must re-encode to its exact bytes, or a shift would change more than times."""
    for _, name, raw, _ in BLOCK.findall(source.read_text()):
        if json.dumps(json.loads(raw), separators=(',', ':'), ensure_ascii=False) != raw:
            raise SystemExit(f'{source}: record {name} does not round-trip through JSON')
