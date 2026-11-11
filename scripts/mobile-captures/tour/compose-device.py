"""Compose the six-beat tour for a device-on-top store format (portrait iPhone preview, iPad
preview) on Kirill's Mac. Same cut, captions and ending as compose-search.py (the 3:2 search video);
only the canvas, the layers and the device change.

Layers come from vlayers.sh (renderer/formats.html at output size): copy0..5, under (device
with a white screen and its shadow), frame, mask (screen, white on black), desk (the desktop
with its shadow), dmask, rects.json.
Usage: python3 compose-device.py RAW LAYERDIR OUT [--audio]
"""
import json, subprocess, sys
from pathlib import Path
from struct import unpack

raw, L, out = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
audio = '--audio' in sys.argv
FF = str(Path.home() / 'happy-render/task241-ad2-r4/bin/ffmpeg')
FPS = 30
here = Path(__file__).parent

# The search video's cuts on the iPhone take (takes/iphone-capture.json), (caption, start, end, speed).
CUTS = [
    (0, 0.5, 4.5, 1.0), (1, 6.0, 8.4, 1.0), (1, 10.3, 10.9, 1.0), (2, 12.9, 16.8, 1.0), (2, 20.2, 20.9, 1.0),
    (3, 23.3, 24.3, 1.0), (3, 26.8, 28.3, 1.0), (3, 30.1, 31.6, 1.0), (3, 32.5, 33.6, 1.0), (3, 35.6, 36.2, 1.0),
    (3, 37.2, 38.9, 1.0), (3, 39.0, 43.9, 1.4), (4, 44.1, 48.3, 1.4),
]
REF = here / 'takes' / 'iphone-capture.json'
# Another take (the iPad's) moves each cut with the beat it starts in, so the same moments are cut.
ref_beats = json.loads(REF.read_text())['beats']
take = Path(raw).parent / 'capture.json'
beats = json.loads(take.read_text())['beats'] if take.exists() else ref_beats
at = {b['beat']: b['at'] for b in beats}
def moved(t):
    anchor = max((b for b in ref_beats if b['at'] <= t + 0.05), key=lambda b: b['at'])
    return round(at[anchor['beat']] - anchor['at'], 2)
CUTS = [(c, a + moved(a), b + moved(a), s) for c, a, b, s in CUTS]
PLATFORMS = 3.8
DESKTOP_FROM = 32.0

r = json.loads((L / 'rects.json').read_text())
S, D, K = r['screen'], r['device'], r['desk']
with open(L / 'mask.png', 'rb') as fh:
    fh.read(16); W, H = unpack('>II', fh.read(8))
W -= W % 2; H -= H % 2

lengths = [(b - a) / s for _, a, b, s in CUTS]
phone_end = sum(lengths)
total = phone_end + PLATFORMS
starts, t = [], 0.0
for n in lengths:
    starts.append(t); t += n
spans = {}
for (c, *_), s0, n in zip(CUTS, starts, lengths):
    a, b = spans.get(c, (s0, s0 + n)); spans[c] = (min(a, s0), max(b, s0 + n))
spans[5] = (phone_end, total)

f = []
f.append(f'[0:v]fps={FPS},split={len(CUTS)}' + ''.join(f'[r{i}]' for i in range(len(CUTS))))
for i, (_, a, b, s) in enumerate(CUTS):
    f.append(f'[r{i}]trim={a}:{b},setpts=(PTS-STARTPTS)/{s},fps={FPS},scale={S["w"]}:{S["h"]}:flags=lanczos,format=rgba[s{i}]')
f.append(''.join(f'[s{i}]' for i in range(len(CUTS))) + f'concat=n={len(CUTS)}:v=1,tpad=stop_mode=clone:stop_duration={PLATFORMS + 1}[scr0]')
# The device as one moving group: shadow and white screen, the masked screen, the frame.
f.append(f'[3:v]crop={S["w"]}:{S["h"]}:{S["x"]}:{S["y"]},format=gray[m];[scr0][m]alphamerge[scr]')
f.append(f'[2:v]format=rgba[under];[under][scr]overlay={S["x"]}:{S["y"]}:shortest=1[ph0]')
f.append(f'[4:v]format=rgba[frame];[ph0][frame]overlay=0:0[phone]')
# The hero shader loop (1920x1280), cropped to this aspect.
cw = min(1920, round(1280 * W / H)); ch = min(1280, round(1920 * H / W))
f.append(f'[1:v]loop=loop=-1:size=525,trim=0:{total},setpts=PTS-STARTPTS,crop={cw}:{ch},scale={W}:{H}:flags=lanczos,format=rgba[bg]')
leave = phone_end
ease = f"(pow(clip((t-{leave})/0.9,0,1),2)*(3-2*clip((t-{leave})/0.9,0,1)))"
# Ending: the device eases left until its right edge is at half the width and stays, peeking;
# the desktop slides in from the right edge to 40%, over its right part.
shift = round(0.50 * W - (D['x'] + D['w']))
f.append(f"[bg][phone]overlay=x='{shift}*{ease}':y=0:shortest=1[v0]")
f.append(f'[5:v]format=rgba[deskl]')
f.append(f'[6:v]trim={DESKTOP_FROM}:{DESKTOP_FROM + PLATFORMS + 1},setpts=PTS-STARTPTS,fps={FPS},scale={K["w"]}:{K["h"]}:flags=lanczos,format=rgba[d0]')
f.append(f'[7:v]crop={min(K["w"], W - K["x"])}:{K["h"]}:{K["x"]}:{K["y"]},format=gray,pad={K["w"]}:{K["h"]}[dm];[d0][dm]alphamerge[dv]')
f.append(f'[deskl][dv]overlay={K["x"]}:{K["y"]}:shortest=1,setpts=PTS+{leave}/TB[desk]')
final_x = round(0.40 * W)
f.append(f"[v0][desk]overlay=x='{final_x - K['x']}+{W - final_x}*(1-{ease})':y=0:eof_action=pass:enable='gte(t,{leave})'[v2]")
prev = 'v2'
for c in range(6):
    a, b = spans[c]
    fade_in = '' if c == 0 else f',fade=t=in:st={a + 0.5}:d=0.4:alpha=1' if c == 5 else f',fade=t=in:st={a}:d=0.35:alpha=1'
    fade_out = '' if c == 5 else f',fade=t=out:st={b - 0.35}:d=0.35:alpha=1'
    f.append(f'[{8 + c}:v]format=rgba{fade_in}{fade_out}[c{c}]')
    f.append(f"[{prev}][c{c}]overlay=0:0:enable='between(t,{max(0, a - 0.4)},{b + 0.4})'[w{c}]")
    prev = f'w{c}'
f.append(f'[{prev}]crop={W}:{H}:0:0,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[out]')

# Order: 0 raw, 1 bg, 2 under, 3 mask, 4 frame, 5 desk, 6 desktop.mp4, 7 dmask, 8.. copy
inputs = ['-i', raw, '-i', str(here / 'bgloop.mp4'), '-loop', '1', '-i', str(L / 'under.png'), '-loop', '1', '-i', str(L / 'mask.png'),
          '-loop', '1', '-i', str(L / 'frame.png'), '-loop', '1', '-i', str(L / 'desk.png'), '-i', str(here / 'desktop.mp4'),
          '-loop', '1', '-i', str(L / 'dmask.png')]
for c in range(6):
    inputs += ['-loop', '1', '-i', str(L / f'copy{c}.png')]
amap = []
if audio:
    # As on the accepted preview a9000019: a stereo AAC track with a pink-noise floor near -88 dBFS.
    inputs += ['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.00004:sample_rate=48000,aformat=channel_layouts=stereo']
    amap = ['-map', f'{8 + 6}:a', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2']
cmd = [FF, '-v', 'error', '-y', *inputs, '-filter_complex', ';'.join(f), '-map', '[out]', *amap, '-t', f'{total:.3f}', '-r', str(FPS),
       *([] if audio else ['-an']),
       '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-level', '4.0' if W * H <= 2_100_000 else '5.1',
       '-b:v', '11M', '-minrate', '11M', '-maxrate', '11M', '-bufsize', '22M', '-x264-params', 'nal-hrd=cbr',
       '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-brand', 'mp42', '-movflags', '+faststart', out]
print(f'{W}x{H} total {total:.2f}s phone {phone_end:.2f}s cuts', [(c, round(a, 2), round(b, 2)) for c, a, b, _ in CUTS], flush=True)
print('spans', {k: (round(a, 2), round(b, 2)) for k, (a, b) in spans.items()}, flush=True)
subprocess.run(cmd, check=True, cwd=here)
