"""Brightness ratio of the incoming (top) page vs. its final frame, over its visible part."""
from load import frames
import numpy as np, csv
L = 383
t, a = frames('../nav_push.mp4')
rows = list(csv.DictReader(open('push.csv')))
for i, r in enumerate(rows):
    dx = int(r['top']) // 2
    if dx <= 0 or dx > 560:
        continue
    vis = 984 - L - dx - 4
    x = a[i][120:1040, L + dx + 4:L + dx + 4 + vis]
    ref = a[-1][120:1040, L + 4:L + 4 + vis]
    m = ref > 120
    print('%s top=%4s alpha~%.3f' % (r['t'], r['top'], np.median(x[m] / ref[m])))
