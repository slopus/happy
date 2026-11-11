"""The store tour recording on the iPhone 17 Pro Max simulator.

Runs on Kirill's Mac inside ~/happy-store-v8 (the cap11 source snapshot and neutral fixture).
Usage: python3 tour/run-tour.py install | record [ipad]
"""
from pathlib import Path
import json, os, re, shutil, signal, subprocess, sys, time

ROOT = Path.home() / 'happy-store-v8'
IOS = ROOT / 'src/packages/happy-ios'
DERIVED = Path.home() / 'happy-native-screenshots-vq03/.context/ios-derived'
IPHONE = '786D96D0-112E-4374-BC42-6DBE2F0877B8'
IPAD = '248EFD51-34B8-42A3-97E6-ED4E245BCA76'
RUNNER = 'com.slopus.happy.chat-ui-tests.xctrunner'
os.environ['PATH'] = '/opt/homebrew/bin:' + os.environ['PATH']


def sh(*cmd, **kw):
    return subprocess.run(list(cmd), check=True, **kw)


def install():
    harness = IOS / 'Harness/StoryHarness.swift'
    backup = ROOT / 'drivers/StoryHarness.swift.pre-tour'
    if not backup.exists():
        shutil.copy(harness, backup)
    shutil.copy(ROOT / 'tour/StoryHarness.swift', harness)
    shutil.copy(ROOT / 'tour/StoryTour.swift', IOS / 'Harness/StoryTour.swift')
    shutil.copy(ROOT / 'tour/StoryTourUITests.swift', IOS / 'Tests/HappyChatUITests/StoryTourUITests.swift')
    with open(ROOT / 'tour/xcodegen.log', 'w') as log:
        sh('xcodegen', 'generate', cwd=IOS, stdout=log, stderr=subprocess.STDOUT)
    print('installed tour')


def record(target='iphone'):
    global IPHONE
    env = dict(os.environ)
    if target == 'ipad':
        IPHONE = IPAD
        env.update(TEST_RUNNER_STORY_IPAD='1')
    out = ROOT / f'results-tour-{target}-{time.strftime("%H%M%S")}'
    out.mkdir()
    rec = {'target': f'{target}-tour', 'simulator': IPHONE, 'started': time.time(),
           'sourceCommit': (ROOT / 'src/SOURCE_COMMIT').read_text().strip()}
    subprocess.run(['xcrun', 'simctl', 'boot', IPHONE]); sh('xcrun', 'simctl', 'bootstatus', IPHONE)
    sh('xcrun', 'simctl', 'ui', IPHONE, 'appearance', 'light')
    sh('xcrun', 'simctl', 'status_bar', IPHONE, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active',
       '--wifiBars', '3', '--cellularMode', 'active', '--cellularBars', '4', '--operatorName', '',
       '--batteryState', 'charged', '--batteryLevel', '100')
    subprocess.run(['xcrun', 'simctl', 'uninstall', IPHONE, RUNNER])
    result = out / 'tour.xcresult'
    cmd = ['xcodebuild', '-project', 'Happy.xcodeproj', '-scheme', 'HappyChatUI', '-configuration', 'Debug',
           '-destination', f'platform=iOS Simulator,id={IPHONE}', '-derivedDataPath', str(DERIVED),
           'CODE_SIGNING_ALLOWED=NO', 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES', '-parallel-testing-enabled', 'NO',
           '-only-testing:HappyChatUITests/StoryTourUITests/testTour', '-resultBundlePath', str(result), 'test']
    proc = subprocess.Popen(cmd, cwd=IOS, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    recorder, beats = None, []
    with open(out / 'xcodebuild.log', 'w') as log:
        for line in proc.stdout:
            log.write(line); log.flush()
            if line.startswith('STORY_VIDEO_BEGIN') and recorder is None:
                rec['begin'] = time.time()
                recorder = subprocess.Popen(['xcrun', 'simctl', 'io', IPHONE, 'recordVideo', '--codec=h264', '--force', str(out / 'tour-raw.mp4')],
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            m = re.match(r'^TOUR_BEAT (\S+)', line)
            if m and 'begin' in rec:
                beats.append({'beat': m[1], 'at': round(time.time() - rec['begin'], 2)})
            if line.startswith('STORY_VIDEO_END') and recorder:
                recorder.send_signal(signal.SIGINT); recorder.wait(timeout=30); recorder = None; rec['end'] = time.time()
    rec['testExitCode'] = proc.wait()
    if recorder:
        recorder.send_signal(signal.SIGINT); recorder.wait(timeout=30)
    (out / 'png').mkdir(exist_ok=True)
    subprocess.run(['xcrun', 'xcresulttool', 'export', 'attachments', '--path', str(result), '--output-path', str(out / 'png')])
    rec.update(beats=beats, finished=time.time(), command=cmd)
    (out / 'capture.json').write_text(json.dumps(rec, indent=2))
    subprocess.run(['xcrun', 'simctl', 'shutdown', IPHONE])
    print('tour exit', rec['testExitCode'], 'out', out, 'beats', beats)


if __name__ == '__main__':
    {'install': install, 'record': record}[sys.argv[1]](*sys.argv[2:])
