"""Compose the store tour (search results video, 2880x1920, 30 fps, no audio) on Kirill's Mac.

Inputs in ~/happy-store-v8/tour: tour-raw.mp4 (the simulator take), bgloop.mp4 (the hero shader,
1920x1280, a 17.5 s loop), desktop.mp4 (the landing page's desktop recording), layers/*.png (3840x2560
transparent: phone frame, five captions; desktop mask and shadow at output size).
Usage: python3 compose-search.py RAW OUT
"""
import subprocess, sys
from pathlib import Path

raw, out = sys.argv[1], sys.argv[2]
L = Path(__file__).parent / 'layers2'
FF = str(Path.home() / 'happy-render/task241-ad2-r4/bin/ffmpeg')

# (caption, raw start, raw end, speed): the take's cuts, each at a still moment.
CUTS = [
    (0, 0.5, 4.5, 1.0),     # the team's Home at work; two subtasks start
    (1, 6.0, 8.4, 1.0),     # the server menu: your computer and the team
    (1, 10.3, 10.9, 1.0),   # dismissed
    (2, 12.9, 16.8, 1.0),   # Activity opens and is read
    (2, 20.2, 20.9, 1.0),   # back
    (3, 23.3, 24.3, 1.0),   # Product Health's chat
    (3, 26.8, 28.3, 1.0),   # model picker
    (3, 30.1, 31.6, 1.0),   # Codex accounts
    (3, 32.5, 33.6, 1.0),   # personal account; GPT-6.1 Terra
    (3, 35.6, 36.2, 1.0),   # the picker closes
    (3, 37.2, 38.9, 1.0),   # the question
    (3, 39.0, 43.9, 1.4),   # the answer and its chart
    (4, 44.1, 48.3, 1.4),   # a call over the chat
]
PLATFORMS = 3.8             # the desktop's turn, after the phone leaves
DESKTOP_FROM = 32.0
FPS = 30

lengths = [(b - a) / s for _, a, b, s in CUTS]
phone_end = sum(lengths)
total = phone_end + PLATFORMS
starts, t = [], 0.0
for n in lengths:
    starts.append(t); t += n
# Each caption's span in output time.
spans = {}
for (c, *_), s0, n in zip(CUTS, starts, lengths):
    a, b = spans.get(c, (s0, s0 + n)); spans[c] = (min(a, s0), max(b, s0 + n))
spans[5] = (phone_end, total)

W, H = 2880, 1920
f = []
# The screen: cuts, each at its speed, as one 30 fps track; then held on its last frame.
# The simulator records only when the screen changes: make it 30 fps first, so every cut is its full length.
f.append(f'[0:v]fps={FPS},split={len(CUTS)}' + ''.join(f'[r{i}]' for i in range(len(CUTS))))
for i, (_, a, b, s) in enumerate(CUTS):
    f.append(f'[r{i}]trim={a}:{b},setpts=(PTS-STARTPTS)/{s},fps={FPS},scale=738:1606:flags=lanczos,format=rgba[s{i}]')
f.append(''.join(f'[s{i}]' for i in range(len(CUTS))) + f'concat=n={len(CUTS)}:v=1,tpad=stop_mode=clone:stop_duration={PLATFORMS + 1}[scr0]')
f.append(f'[3:v]scale=738:1606,format=gray[m];[scr0][m]alphamerge[scr]')
# The phone: its screen under its frame, on a clear canvas, so the two move as one.
f.append(f'color=c=black@0:s={W}x{H}:r={FPS},format=rgba[clear]')
f.append(f'[clear][scr]overlay=287:157:shortest=1[ph0]')
f.append(f'[2:v]scale={W}:{H}[frame];[ph0][frame]overlay=0:0[phone]')
# The background: the hero shader's loop, twice.
f.append(f'[1:v]loop=loop=-1:size=525,trim=0:{total},setpts=PTS-STARTPTS,scale={W}:{H}:flags=lanczos,format=rgba[bg]')
leave = phone_end
# The ending: the phone eases a quarter of its width off to the left and stays, peeking; the
# desktop slides in from the right, as tall as the phone, running off the edge.
ease = f"(pow(clip((t-{leave})/0.9,0,1),2)*(3-2*clip((t-{leave})/0.9,0,1)))"
f.append(f"[bg][phone]overlay=x='-560*{ease}':y=0:shortest=1[v0]")
DX = 1250
slide = f"{W - DX}*(1-{ease})"
f.append(f'[4:v]trim={DESKTOP_FROM}:{DESKTOP_FROM + PLATFORMS + 1},setpts=PTS-STARTPTS+{leave}/TB,fps={FPS},scale=2797:1728:flags=lanczos,format=rgba[d0]')
f.append(f'[5:v]format=gray[dm];[d0][dm]alphamerge[desk]')
f.append(f"[v0][6:v]overlay=x='{DX - 100}+{slide}':y=36:enable='gte(t,{leave})'[v1]")
f.append(f"[v1][desk]overlay=x='{DX}+{slide}':y=96:eof_action=pass[v2]")
# Captions: each fades in and out over 0.35 s around its span.
prev = 'v2'
for c in range(6):
    a, b = spans[c]
    # The last caption waits for the phone to make room.
    fade_in = '' if c == 0 else f',fade=t=in:st={a + 0.5}:d=0.4:alpha=1' if c == 5 else f',fade=t=in:st={a}:d=0.35:alpha=1'
    fade_out = '' if c == 5 else f',fade=t=out:st={b - 0.35}:d=0.35:alpha=1'
    f.append(f'[{7 + c}:v]scale={W}:{H},format=rgba{fade_in}{fade_out}[c{c}]')
    f.append(f"[{prev}][c{c}]overlay=0:0:enable='between(t,{max(0, a - 0.4)},{b + 0.4})'[w{c}]")
    prev = f'w{c}'
f.append(f'[{prev}]format=yuv420p[out]')

inputs = ['-i', raw, '-i', 'bgloop.mp4', '-loop', '1', '-i', str(L / 'phone.png'), '-loop', '1', '-i', str(L / 'mask.png'),
          '-i', 'desktop.mp4', '-loop', '1', '-i', str(L / 'dmask.png'), '-loop', '1', '-i', str(L / 'dshadow.png')]
for c in range(6):
    inputs += ['-loop', '1', '-i', str(L / f'copy{c}.png')]
cmd = [FF, '-v', 'error', '-y', *inputs, '-filter_complex', ';'.join(f), '-map', '[out]', '-t', f'{total:.3f}', '-r', str(FPS), '-an',
       '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-level', '5.1', '-b:v', '20M', '-maxrate', '25M', '-bufsize', '40M',
       '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-brand', 'mp42', '-movflags', '+faststart', out]
print(f'total {total:.2f}s phone {phone_end:.2f}s spans', {k: (round(a, 2), round(b, 2)) for k, (a, b) in spans.items()}, flush=True)
subprocess.run(cmd, check=True, cwd=Path(__file__).parent)
