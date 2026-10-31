"""Tracks the top page (opaque, sliding) and the page beneath (parallax, dimmed) in a pane.

usage: track.py video.mp4 push|pop out.csv
push: top page = final frame's pane content, beneath = first frame's.
pop:  top page = first frame's pane content, beneath = final frame's.
Offsets are in full-resolution px (positive = right). Dim is measured away
from the top page's edge (SHADOW half-px excluded); the shadow is reported
as the darkening right next to the edge relative to that dim.
"""
from load import frames
import numpy as np, sys

path, mode, out = sys.argv[1], sys.argv[2], sys.argv[3]
import os
L, R = int(os.environ.get("PL", 383)), int(os.environ.get("PR", 984))
SHADOW = 40
t, a = frames(path)
rows = slice(120, 1040, 2)
a = a[:, rows, :]
top_ref = a[-1] if mode == 'push' else a[0]
under_ref = a[0] if mode == 'push' else a[-1]
W = R - L


def top_offset(f):
    best = (1e9, 0)
    for dx in range(0, int(W * 0.97)):
        e = np.abs(f[:, L + dx:R] - top_ref[:, L:R - dx]).mean()
        if e < best[0]:
            best = (e, dx)
    return best


def under(f, top_dx):
    vis = top_dx - SHADOW
    if vis < 30:
        return None
    best = (1e9, 0, 1)
    for s in range(0, W - top_dx):
        x = f[:, L:L + vis]
        r = under_ref[:, L + s:L + s + vis]
        den = (r * r).sum()
        k = (x * r).sum() / den if den > 0 else 1
        e = np.abs(x - k * r).mean()
        if e < best[0]:
            best = (e, s, k)
    e, s, k = best
    # shadow: brightness ratio in the SHADOW px left of the edge vs. the dimmed reference
    x = f[:, L + top_dx - SHADOW:L + top_dx]
    r = under_ref[:, L + top_dx - SHADOW + s:L + top_dx + s]
    prof = []
    for c in range(0, SHADOW, 4):
        den = (r[:, c:c + 4] * r[:, c:c + 4]).sum()
        prof.append((x[:, c:c + 4] * r[:, c:c + 4]).sum() / den / k if den > 0 else 1)
    return e, s, k, prof


with open(out, 'w') as o:
    o.write('t,top,top_err,under,dim,under_err,shadow_profile\n')
    for i, f in enumerate(a):
        e, dx = top_offset(f)
        u = under(f, dx)
        if u is None:
            o.write('%.5f,%d,%.2f,,,,\n' % (t[i], dx * 2, e))
        else:
            o.write('%.5f,%d,%.2f,%d,%.4f,%.2f,%s\n' % (t[i], dx * 2, e, -u[1] * 2, u[2], u[0], ' '.join('%.2f' % p for p in u[3])))
print(open(out).read())
