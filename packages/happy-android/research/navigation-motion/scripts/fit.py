"""Fits a cubic-bezier + start time + duration to tracked offsets.
usage: fit.py track.csv push|pop [field=top|under] [fixed_duration_ms]"""
import numpy as np, sys, csv

path, mode = sys.argv[1], sys.argv[2]
field = sys.argv[3] if len(sys.argv) > 3 else 'top'
fixedD = float(sys.argv[4]) / 1000 if len(sys.argv) > 4 else None
import os
W = float(os.environ.get("PW", 1202))
rows = [r for r in csv.DictReader(open(path)) if r[field] != '']
T = np.array([float(r['t']) for r in rows])
X = np.array([float(r[field]) for r in rows])
if field == 'top':
    P = 1 - X / W if mode == 'push' else X / W
    keep = (X > 0) & (X < 1140) if mode == 'pop' else (X > 0) | (T == T.max())
else:
    U = float(sys.argv[5]) if len(sys.argv) > 5 else 300.0
    P = -X / U if mode == 'push' else 1 + X / U
    keep = X != 0
T, P = T[keep], P[keep]


def bez(t, x1, y1, x2, y2):
    # solve x(s) = t by bisection-ish Newton
    s = t.copy()
    for _ in range(30):
        x = 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s ** 2 * x2 + s ** 3
        dx = 3 * (1 - s) ** 2 * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s ** 2 * (1 - x2)
        s = np.clip(s - (x - t) / np.where(np.abs(dx) < 1e-6, 1e-6, dx), 0, 1)
    return 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s ** 2 * y2 + s ** 3


def model(p):
    ts, D, x1, y1, x2, y2 = p
    if fixedD:
        D = fixedD
    u = np.clip((T - ts) / D, 0, 1)
    return bez(u, x1, y1, x2, y2)


def err(p):
    ts, D, x1, y1, x2, y2 = p
    if not (0 <= x1 <= 1 and 0 <= x2 <= 1) or D < 0.1:
        return 1e9
    return float(((model(p) - P) ** 2).mean())


def nm(f, x0, steps, iters=4000):
    n = len(x0)
    pts = [np.array(x0, float)] + [np.array(x0, float) + np.eye(n)[i] * steps[i] for i in range(n)]
    vals = [f(p) for p in pts]
    for _ in range(iters):
        order = np.argsort(vals)
        pts = [pts[i] for i in order]
        vals = [vals[i] for i in order]
        c = np.mean(pts[:-1], axis=0)
        r = c + (c - pts[-1]); fr = f(r)
        if fr < vals[0]:
            e = c + 2 * (c - pts[-1]); fe = f(e)
            pts[-1], vals[-1] = (e, fe) if fe < fr else (r, fr)
        elif fr < vals[-2]:
            pts[-1], vals[-1] = r, fr
        else:
            k = c + 0.5 * (pts[-1] - c); fk = f(k)
            if fk < vals[-1]:
                pts[-1], vals[-1] = k, fk
            else:
                pts = [pts[0] + 0.5 * (p - pts[0]) for p in pts]
                vals = [f(p) for p in pts]
    i = int(np.argmin(vals))
    return pts[i], vals[i]


if __name__ == "__main__":
    best = None
    for x0 in ([0.2, 0.0, 0.0, 1.0], [0.05, 0.7, 0.1, 1.0], [0.4, 0.0, 0.2, 1.0], [0.3, 0.3, 0.0, 1.0], [0.17, 0.17, 0.0, 1.0]):
        for D0 in (0.35, 0.45, 0.55):
            p, v = nm(err, [T.min() - 0.01, D0] + x0, [0.01, 0.05, 0.1, 0.1, 0.1, 0.1])
            if best is None or v < best[1]:
                best = (p, v)
    p, v = best
    D = fixedD or p[1]
    print('start=%.4f duration=%.0fms bezier=(%.3f, %.3f, %.3f, %.3f) rms=%.4f n=%d' % (p[0], D * 1000, p[2], p[3], p[4], p[5], v ** 0.5, len(T)))
    m = model(p)
    for t, a, b in zip(T, P, m):
        print('  %4.0fms  measured=%.3f  fit=%.3f' % ((t - p[0]) * 1000, a, b))
