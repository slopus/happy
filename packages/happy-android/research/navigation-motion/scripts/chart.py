"""SVG: progress vs time for Settings and ours, against the spec curve."""
import csv, sys
from fit import bez
import numpy as np

out = sys.argv[1]


def series(path, mode, width, t0, bad_top=None):
    pts = []
    for r in csv.DictReader(open(path)):
        t = float(r['t']) - t0
        top = float(r['top'])
        if t < -0.02 or t > 0.6:
            continue
        if bad_top and top >= bad_top and float(r['top_err']) < 0.05:
            top = width if mode == 'push' else 0
        p = 1 - top / width if mode == 'push' else top / width
        if t < 0 or float(r['top_err']) > 8:
            continue
        if pts and p < pts[-1][1] - 0.2:
            break
        pts.append((t * 1000, min(max(p, 0), 1)))
        if p >= 0.985:
            break
    return pts


S = [
    ('Settings push', series('push.csv', 'push', 1202, 0.8415), '#7aa2ff', 'circle'),
    ('Settings pop (toolbar)', series('toolbar.csv', 'pop', 1202, 1.1473), '#7aa2ff', 'square'),
    ('Happy push', series('b_push_settings.csv', 'push', 1968, 1.1263, 1800), '#ffb35c', 'circle'),
    ('Happy pop (toolbar)', series('b_toolbar.csv', 'pop', 1968, 1.1523, 1800), '#ffb35c', 'square'),
    ('Happy push, same curve, clock not held to the first frame', series('a_push_settings.csv', 'push', 1968, 1.2003, 1800), '#ff5c7a', 'circle'),
    ('Happy pop (toolbar), same curve, clock not held to the first frame', series('a_toolbar.csv', 'pop', 1968, 1.7393, 1800), '#ff5c7a', 'square'),
]
W, H, L, T = 760, 420, 60, 20
PW, PH = 660, 340


def X(ms): return L + ms / 600 * PW


def Y(p): return T + (1 - p) * PH


o = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" font-family="Helvetica" font-size="12">' % (W, H + 90),
     '<rect width="100%" height="100%" fill="#16161a"/>']
for ms in range(0, 601, 100):
    o.append('<line x1="%.1f" y1="%d" x2="%.1f" y2="%d" stroke="#333"/>' % (X(ms), T, X(ms), T + PH))
    o.append('<text x="%.1f" y="%d" fill="#aaa" text-anchor="middle">%d ms</text>' % (X(ms), T + PH + 16, ms))
for p in (0, 0.25, 0.5, 0.75, 1):
    o.append('<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="#333"/>' % (L, Y(p), L + PW, Y(p)))
    o.append('<text x="%d" y="%.1f" fill="#aaa" text-anchor="end">%d%%</text>' % (L - 6, Y(p) + 4, p * 100))
ts = np.linspace(0, 1, 200)
ys = bez(ts, 0.22, 0.4, 0.0, 1.0)
o.append('<polyline fill="none" stroke="#e6e6e6" stroke-width="2" points="%s"/>' % ' '.join('%.1f,%.1f' % (X(t * 450), Y(y)) for t, y in zip(ts, ys)))
o.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#e6e6e6" stroke-width="2"/>' % (X(450), Y(1), X(600), Y(1)))
for name, pts, color, shape in S:
    for t, p in pts:
        if shape == 'circle':
            o.append('<circle cx="%.1f" cy="%.1f" r="3" fill="%s"/>' % (X(t), Y(p), color))
        else:
            o.append('<rect x="%.1f" y="%.1f" width="5" height="5" fill="none" stroke="%s"/>' % (X(t) - 2.5, Y(p) - 2.5, color))
legend = [('NavMotion: 450 ms, cubic-bezier(0.22, 0.4, 0, 1)', '#e6e6e6', 'line')] + [(n, c, s) for n, _, c, s in S]
for i, (name, color, shape) in enumerate(legend):
    y = T + PH + 36 + i * 15
    if shape == 'line':
        o.append('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s" stroke-width="2"/>' % (L, y - 4, L + 16, y - 4, color))
    elif shape == 'circle':
        o.append('<circle cx="%d" cy="%d" r="3" fill="%s"/>' % (L + 8, y - 4, color))
    else:
        o.append('<rect x="%d" y="%d" width="5" height="5" fill="none" stroke="%s"/>' % (L + 5, y - 7, color))
    o.append('<text x="%d" y="%d" fill="#ddd">%s</text>' % (L + 24, y, name))
o.append('<text x="%d" y="%d" fill="#aaa" transform="rotate(-90 14 %d)" text-anchor="middle">progress across the pane</text>' % (14, T + PH // 2, T + PH // 2))
o.append('</svg>')
open(out, 'w').write('\n'.join(o))
