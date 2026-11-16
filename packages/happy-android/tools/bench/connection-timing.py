#!/usr/bin/env python3
"""Times connecting on a phone from the app's HappyTiming lines (diagnostics/Timing.kt).

    ANDROID_SERIAL=<device> tools/bench/connection-timing.py cold [-n 5]
    ANDROID_SERIAL=<device> tools/bench/connection-timing.py chat --url 'happy://<instanceId>/agents/<agentId>' [-n 5]
    ANDROID_SERIAL=<device> tools/bench/connection-timing.py warm --url ... --away 60 [-n 5]
    ANDROID_SERIAL=<device> tools/bench/connection-timing.py net --url ... --allow-wifi-toggle [-n 3]
    ANDROID_SERIAL=<device> tools/bench/connection-timing.py signing --apk app/build/outputs/apk/bench/app-bench.apk
    tools/bench/connection-timing.py report <out-dir>/runs.jsonl

Scenarios, each run against com.slopus.happy.bench (--package for another):

  cold  force-stop, launch, until home.current (home drawn, connected, its
        snapshot read). Times are since_start (process start).
  chat  force-stop, open --url (a conversation's external happy:// link),
        until chat.current (the chat drawn current). since_start.
  warm  open --url and wait until current, go home (the HOME intent),
        wait --away seconds, bring the task back with the launcher intent,
        until chat.current. Times are since_foreground. A run whose process
        died while away is reported as such, not timed as warm.
  net   with the chat open and current, Wi-Fi off (cellular must be on),
        until chat.current, then Wi-Fi back on. Times are since net.moved.
        Refused over wireless adb, and without --allow-wifi-toggle.

The harness sends no input events: it moves the app with activity intents
only. Before going home, and after each launch, it checks that
`dumpsys window` has the app's window focused, and stops otherwise.
Every run's lines are kept in <out>/runs.jsonl; `report` prints them again.
For each phase it prints the runs that reached it, the median, min and max
of its first time in the run, and how many times it came per run (a phase
seen more than once is a reconnect or a second client). The details of each
phase's first line print under it per run: link.snapshot's bytes, path, wait
(request written to first byte: the computer's work and one round trip),
transfer, kbps, decode and apply. The direct-path watch runs 20 s after the
connect, so pass --tail 22 to see tailcat.main.direct or relay_only.
"""
import argparse
import json
import os
import re
import shlex
import statistics
import subprocess
import sys
import tempfile
import time

ADB = os.environ.get("ADB") or os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
LINE = re.compile(r"^\s*(\d+\.\d+)\s+(\d+)\s+\d+\s+\w\s+HappyTiming\s*:\s*(.*)$")
FIELD = re.compile(r"(\w[\w.]*)=(\S+)")
ACTIVITY = "com.slopus.happy.MainActivity"
SETTLE_SECONDS = 2.0
# What arrives just after the end mark (a file client, the direct path) still belongs to the run; --tail sets it.
TAIL_SECONDS = 3.0
NOT_DETAILS = {"phase", "pid", "t", "since_start", "since_foreground", "dur", "net.moved"}


class Abort(Exception):
    pass


def adb(*args, check=True):
    result = subprocess.run([ADB, *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        raise Abort(f"adb {' '.join(args)} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


def shell(command, check=True):
    return adb("shell", command, check=check)


def device_epoch():
    return shell("date +%s.%N").strip()


def focused(package):
    line = shell("dumpsys window | grep mCurrentFocus", check=False).strip()
    return package in line, line or "no mCurrentFocus line"


def require_focus(package, why, wait=3.0):
    deadline = time.monotonic() + wait
    while True:
        ok, line = focused(package)
        if ok:
            return
        if time.monotonic() >= deadline:
            raise Abort(f"{package} is not focused ({why}): {line}")
        time.sleep(0.25)


def pid_of(package):
    out = shell(f"pidof {package}", check=False).strip()
    return int(out.split()[0]) if out else None


def lines_since(epoch, pid=None):
    out = adb("logcat", "-d", "-v", "epoch", "-T", epoch, "-s", "HappyTiming:I")
    lines = []
    for raw in out.splitlines():
        match = LINE.match(raw)
        if not match:
            continue
        line_pid = int(match.group(2))
        if pid is not None and line_pid != pid:
            continue
        fields = dict(FIELD.findall(match.group(3)))
        if "phase" in fields:
            lines.append({"pid": line_pid, **fields})
    return lines


def from_phase(lines, phase):
    """[lines] from the first [phase] on; none if it never came."""
    first = next((i for i, l in enumerate(lines) if l["phase"] == phase), None)
    return [] if first is None else lines[first:]


def wait_for(epoch, package, end_phase, timeout, start_phase=None):
    """HappyTiming lines from [epoch] (and from [start_phase], if given) until end_phase and a tail."""
    deadline = time.monotonic() + timeout
    ended = None
    lines, pid = [], None
    while time.monotonic() < deadline:
        pid = pid_of(package)
        lines = lines_since(epoch, pid) if pid else []
        if start_phase:
            lines = from_phase(lines, start_phase)
        if ended is None and any(l["phase"] == end_phase for l in lines):
            ended = time.monotonic()
        if ended is not None and time.monotonic() - ended >= TAIL_SECONDS:
            break
        time.sleep(0.5)
    return pid, lines


def start(package, url=None):
    if url:
        out = shell(f"am start -W -a android.intent.action.VIEW -d {shlex.quote(url)} {package}")
    else:
        out = shell(f"am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n {package}/{ACTIVITY}")
    if "Error" in out:
        raise Abort(out.strip())
    match = re.search(r"TotalTime:\s*(\d+)", out)
    return int(match.group(1)) if match else None


def go_home():
    shell("am start -a android.intent.action.MAIN -c android.intent.category.HOME")


def run_cold(args, run):
    shell(f"am force-stop {args.package}")
    time.sleep(SETTLE_SECONDS)
    epoch = device_epoch()
    total = start(args.package)
    require_focus(args.package, "after launch")
    pid, lines = wait_for(epoch, args.package, "home.current", args.timeout)
    return {"anchor": "since_start", "end": "home.current", "am_total": total, "pid": pid, "lines": lines}


def run_chat(args, run):
    shell(f"am force-stop {args.package}")
    time.sleep(SETTLE_SECONDS)
    epoch = device_epoch()
    total = start(args.package, args.url)
    require_focus(args.package, "after opening the chat")
    pid, lines = wait_for(epoch, args.package, "chat.current", args.timeout)
    return {"anchor": "since_start", "end": "chat.current", "am_total": total, "pid": pid, "lines": lines}


def open_current_chat(args):
    """The same start for every run: a fresh process on the chat, current (not timed)."""
    shell(f"am force-stop {args.package}")
    time.sleep(SETTLE_SECONDS)
    epoch = device_epoch()
    start(args.package, args.url)
    require_focus(args.package, "after opening the chat")
    _, lines = wait_for(epoch, args.package, "chat.current", args.timeout)
    if not any(l["phase"] == "chat.current" for l in lines):
        raise Abort("the chat never became current before the scenario began")


def run_warm(args, run):
    open_current_chat(args)
    require_focus(args.package, "before going home")
    before = pid_of(args.package)
    go_home()
    time.sleep(args.away)
    epoch = device_epoch()
    start(args.package)
    require_focus(args.package, "after coming back")
    pid, lines = wait_for(epoch, args.package, "chat.current", args.timeout, start_phase="foreground")
    return {"anchor": "since_foreground", "end": "chat.current", "pid": pid, "away": args.away,
            "process_died": pid != before, "lines": lines}


def wifi(enabled):
    shell(f"cmd wifi set-wifi-enabled {'enabled' if enabled else 'disabled'}")


def run_net(args, run):
    open_current_chat(args)
    require_focus(args.package, "before Wi-Fi goes off")
    epoch = device_epoch()
    wifi(False)
    try:
        pid, lines = wait_for(epoch, args.package, "chat.current", args.timeout, start_phase="net.moved")
    finally:
        wifi(True)
    time.sleep(args.settle_after_net)
    if not lines:
        return {"anchor": "net.moved", "end": "chat.current", "pid": pid, "lines": [], "error": "no net.moved (is cellular data on?)"}
    t0 = int(lines[0]["t"])
    for l in lines:
        l["net.moved"] = str(int(l["t"]) - t0)
    return {"anchor": "net.moved", "end": "chat.current", "pid": pid, "lines": lines}


def summarize(runs, out=sys.stdout):
    by_scenario = {}
    for r in runs:
        by_scenario.setdefault(r["scenario"], []).append(r)
    for scenario, rs in by_scenario.items():
        anchor = rs[0]["anchor"]
        valid = [r for r in rs if not r.get("process_died") and not r.get("error")]
        reached = sum(1 for r in valid if any(l["phase"] == r["end"] for l in r["lines"]))
        print(f"\n== {scenario}: {len(rs)} runs, {len(valid)} valid, {reached} reached {rs[0]['end']}; ms {anchor}", file=out)
        for r in rs:
            if r.get("process_died"):
                print(f"   run {r['run']}: process died while away (cold, not warm)", file=out)
            if r.get("error"):
                print(f"   run {r['run']}: {r['error']}", file=out)
        firsts, counts, durs, details = {}, {}, {}, {}
        for r in valid:
            seen = {}
            for l in r["lines"]:
                seen.setdefault(l["phase"], []).append(l)
            for phase, ls in seen.items():
                first = ls[0]
                firsts.setdefault(phase, []).append(int(first[anchor]))
                counts.setdefault(phase, []).append(len(ls))
                if "dur" in first:
                    durs.setdefault(phase, []).append(int(first["dur"]))
                for key, value in first.items():
                    if key not in NOT_DETAILS:
                        details.setdefault(phase, {}).setdefault(key, []).append(value)
        totals = [r["am_total"] for r in valid if r.get("am_total") is not None]
        if totals:
            firsts["am_start.TotalTime"] = totals
            counts["am_start.TotalTime"] = [1] * len(totals)
        print(f"   {'phase':34} {'runs':>4} {'median':>7} {'min':>7} {'max':>7} {'dur_med':>7} {'per_run':>7}", file=out)
        for phase in sorted(firsts, key=lambda p: statistics.median(firsts[p])):
            values = firsts[phase]
            dur = f"{statistics.median(durs[phase]):7.0f}" if phase in durs else f"{'':7}"
            print(f"   {phase:34} {len(values):4} {statistics.median(values):7.0f} {min(values):7} {max(values):7} {dur} {statistics.median(counts[phase]):7.1f}", file=out)
            for key, found in details.get(phase, {}).items():
                numbers = [int(v) for v in found if re.fullmatch(r"-?\d+", v)]
                if len(numbers) == len(found):
                    print(f"     .{key:32} {len(numbers):4} {statistics.median(numbers):7.0f} {min(numbers):7} {max(numbers):7}   runs: {' '.join(found)}", file=out)
                else:
                    print(f"     .{key:32} {len(found):4}   {' '.join(found)}", file=out)


def signing(args):
    apksigner = sorted(os.listdir(os.path.expanduser("~/Library/Android/sdk/build-tools")))[-1]
    apksigner = os.path.expanduser(f"~/Library/Android/sdk/build-tools/{apksigner}/apksigner")

    def digest(path):
        out = subprocess.run([apksigner, "verify", "--print-certs", path], capture_output=True, text=True).stdout
        match = re.search(r"certificate SHA-256 digest: (\w+)", out)
        return match.group(1) if match else None

    remote = shell(f"pm path {args.package}").strip().splitlines()
    base = next((l.removeprefix("package:") for l in remote if l.endswith("base.apk")), None)
    if base is None:
        raise Abort(f"{args.package} is not installed")
    with tempfile.TemporaryDirectory() as tmp:
        pulled = os.path.join(tmp, "installed.apk")
        adb("pull", base, pulled)
        installed = digest(pulled)
    built = digest(args.apk)
    print(f"installed {installed}\nbuilt     {built}")
    print("same key: adb install -r keeps the sign-in" if installed and installed == built else "DIFFERENT key: install -r would fail; do not uninstall without asking")


def main():
    global TAIL_SECONDS
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scenario", choices=["cold", "chat", "warm", "net", "signing", "report"])
    parser.add_argument("path", nargs="?", help="report: a runs.jsonl")
    parser.add_argument("-n", type=int, default=5)
    parser.add_argument("--package", default="com.slopus.happy.bench")
    parser.add_argument("--url", help="a conversation's external link, happy://<instanceId>/agents/<agentId>")
    parser.add_argument("--away", type=float, default=60, help="warm: seconds in the background")
    parser.add_argument("--timeout", type=float, default=60, help="seconds a run may take to reach its end mark")
    parser.add_argument("--tail", type=float, default=TAIL_SECONDS, help="seconds to keep reading after the end mark; 22 sees tailcat.main.direct or relay_only (20 s watch)")
    parser.add_argument("--pause", type=float, default=3, help="seconds between runs")
    parser.add_argument("--settle-after-net", type=float, default=10, help="net: seconds on Wi-Fi again before the next run")
    parser.add_argument("--allow-wifi-toggle", action="store_true")
    parser.add_argument("--apk", help="signing: the APK about to be installed")
    parser.add_argument("--out", default=os.path.join(".context", "connection-timing", time.strftime("%Y%m%d-%H%M%S")))
    args = parser.parse_args()
    TAIL_SECONDS = args.tail

    if args.scenario == "report":
        with open(args.path) as f:
            summarize([json.loads(l) for l in f if l.strip()])
        return
    try:
        if args.scenario == "signing":
            if not args.apk:
                raise Abort("signing needs --apk")
            signing(args)
            return
        if args.scenario in ("chat", "warm", "net") and not args.url:
            raise Abort(f"{args.scenario} needs --url")
        if args.scenario == "net":
            if not args.allow_wifi_toggle:
                raise Abort("net turns the phone's Wi-Fi off and on: pass --allow-wifi-toggle")
            serial = adb("get-serialno").strip()
            if ":" in serial or "adb-tls" in serial:
                raise Abort(f"adb is over the network ({serial}); turning Wi-Fi off would cut it")
        if pid_of(args.package) is None and args.scenario in ("warm", "net"):
            print("note: the app is not running; the first open is a cold start (not timed)", file=sys.stderr)
        os.makedirs(args.out, exist_ok=True)
        path = os.path.join(args.out, "runs.jsonl")
        scenario = {"cold": run_cold, "chat": run_chat, "warm": run_warm, "net": run_net}[args.scenario]
        runs = []
        for i in range(1, args.n + 1):
            result = scenario(args, i)
            result.update(scenario=args.scenario if args.scenario != "warm" else f"warm-{args.away:g}s", run=i)
            runs.append(result)
            with open(path, "a") as f:
                f.write(json.dumps(result) + "\n")
            end = next((int(l[result["anchor"]]) for l in result["lines"] if l["phase"] == result["end"] and int(l[result["anchor"]]) >= 0), None)
            print(f"run {i}/{args.n}: {result['end']} at {end} ms {result['anchor']}" + (" (process died)" if result.get("process_died") else ""), file=sys.stderr)
            time.sleep(args.pause)
        summarize(runs)
        print(f"\nlines: {path}")
    except Abort as e:
        print(f"stopped: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
