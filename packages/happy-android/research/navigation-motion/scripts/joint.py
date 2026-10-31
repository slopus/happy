"""One cubic-bezier at 450 ms for push (push, push2) and pop (toolbar, key_back); parallax amplitude."""
import numpy as np, csv
from fit import bez, nm

import os
W = float(os.environ.get("PW", 1202))
D = 0.45
sets = []
for name, mode in (('push', 'push'), ('push2', 'push'), ('toolbar', 'pop'), ('key_back', 'pop')):
    rows = list(csv.DictReader(open(name + '.csv')))
    T = np.array([float(r['t']) for r in rows]); X = np.array([float(r['top']) for r in rows])
    if mode == 'push':
        P = 1 - X / W; keep = X > 0
    else:
        P = X / W; keep = (X > 0) & (X < 1140)
    sets.append((name, T[keep], P[keep]))
    # parallax amplitude: under = -A * e, with e = 1 - top/W (push) or e = 1 - top/W (pop: beneath returns)
    A = [(-float(r['under'])) / (1 - float(r['top']) / W) for r in rows if r['under'] and 0.15 < 1 - float(r['top']) / W < 0.95]
    print(name, 'parallax amplitude px median=%.0f n=%d' % (np.median(A), len(A)))


def err(p):
    x1, y1, x2, y2 = p[:4]
    if not (0 <= x1 <= 1 and 0 <= x2 <= 1):
        return 1e9
    tot = 0
    for i, (n, T, P) in enumerate(sets):
        ts = p[4 + i]
        tot += ((bez(np.clip((T - ts) / D, 0, 1), x1, y1, x2, y2) - P) ** 2).mean()
    return tot / len(sets)


x0 = [0.22, 0.4, 0.0, 1.0] + [T.min() - 0.01 for _, T, _ in sets]
p, v = nm(err, x0, [0.1] * 4 + [0.01] * len(sets), 6000)
print('joint bezier (%.3f, %.3f, %.3f, %.3f) rms=%.4f' % (p[0], p[1], p[2], p[3], v ** 0.5))
for c in ((0.22, 0.4, 0.0, 1.0), (0.2, 0.4, 0.0, 1.0), (0.22, 0.25, 0.0, 1.0)):
    best = 9
    q = list(c) + list(p[4:])
    print('  candidate', c, 'rms=%.4f' % err(q) ** 0.5)
