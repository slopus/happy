#!/usr/bin/env python3
"""Frame-timing audit for a native capture or a composed video.

    audit-video.py VIDEO [--json OUT] [--max-gap-ms 50] [--motion]

Reports the stream (codec, profile, level, size, rotation, bit rate, audio), frame count,
span, mean rate, median and largest frame gaps, the gaps over 34/50/67/100 ms, and
timestamps that fail to increase. A simulator or `screenrecord` file is variable rate: it
writes a frame only when the screen changes, so a long gap over a still screen is not a
stall. `--motion` decodes a small grey copy and reports stalls where they show: a frame
identical to the one before while its neighbours move, and a long gap that ends in motion.

Exit status 1 when any gap that ends in motion exceeds --max-gap-ms, or timestamps go back.
Needs ffmpeg and ffprobe.
"""
from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
from pathlib import Path

W, H = 120, 90


def probe(video: Path) -> dict:
    out = subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(video)])
    return json.loads(out)


def times(video: Path) -> list[float]:
    out = subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                                   'frame=best_effort_timestamp_time', '-of', 'csv=p=0', str(video)], text=True)
    return [float(x.strip(',')) for x in out.split() if x.strip(',') not in ('', 'N/A')]


def frames(video: Path) -> list[bytes]:
    raw = subprocess.check_output(['ffmpeg', '-v', 'fatal', '-i', str(video), '-vf', f'scale={W}:{H},format=gray',
                                   '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'])
    n = W * H
    return [raw[i * n:(i + 1) * n] for i in range(len(raw) // n)]


def change(a: bytes, b: bytes) -> float:
    return sum(abs(x - y) for x, y in zip(a[::3], b[::3])) / len(a[::3])


def audit(video: Path, motion: bool, max_gap: float) -> dict:
    info = probe(video)
    vs = next(s for s in info['streams'] if s['codec_type'] == 'video')
    audio = [s for s in info['streams'] if s['codec_type'] == 'audio']
    rotation = next((d.get('rotation') for d in vs.get('side_data_list', []) if 'rotation' in d), 0)
    ts = times(video)
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    report = dict(
        file=str(video), codec=vs.get('codec_name'), profile=vs.get('profile'), level=vs.get('level'),
        size=[vs['width'], vs['height']], rotation=rotation, pixFmt=vs.get('pix_fmt'),
        bitRate=int(info['format'].get('bit_rate', 0)), duration=float(info['format'].get('duration', 0)),
        audio=[dict(codec=a.get('codec_name'), sampleRate=a.get('sample_rate'), channels=a.get('channels')) for a in audio],
        frames=len(ts), span=ts[-1] - ts[0] if ts else 0,
        meanFps=(len(ts) - 1) / (ts[-1] - ts[0]) if len(ts) > 1 and ts[-1] > ts[0] else None,
        medianGapMs=statistics.median(gaps) * 1000 if gaps else None, maxGapMs=max(gaps) * 1000 if gaps else None,
        gapsOver={f'{ms}ms': sum(g > ms / 1000 for g in gaps) for ms in (34, 50, 67, 100)},
        nonIncreasing=sum(g <= 0 for g in gaps),
        largestGaps=[dict(atSeconds=round(ts[i], 3), gapMs=round(g * 1000, 1)) for i, g in sorted(enumerate(gaps), key=lambda x: -x[1])[:8]],
    )
    failures = []
    if report['nonIncreasing']:
        failures.append('timestamps do not increase')
    if motion:
        fr = frames(video)
        n = min(len(fr), len(ts))
        report['decodedFrames'] = len(fr)
        steps = [change(fr[i], fr[i + 1]) for i in range(n - 1)]
        moving = 0.3
        dupes = [round(ts[i], 3) for i in range(1, len(steps) - 1)
                 if steps[i] < 0.02 and steps[i - 1] > moving and steps[i + 1] > moving]
        held = [dict(atSeconds=round(ts[i], 3), gapMs=round(gaps[i] * 1000, 1), change=round(steps[i], 2))
                for i in range(len(steps)) if gaps[i] * 1000 > max_gap and steps[i] > moving]
        report.update(duplicatesInMotion=dupes, longGapsEndingInMotion=held)
        if held:
            failures.append(f'{len(held)} gap(s) over {max_gap:g} ms end in motion')
    report['failures'] = failures
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('video', type=Path)
    parser.add_argument('--json', type=Path, help='also write the report here')
    parser.add_argument('--max-gap-ms', type=float, default=50)
    parser.add_argument('--motion', action='store_true', help='decode and check stalls during motion')
    args = parser.parse_args()
    report = audit(args.video, args.motion, args.max_gap_ms)
    text = json.dumps(report, indent=2)
    if args.json:
        args.json.write_text(text + '\n')
    print(text)
    sys.exit(1 if report['failures'] else 0)


if __name__ == '__main__':
    main()
