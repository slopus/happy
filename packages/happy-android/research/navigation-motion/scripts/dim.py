"""Robust dim of the page beneath: median brightness ratio over bright text pixels.
usage: dim.py video.mp4 push|pop track.csv"""
from load import frames
import numpy as np, sys, csv

path, mode, tr = sys.argv[1], sys.argv[2], sys.argv[3]
L = 383
t, a = frames(path)
under_ref = a[0] if mode == 'push' else a[-1]
rows = list(csv.DictReader(open(tr)))
for i, r in enumerate(rows):
    if not r['under']:
        continue
    top = int(r['top']) // 2
    s = -int(r['under']) // 2
    vis = top - 30
    if vis < 20:
        continue
    x = a[i][120:1040, L:L + vis]
    ref = under_ref[120:1040, L + s:L + s + vis]
    m = ref > 120
    if m.sum() < 50:
        continue
    ratio = np.median(x[m] / ref[m])
    print('%s top=%5s under=%5s dim=%.3f n=%d' % (r['t'], r['top'], r['under'], ratio, m.sum()))
