#!/usr/bin/env python3
"""Capture the v8 story on one Android emulator with the fixture APKs installed.

    capture.py stills  --serial emulator-5850 --apk-dir DIR --out NEW_FOLDER
    capture.py tablets --serial emulator-5850 --apk-dir DIR --out NEW_FOLDER
    capture.py hero    --serial emulator-5850 --apk-dir DIR --out NEW_FOLDER [--size 540x1212 --density 210]

DIR holds app-debug.apk and app-debug-androidTest.apk built from a copy with install.py
applied (see android/remote.sh). Every mode sets SystemUI demo mode after the last display
change, runs one production-screen fixture test, and pulls its PNGs through `run-as`:

  stills   Pixel 9 (1080x2424, 420 dpi): StoryV8DeviceShots#stills
  tablets  tablet-7 (1200x1920, 320 dpi) and tablet-10 (1600x2560, 320 dpi), each a native
           render through production ProvideWindowLayout: StoryV8TabletShots#stills
  hero     continuous `screenrecord` of StoryV8HeroMotion#hero (normal Choreographer, no test
           clock); native 540x1212 at 210 dpi kept the final take under 100 ms per frame

Output: named/, inputs/ (01-home 02-feed 03-model-accounts 04-servers 05-voice; tablets
under inputs/android-7 and inputs/android-10), instrumentation logs, systemui-audit.json,
capture.json and SHA256SUMS; for the hero also hero-raw.mp4, hero-timing.tsv, events.json
and hero-audit.json. In `finally`, display size and density are reset, demo mode left, the
app stopped and the on-device recording removed.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'lib'))
sys.path.insert(0, str(HERE))
from capture_common import Record, hashes, need, new_folder, sha256, write_json  # noqa: E402
import demo_mode  # noqa: E402

SDK = Path(os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT') or '/opt/android-sdk')
SHOTS = ['01-home', '02-feed', '03-model-list', '03-model-accounts', '04-servers', '05-voice']
INPUTS = ['01-home', '02-feed', '03-model-accounts', '04-servers', '05-voice']
TABLETS = [('android-7', 1200, 1920, 320), ('android-10', 1600, 2560, 320)]
RUNNER = 'androidx.test.runner.AndroidJUnitRunner'


class Device:
    def __init__(self, serial: str, package: str):
        self.adb = [str(SDK / 'platform-tools/adb'), '-s', serial]
        self.package = package

    def __call__(self, *args, text=True, check=True, **kw):
        return subprocess.run(self.adb + list(map(str, args)), check=check, capture_output=True, text=text, **kw).stdout

    def files(self, *args, **kw):
        return self('shell', 'run-as', self.package, *args, **kw)

    def instrument(self, test: str, log: Path) -> None:
        out = self('shell', 'am', 'instrument', '-w', '-r', '-e', 'class', f'com.slopus.happy.fixture.{test}',
                   f'{self.package}.test/{RUNNER}')
        log.write_text(out)
        if 'OK (1 test)' not in out:
            raise SystemExit(f'{test} failed; see {log}')

    def pull_shots(self, folder: Path, names: list[str]) -> None:
        folder.mkdir(parents=True, exist_ok=True)
        for name in names:
            (folder / f'{name}.png').write_bytes(self('exec-out', 'run-as', self.package, 'cat', f'files/v8-shots/{name}.png', text=False))

    def display(self, size: str | None, density: int | None) -> None:
        self('shell', 'wm', 'size', size or 'reset')
        self('shell', 'wm', 'density', str(density) if density else 'reset')
        time.sleep(2)


def demo(device: Device, out: Path, name: str) -> None:
    # Twice: the first pass can land while SystemUI is still recreating after a display change.
    demo_mode.configure(device.adb)
    time.sleep(1)
    write_json(out / f'systemui-audit-{name}.json', demo_mode.configure(device.adb))
    (out / f'systemui-check-{name}.png').write_bytes(device('exec-out', 'screencap', '-p', text=False))


def inputs(named: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for name in INPUTS:
        shutil.copy(named / f'{name}.png', dest / f'{name}.png')


def hero(device: Device, out: Path, args, record: Record) -> None:
    device.files('rm', '-f', 'files/v8-shots/hero-ready', 'files/v8-shots/hero-done', check=False)
    log = (out / 'instrumentation-hero.log').open('w')
    test = subprocess.Popen(device.adb + ['shell', 'am', 'instrument', '-w', '-e', 'class', 'com.slopus.happy.fixture.StoryV8HeroMotion#hero',
                                          f'{device.package}.test/{RUNNER}'], stdout=log, stderr=subprocess.STDOUT)
    record['pids']['instrumentation'] = test.pid
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        ready = subprocess.run(device.adb + ['shell', 'run-as', device.package, 'cat', 'files/v8-shots/hero-ready'], capture_output=True, text=True)
        if ready.returncode == 0:
            break
        if test.poll() is not None:
            raise SystemExit('hero test ended before it was ready')
        time.sleep(0.2)
    else:
        raise SystemExit('hero test was not ready within 40 s')
    on_device = args.recording
    size = args.size or '1080x2424'
    recorder = subprocess.Popen(device.adb + ['shell', f'screenrecord --verbose --size {size} --bit-rate {args.bitrate} '
                                              f'--time-limit 40 {on_device} & PID=$!; echo $PID; wait $PID'],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    pid = int(recorder.stdout.readline().strip())
    started = time.time()
    try:
        result = test.wait(timeout=45)
    finally:
        device('shell', 'kill', '-2', pid, check=False)
        tail = recorder.communicate(timeout=20)[0]
        log.close()
    device('pull', on_device, out / 'hero-raw.mp4')
    for name in ('hero-timing.tsv', 'hero-ready', 'hero-done'):
        (out / name).write_bytes(device('shell', 'run-as', device.package, 'cat', f'files/v8-shots/{name}', text=False))
    if result != 0 or 'OK (1 test)' not in (out / 'instrumentation-hero.log').read_text():
        raise SystemExit('hero test failed; see instrumentation-hero.log')
    # When each planned change landed, relative to the sequence start and to the recording.
    events = [line.split('\t') for line in (out / 'hero-timing.tsv').read_text().splitlines() if line]
    begin = int(events[0][1])
    planned = [0, 2.0, 3.2, 4.6, 6.0, 7.4, 8.8, 11.0]
    write_json(out / 'events.json', dict(
        recordingStartedAt=started, heroBeginInRecordingSeconds=begin / 1000 - started,
        events=[dict(name=name, seconds=(int(wall) - begin) / 1000, plannedSeconds=planned[i] if i < len(planned) else None,
                     lateMs=round(((int(wall) - begin) / 1000 - planned[i]) * 1000) if i < len(planned) else None)
                for i, (name, wall, _) in enumerate(events)]))
    record.update(screenrecord=tail, size=size, density=args.density, bitrate=args.bitrate)
    audit = subprocess.run([sys.executable, str(HERE.parent / 'audit-video.py'), str(out / 'hero-raw.mp4'), '--motion',
                            '--max-gap-ms', '100', '--json', str(out / 'hero-audit.json')], stdout=subprocess.DEVNULL)
    record['heroAuditExit'] = audit.returncode


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('mode', choices=['stills', 'tablets', 'hero'])
    parser.add_argument('--serial', default='emulator-5850')
    parser.add_argument('--apk-dir', required=True, help='folder with app-debug.apk and app-debug-androidTest.apk')
    parser.add_argument('--package', default='com.slopus.happy.screenshots', help='the -Phappy.applicationId the APKs were built with')
    parser.add_argument('--out', required=True, help='results folder; must not exist yet')
    parser.add_argument('--size', help='hero: native render size (default 540x1212)')
    parser.add_argument('--density', type=int, help='hero: native density (default 210)')
    parser.add_argument('--bitrate', type=int, default=8_000_000)
    parser.add_argument('--recording', default='/sdcard/happy-capture-hero.mp4')
    args = parser.parse_args()
    if args.mode == 'hero':
        args.size = args.size or '540x1212'
        args.density = args.density or 210

    if args.mode == 'hero':
        need('ffmpeg', 'ffprobe')
    out = new_folder(args.out)
    device = Device(args.serial, args.package)
    apks = [Path(args.apk_dir) / 'app-debug.apk', Path(args.apk_dir) / 'app-debug-androidTest.apk']
    record = Record(out, mode=args.mode, serial=args.serial, package=args.package, pids=dict(driver=os.getpid()),
                    apkSha256={p.name: sha256(p) for p in apks})
    try:
        for _ in range(120):
            if device('shell', 'getprop', 'sys.boot_completed', check=False).strip() == '1':
                break
            time.sleep(1)
        else:
            raise SystemExit(f'{args.serial} has not booted')
        for apk in apks:
            device('install', '-r', apk)
        device('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0')
        device('shell', 'settings', 'put', 'system', 'user_rotation', '0')
        device.files('rm', '-rf', 'files/v8-shots', check=False)
        if args.mode == 'stills':
            device.display(None, None)
            demo(device, out, 'phone')
            started = time.time()
            device.instrument('StoryV8DeviceShots#stills', out / 'instrumentation.log')
            device.pull_shots(out / 'named', SHOTS)
            inputs(out / 'named', out / 'inputs/android')
            record['seconds'] = time.time() - started
        elif args.mode == 'tablets':
            for name, width, height, density in TABLETS:
                device('shell', 'am', 'force-stop', args.package)
                device.display(f'{width}x{height}', density)
                demo(device, out, name)
                started = time.time()
                device.instrument('StoryV8TabletShots#stills', out / f'instrumentation-{name}.log')
                device.pull_shots(out / 'named' / name, SHOTS)
                inputs(out / 'named' / name, out / 'inputs' / name)
                record[name] = dict(size=[width, height], densityDpi=density, windowDp=[width * 160 / density, height * 160 / density],
                                    seconds=time.time() - started)
        else:
            device.display(args.size, args.density)
            demo(device, out, 'hero')
            hero(device, out, args, record)
    finally:
        device('shell', 'rm', '-f', args.recording, check=False)
        device('shell', 'am', 'force-stop', args.package, check=False)
        device('shell', 'wm', 'size', 'reset', check=False)
        device('shell', 'wm', 'density', 'reset', check=False)
        demo_mode.leave(device.adb)
        (out / 'SHA256SUMS').write_text(''.join(f'{h}  {n}\n' for n, h in {**hashes(out, '*.png'), **hashes(out, '*.mp4')}.items()))
        record.save(finished=time.time())
    print(args.mode, 'done ->', out)


if __name__ == '__main__':
    main()
