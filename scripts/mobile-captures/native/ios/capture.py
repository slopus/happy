#!/usr/bin/env python3
"""Capture the v8 story on one iOS simulator (macOS, Xcode, after install.py).

    capture.py TARGET --repo COPY --sim UDID --out NEW_FOLDER [options]

TARGET  iphone | ipad | duo-inner | duo-outer           five stills (+ alternates)
        iphone-video | ipad-video | duo-inner-video | duo-outer-video   18 s hero recording

Stills come from the UI test's XCUIScreen attachments; the iPhone Duo's inner and outer
screens are not the main screen, so for the Duo the host takes `simctl io --display=N`
screenshots while the test holds each state (it prints `V8_CAPTURE <name>`). The hero is a
continuous `simctl io recordVideo` between the test's STORY_VIDEO_BEGIN and _END lines.

The folder gets: named/ (every state, as captured), inputs/ (the five renderer inputs:
01-home 02-feed 03-model-accounts 04-servers 05-voice, upright), hero-raw.mp4 and
hero-audit.json for videos, xcodebuild.log, capture.json and SHA256SUMS. In `finally`
the recorder and xcodebuild are stopped, the status bar override cleared, and the
simulator shut down if this run booted it.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'lib'))
from capture_common import Record, capture_copy, hashes, need, new_folder  # noqa: E402

RUNNER = 'com.slopus.happy.chat-ui-tests.xctrunner'
TEST = 'HappyChatUITests/StoryV8CaptureUITests'
TARGETS = ['iphone', 'ipad', 'duo-inner', 'duo-outer', 'iphone-video', 'ipad-video', 'duo-inner-video', 'duo-outer-video']
INPUTS = {'01-home': '01-home', '02-feed': '02-feed', '03-model-accounts': '03-model-accounts',
          '04-servers': '04-servers', '05-voice': '05-voice-callfirst'}
# The Duo's screens as `simctl io enumerate` lists them, and the hinge posture each needs.
DUO_DISPLAY = {'inner': '3', 'outer': '1'}
DUO_POSTURE = {'inner': ('open', 'LCD-1'), 'outer': ('close', 'LCD')}


def simctl(*args, check=True, **kw):
    return subprocess.run(['xcrun', 'simctl', *map(str, args)], check=check, **kw)


def booted(sim: str) -> bool:
    out = simctl('list', 'devices', '-j', capture_output=True, text=True).stdout
    devices = [d for group in json.loads(out)['devices'].values() for d in group]
    match = [d for d in devices if d['udid'] == sim]
    if not match:
        raise SystemExit(f'no simulator {sim}')
    return match[0]['state'] == 'Booted'


def fold(hinge: Path, sim: str, screen: str) -> dict:
    """Open or close the Duo with the hinge tool and confirm the active display."""
    action, want = DUO_POSTURE[screen]
    time.sleep(20)  # the hinge service comes up after boot completes
    for _ in range(4):
        if subprocess.run([str(hinge), '-d', sim, '-t', '6', action]).returncode == 0:
            break
        time.sleep(10)
    else:
        raise SystemExit('hinge did not confirm the fold')
    time.sleep(3)
    posture = json.loads(subprocess.check_output([str(hinge), '-d', sim, 'posture', '--json'], text=True))
    if posture.get('activeDisplay') != want:
        raise SystemExit(f'Duo posture {posture}, wanted activeDisplay {want}')
    return posture


def export_attachments(result: Path, out: Path) -> dict[str, Path]:
    """XCUIScreen attachments by their test name (01-home, ...)."""
    raw = out / 'attachments'
    raw.mkdir(exist_ok=True)
    subprocess.run(['xcrun', 'xcresulttool', 'export', 'attachments', '--path', str(result), '--output-path', str(raw)],
                   check=True, stdout=subprocess.DEVNULL)
    named = {}
    manifest = json.loads((raw / 'manifest.json').read_text())
    for test in manifest if isinstance(manifest, list) else [manifest]:
        for item in test.get('attachments', []):
            name = re.sub(r'_\d+_[0-9A-F-]+\.png$', '', item.get('suggestedHumanReadableName', ''))
            if name:
                named[name] = raw / item['exportedFileName']
    return named


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('target', choices=TARGETS)
    parser.add_argument('--repo', required=True, help='capture copy with install.py applied')
    parser.add_argument('--sim', required=True, help='simulator UDID: iPhone 17 Pro Max, iPad Pro 13-inch (M5) or iPhone Duo')
    parser.add_argument('--out', required=True, help='results folder; must not exist yet')
    parser.add_argument('--derived-data', help='xcodebuild DerivedData (default: COPY/.capture-derived)')
    parser.add_argument('--hinge', help='hinge tool for the iPhone Duo (github.com/artemnovichkov/hinge)')
    parser.add_argument('--status-time', default='9:41', help='status bar time; an ISO date also sets the iPad date')
    parser.add_argument('--hold', type=float, help='seconds each state is held (default 1, Duo 3)')
    parser.add_argument('--keep-booted', action='store_true', help='leave the simulator booted afterwards')
    parser.add_argument('--allow-checkout', action='store_true')
    args = parser.parse_args()

    need('xcrun', 'xcodebuild')
    repo = capture_copy(args.repo, args.allow_checkout)
    ios = repo / 'packages/happy-ios'
    if not (ios / 'Tests/HappyChatUITests/StoryV8CaptureUITests.swift').exists():
        raise SystemExit('run ios/install.py on this copy first')
    video = args.target.endswith('-video')
    device = args.target.removesuffix('-video')
    duo = device.removeprefix('duo-') if device.startswith('duo-') else None
    if duo and not args.hinge:
        raise SystemExit('the Duo needs --hinge')
    derived = Path(args.derived_data or repo / '.capture-derived').expanduser()
    out = new_folder(args.out)
    env = {'STORY_HOLD': str(args.hold or (3 if duo else 1))}
    if device == 'ipad':
        env['STORY_ORIENT'] = 'landscape'
    record = Record(out, target=args.target, sim=args.sim, env=env, repo=str(repo),
                    source=(repo / 'SOURCE_COMMIT').read_text().strip() if (repo / 'SOURCE_COMMIT').exists() else None)
    was_booted = booted(args.sim)
    proc = recorder = None
    try:
        if not was_booted:
            simctl('boot', args.sim)
        simctl('bootstatus', args.sim)
        if duo:
            record['posture'] = fold(Path(args.hinge).expanduser(), args.sim, duo)
        simctl('ui', args.sim, 'appearance', 'light')
        simctl('status_bar', args.sim, 'override', '--time', args.status_time, '--dataNetwork', 'wifi',
               '--wifiMode', 'active', '--wifiBars', '3', '--cellularMode', 'active', '--cellularBars', '4',
               '--operatorName', '', '--batteryState', 'charged', '--batteryLevel', '100')
        # A runner left on the simulator can start with the previous test bundle.
        simctl('uninstall', args.sim, RUNNER, check=False)
        result = out / 'test.xcresult'
        cmd = ['xcodebuild', '-project', 'Happy.xcodeproj', '-scheme', 'HappyChatUI', '-configuration', 'Debug',
               '-destination', f'platform=iOS Simulator,id={args.sim}', '-derivedDataPath', str(derived),
               'CODE_SIGNING_ALLOWED=NO', 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES', '-parallel-testing-enabled', 'NO',
               f'-only-testing:{TEST}/{"testHeroVideo" if video else "testStills"}', '-resultBundlePath', str(result), 'test']
        proc = subprocess.Popen(cmd, cwd=ios, env=dict(os.environ, **{f'TEST_RUNNER_{k}': v for k, v in env.items()}),
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        record.save(command=cmd, pids=dict(driver=os.getpid(), xcodebuild=proc.pid))
        display = DUO_DISPLAY.get(duo)
        shots, timing = [], {}
        (out / 'named').mkdir()
        with open(out / 'xcodebuild.log', 'w') as log:
            for line in proc.stdout:
                log.write(line)
                log.flush()
                hold = re.match(r'^V8_CAPTURE ([a-z0-9-]+)', line)
                if hold and display:
                    path = out / 'named' / f'{hold[1]}.png'
                    simctl('io', args.sim, 'screenshot', f'--display={display}', path, stdout=subprocess.DEVNULL)
                    shots.append(dict(name=hold[1], at=time.time()))
                if line.startswith('STORY_VIDEO_BEGIN') and recorder is None:
                    timing['begin'] = time.time()
                    recorder = subprocess.Popen(['xcrun', 'simctl', 'io', args.sim, 'recordVideo', '--codec=h264', '--force',
                                                 *([f'--display={display}'] if display else []), str(out / 'hero-raw.mp4')],
                                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    record['pids']['recorder'] = recorder.pid
                if line.startswith('STORY_VIDEO_END') and recorder:
                    recorder.send_signal(signal.SIGINT)
                    recorder.wait(timeout=30)
                    recorder = None
                    timing['end'] = time.time()
        record['testExitCode'] = proc.wait()
        proc = None
        attachments = export_attachments(result, out)
        for name, path in attachments.items():
            target = out / 'named' / f'{name}.png'
            if not target.exists():
                shutil.copy(path, target)
        upright(out, landscape=device == 'ipad', duo=bool(duo))
        if video and (out / 'hero-raw.mp4').exists():
            audit = subprocess.run([sys.executable, str(HERE.parent / 'audit-video.py'), str(out / 'hero-raw.mp4'),
                                    '--motion', '--json', str(out / 'hero-audit.json')], stdout=subprocess.DEVNULL)
            record['heroAuditExit'] = audit.returncode
        record.update(hostScreenshots=shots, video=timing)
    finally:
        if recorder:
            recorder.send_signal(signal.SIGINT)
            recorder.wait(timeout=30)
        if proc and proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=30)
        simctl('status_bar', args.sim, 'clear', check=False)
        if not was_booted and not args.keep_booted:
            simctl('shutdown', args.sim, check=False)
        (out / 'SHA256SUMS').write_text(''.join(f'{h}  {n}\n' for n, h in hashes(out, '*.png').items()) +
                                        ''.join(f'{h}  {n}\n' for n, h in hashes(out, '*.mp4').items()))
        record.save(finished=time.time())
    print(args.target, 'exit', record.get('testExitCode'), '->', out)
    sys.exit(record.get('testExitCode') or 0)


def upright(out: Path, landscape: bool, duo: bool) -> None:
    """inputs/: the five renderer inputs. XCUIScreen gives an iPad in landscape as its
    portrait framebuffer; turning it is lossless (ffmpeg transpose=2, PNG to PNG)."""
    inputs = out / 'inputs'
    inputs.mkdir()
    for name, source in INPUTS.items():
        path = out / 'named' / f'{source}.png'
        if not path.exists():
            print(f'warning: no {source} capture', file=sys.stderr)
            continue
        if landscape and not duo:
            subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-vf', 'transpose=2', str(inputs / f'{name}.png')], check=True)
        else:
            shutil.copy(path, inputs / f'{name}.png')


if __name__ == '__main__':
    main()
