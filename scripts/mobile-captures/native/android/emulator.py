#!/usr/bin/env python3
"""Start or stop one owned capture emulator: a RAM-backed clone of a prepared AVD.

    emulator.py start --source-avd NAME [--name CLONE] [--port 5850] [--state FILE]
    emulator.py stop  [--state FILE]

`start` copies the source AVD's images to --ram (default /dev/shm/<clone>), so the source
AVD is never written, refuses a serial that is already in use or a host without
--min-free-gb of available memory, and boots headless (swangle, no Vulkan, no snapshots).
It waits for sys.boot_completed. `stop` kills only the process recorded in the state file,
confirms it ended, and removes only the clone's two RAM folders. Source AVD: an API 35
Pixel 9 image (420 dpi, 1080x2424) made once with avdmanager.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'lib'))
from capture_common import write_json  # noqa: E402

SDK = Path(os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT') or '/opt/android-sdk')


def adb() -> str:
    return str(SDK / 'platform-tools/adb')


def available_gb() -> float:
    for line in Path('/proc/meminfo').read_text().splitlines():
        if line.startswith('MemAvailable:'):
            return int(line.split()[1]) / 1024 / 1024
    return 0.0


def start(args) -> None:
    serial = f'emulator-{args.port}'
    if serial in subprocess.check_output([adb(), 'devices'], text=True):
        raise SystemExit(f'{serial} is already running')
    if available_gb() < args.min_free_gb:
        raise SystemExit(f'only {available_gb():.1f} GB available; the capture needs {args.min_free_gb} GB')
    source = Path(args.avd_home).expanduser() / f'{args.source_avd}.avd'
    if not (source / 'config.ini').exists():
        raise SystemExit(f'{source}: no prepared AVD')
    ram = Path(args.ram).expanduser()
    data, home = ram / args.name, ram / f'{args.name}-avds'
    for path in (data, home):
        if path.exists():
            raise SystemExit(f'{path} already exists: another clone may own it; choose --name or stop it first')
    state_file = Path(args.state).expanduser()
    state_file.parent.mkdir(parents=True, exist_ok=True)
    log = state_file.with_suffix('.log')
    # Recorded before anything is made, so `stop` can always undo a partial start.
    state = dict(pid=None, serial=serial, name=args.name, sourceAvd=str(source), ram=[str(data), str(home)], log=str(log))
    write_json(state_file, state)
    try:
        data.mkdir(parents=True)
        home.mkdir()
        for p in source.iterdir():
            if p.is_file() and p.suffix in ('.img', '.qcow2'):
                shutil.copyfile(p, data / p.name)
        shutil.copyfile(source / 'config.ini', data / 'config.ini')
        (home / f'{args.name}.ini').write_text(f'avd.ini.encoding=UTF-8\npath={data}\ntarget=android-{args.api}\n')
        with log.open('wb') as out:
            process = subprocess.Popen([str(SDK / 'emulator/emulator'), '-avd', args.name, '-port', str(args.port), '-no-window',
                                        '-no-audio', '-no-boot-anim', '-no-snapshot-load', '-no-snapshot-save', '-gpu', 'swangle',
                                        '-feature', '-Vulkan', '-memory', str(args.memory)],
                                       env=dict(os.environ, ANDROID_AVD_HOME=str(home)), stdout=out, stderr=subprocess.STDOUT,
                                       stdin=subprocess.DEVNULL, start_new_session=True)
    except BaseException:
        # Nothing was launched: remove only the folders this start made.
        for path in (data, home):
            shutil.rmtree(path, ignore_errors=True)
        state.update(failed=time.time(), removed=state['ram'])
        write_json(state_file, state)
        raise
    state['pid'] = process.pid
    write_json(state_file, state)
    for _ in range(240):
        boot = subprocess.run([adb(), '-s', serial, 'shell', 'getprop', 'sys.boot_completed'], capture_output=True, text=True)
        if boot.stdout.strip() == '1':
            print(f'{serial} booted, PID {process.pid}; state {args.state}')
            return
        if process.poll() is not None:
            raise SystemExit(f'emulator exited ({process.returncode}); see {log}; clean up with: emulator.py stop --state {args.state}')
        time.sleep(1)
    raise SystemExit(f'{serial} did not finish booting; stop it with: emulator.py stop --state {args.state}')


def stop(args) -> None:
    state = json.loads(Path(args.state).expanduser().read_text())
    cmdline = Path(f'/proc/{state["pid"]}/cmdline') if state.get('pid') else None
    def running() -> bool:
        return bool(cmdline and cmdline.exists() and state['name'] in cmdline.read_bytes().replace(b'\0', b' ').decode())
    if running():
        subprocess.run([adb(), '-s', state['serial'], 'emu', 'kill'], check=False)
        for _ in range(80):
            if not running():
                break
            time.sleep(0.25)
        else:
            raise SystemExit(f'emulator PID {state["pid"]} is still running; RAM clone kept')
    for path in state['ram']:
        shutil.rmtree(path, ignore_errors=True)
    state.update(stopped=time.time(), removed=state['ram'])
    write_json(Path(args.state).expanduser(), state)
    print(f'stopped {state["serial"]} (PID {state["pid"]}); removed {", ".join(state["ram"])}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['start', 'stop'])
    parser.add_argument('--state', default='capture-emulator.json', help='where start records what stop must undo')
    parser.add_argument('--source-avd', help='prepared AVD to clone (start)')
    parser.add_argument('--name', default='happy-capture-clone')
    parser.add_argument('--port', type=int, default=5850)
    parser.add_argument('--api', default='35')
    parser.add_argument('--avd-home', default=os.environ.get('ANDROID_AVD_HOME', '~/.android/avd'))
    parser.add_argument('--ram', default='/dev/shm')
    parser.add_argument('--memory', type=int, default=2048, help='guest RAM in MB')
    parser.add_argument('--min-free-gb', type=float, default=7)
    args = parser.parse_args()
    if args.action == 'start':
        if not args.source_avd:
            parser.error('start needs --source-avd')
        start(args)
    else:
        stop(args)


if __name__ == '__main__':
    main()
