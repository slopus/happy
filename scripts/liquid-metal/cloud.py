"""The Happy Cloud mark and its Liquid Metal field.

Paper's Liquid Metal (https://github.com/paper-design/shaders,
packages/shaders/src/shaders/liquid-metal.ts, Apache-2.0) turns an image
into a field before its shader runs: toProcessedLiquidMetal solves a Poisson
equation inside the shape, and the shader blurs that 3x3 and raises it to
1.6. None of it moves, so this script does all of it once, ahead of time,
and every platform ships the result: a 512 square PNG, red the edge, green
the mask's alpha. It also holds a numpy copy of the fragment shader, to
check a port against and to preview the mark.

    pip install numpy pillow
    python3 cloud.py <outdir>            # the SVGs and fields
    python3 cloud.py <outdir> --preview  # and preview sheets

Writes cloud.svg / cloud-liquid-metal.png (the cloud with the Happy H cut
out, the one in use) and cloud-plain.svg / cloud-plain-liquid-metal.png.
Copies live in happy-ios (Sources/HappyUI/Resources/LiquidMetal),
happy-android (res/drawable-nodpi) and happy-desktop.
"""
import math
import sys
import numpy as np
from PIL import Image, ImageDraw

VIEW = 1000.0

# ---------------------------------------------------------------- geometry
# A cloud: a flat base, a left bump and a right bump that sit on it, a big top
# bump, joined by concave fillets. Units of a 1000 square.
CIRCLES = {
    "L": (0.0, 0.0, 150.0),
    "T": (0.0, 0.0, 225.0),
    "R": (0.0, 0.0, 175.0),
}
FILLET = 46.0


def layout():
    """Circle centres before centring: L and R sit on the baseline y=0. Close
    together, so the cloud is about 1.4 times as wide as it is tall and fills
    a square more than a long, flat one would; the top bump nearly central,
    so the H under it reads as centred."""
    L = (-200.0, -140.0, 140.0)
    T = (-12.0, -278.0, 215.0)
    R = (192.0, -160.0, 160.0)
    return L, T, R


def fillet_center(c1, c2, rf):
    """Centre of a circle of radius rf tangent (outside) to c1 and c2, above them."""
    (x1, y1, r1), (x2, y2, r2) = c1, c2
    d1, d2 = r1 + rf, r2 + rf
    dx, dy = x2 - x1, y2 - y1
    d = math.hypot(dx, dy)
    a = (d1 * d1 - d2 * d2 + d * d) / (2 * d)
    h = math.sqrt(max(d1 * d1 - a * a, 0.0))
    mx, my = x1 + a * dx / d, y1 + a * dy / d
    # two solutions; take the one with smaller y (above, y is down)
    p1 = (mx + h * dy / d, my - h * dx / d)
    p2 = (mx - h * dy / d, my + h * dx / d)
    return p1 if p1[1] < p2[1] else p2


def toward(c, p):
    """Point on circle c in the direction of p."""
    x, y, r = c
    dx, dy = p[0] - x, p[1] - y
    d = math.hypot(dx, dy)
    return (x + r * dx / d, y + r * dy / d)


def outline():
    """The outline as a list of segments: ('L', p0, p1) or ('A', centre, r,
    a0, a1, ccw) with angles in radians (y down), plus the bbox."""
    L, T, R = layout()
    f1 = fillet_center(L, T, FILLET)
    f2 = fillet_center(T, R, FILLET)
    # tangent points
    lt = toward(L, f1)
    tl = toward(T, f1)
    tr = toward(T, f2)
    rt = toward(R, f2)
    bl = (L[0], 0.0)
    br = (R[0], 0.0)

    def ang(c, p):
        return math.atan2(p[1] - c[1], p[0] - c[0])

    segs = []
    # bottom, left to right
    segs.append(("L", bl, br))
    # right circle: from bottom (angle +90deg) going counter-clockwise on
    # screen (decreasing angle, y down) up to rt
    segs.append(("A", R[:2], R[2], ang(R, br), ang(R, rt), "neg"))
    # fillet between R and T (concave): from rt to tr
    segs.append(("A", f2, FILLET, ang(f2, rt), ang(f2, tr), "pos"))
    # top circle from tr to tl
    segs.append(("A", T[:2], T[2], ang(T, tr), ang(T, tl), "neg"))
    # fillet between T and L
    segs.append(("A", f1, FILLET, ang(f1, tl), ang(f1, lt), "pos"))
    # left circle from lt down to bl
    segs.append(("A", L[:2], L[2], ang(L, lt), ang(L, bl), "neg"))
    return segs


def sweep(a0, a1, direction):
    """Signed sweep from a0 to a1 going in direction ('neg' = decreasing)."""
    d = a1 - a0
    if direction == "neg":
        while d > 0:
            d -= 2 * math.pi
    else:
        while d < 0:
            d += 2 * math.pi
    return d


def polyline(segs, step=2.0):
    pts = []
    for s in segs:
        if s[0] == "L":
            pts.append(s[1])
        else:
            _, c, r, a0, a1, dirn = s
            sw = sweep(a0, a1, dirn)
            n = max(4, int(abs(sw) * r / step))
            for i in range(n):
                a = a0 + sw * i / n
                pts.append((c[0] + r * math.cos(a), c[1] + r * math.sin(a)))
    return pts


def centroid(pts):
    """The area centroid of a closed polygon (shoelace)."""
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        c = x0 * y1 - x1 * y0
        a += c
        cx += (x0 + x1) * c
        cy += (y0 + y1) * c
    return cx / (3 * a), cy / (3 * a)


def transform_for(pts, width_frac):
    """Scale so the cloud is width_frac of the square wide; centre it across
    by its extent and down by its mass, which sits low in a cloud, so it
    reads as centred rather than sinking."""
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    s = VIEW * width_frac / w
    cx = (max(xs) + min(xs)) / 2
    cy = centroid(pts)[1]
    return s, cx, cy, h * s


def apply(p, s, cx, cy):
    return ((p[0] - cx) * s + VIEW / 2, (p[1] - cy) * s + VIEW / 2)


# Wide enough that the edge's bevel and highlight still have a few pixels.
WIDTH_FRAC = 0.95


def h_place():
    """Where the H goes, in output units: across, the middle of the cloud's
    body (the wide part between the side bumps' outer edges); down, the
    cloud's centre of mass, which the transform put at the square's centre.
    Its side is a third of the cloud's height."""
    L, T, R = layout()
    pts = polyline(outline())
    s, cx, cy, height = transform_for(pts, WIDTH_FRAC)
    body = ((L[0] - L[2]) + (R[0] + R[2])) / 2
    x = apply((body, 0.0), s, cx, cy)[0]
    return (round(x, 2), VIEW / 2), round(height * 0.36, 2)


def h_outline():
    """The Happy H cut out of the cloud: the 3x3 grid logo without its gaps
    (which vanish at the sizes it is shown), so two posts and the middle
    block, one outline. As in the logo, only the four outer corners are
    rounded, by 64/1024 of its side. Output units, clockwise on screen."""
    # centred on the cloud's body, clear of its flat bottom by more than
    # the bevel is wide
    (hx, hy), S = h_place()
    t = S / 3
    x0, y0 = hx - S / 2, hy - S / 2
    r = S * 64 / 1024
    q = math.pi / 2
    return [
        ("L", (x0 + r, y0), (x0 + t, y0)),
        ("L", (x0 + t, y0), (x0 + t, y0 + t)),
        ("L", (x0 + t, y0 + t), (x0 + 2 * t, y0 + t)),
        ("L", (x0 + 2 * t, y0 + t), (x0 + 2 * t, y0)),
        ("L", (x0 + 2 * t, y0), (x0 + S - r, y0)),
        ("A", (x0 + S - r, y0 + r), r, -q, 0.0, "pos"),
        ("L", (x0 + S, y0 + r), (x0 + S, y0 + S - r)),
        ("A", (x0 + S - r, y0 + S - r), r, 0.0, q, "pos"),
        ("L", (x0 + S - r, y0 + S), (x0 + 2 * t, y0 + S)),
        ("L", (x0 + 2 * t, y0 + S), (x0 + 2 * t, y0 + 2 * t)),
        ("L", (x0 + 2 * t, y0 + 2 * t), (x0 + t, y0 + 2 * t)),
        ("L", (x0 + t, y0 + 2 * t), (x0 + t, y0 + S)),
        ("L", (x0 + t, y0 + S), (x0 + r, y0 + S)),
        ("A", (x0 + r, y0 + S - r), r, q, math.pi, "pos"),
        ("L", (x0, y0 + S - r), (x0, y0 + r)),
        ("A", (x0 + r, y0 + r), r, math.pi, 3 * q, "pos"),
    ]


def path_data(segs, point, scale):
    """SVG path data for segments; `point` maps a point to output units and
    `scale` a radius."""

    def P(p):
        q = point(p)
        return f"{q[0]:.2f} {q[1]:.2f}"

    first = segs[0]
    d = [f"M{P(first[1])}"]
    for sg in segs:
        if sg[0] == "L":
            d.append(f"L{P(sg[2])}")
            continue
        _, c, r, a0, a1, dirn = sg
        sw = sweep(a0, a1, dirn)
        end = (c[0] + r * math.cos(a1), c[1] + r * math.sin(a1))
        large = 1 if abs(sw) > math.pi else 0
        sweep_flag = 1 if sw > 0 else 0  # y down: a growing angle turns clockwise on screen
        d.append(f"A{r * scale:.2f} {r * scale:.2f} 0 {large} {sweep_flag} {P(end)}")
    d.append("Z")
    return "".join(d)


def svg(variant):
    segs = outline()
    s, cx, cy, _ = transform_for(polyline(segs), WIDTH_FRAC)
    d = path_data(segs, lambda p: apply(p, s, cx, cy), s)
    if variant == "h":
        # The H sits wholly inside the cloud, so even-odd cuts it out.
        d += path_data(h_outline(), lambda p: p, 1.0)
        body = f'<path fill-rule="evenodd" d="{d}"/>'
    else:
        body = f'<path d="{d}"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">{body}</svg>\n', d


def mask(variant, size=4096):
    """Alpha of the mark at size x size, anti-aliased (drawn at 2x, halved)."""
    big = size * 2
    k = big / VIEW
    img = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(img)
    segs = outline()
    pts = polyline(segs, step=0.5)
    s, cx, cy, _ = transform_for(pts, WIDTH_FRAC)
    draw.polygon([tuple(c * k for c in apply(p, s, cx, cy)) for p in pts], fill=255)
    if variant == "h":
        draw.polygon([(p[0] * k, p[1] * k) for p in polyline(h_outline(), step=0.25)], fill=0)
    return np.asarray(img.resize((size, size), Image.LANCZOS), dtype=np.float32) / 255.0


# ------------------------------------------------- Paper's preprocessing
def poisson(shape, iterations=40, omega=1.9, C=0.01):
    """toProcessedLiquidMetal's red-black SOR, vectorised. shape: bool HxW."""
    h, w = shape.shape
    # boundary: shape pixels on the image edge or with any 8-neighbour outside
    pad = np.pad(shape, 1, constant_values=False)
    nb_all = np.ones_like(shape)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            nb_all &= pad[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
    interior = shape & nb_all
    yy, xx = np.mgrid[0:h, 0:w]
    red = interior & ((xx + yy) % 2 == 0)
    black = interior & ((xx + yy) % 2 == 1)
    u = np.zeros((h, w), dtype=np.float64)
    shape_f = shape.astype(np.float64)

    def nsum(u):
        p = np.pad(u * shape_f, 1)
        return p[1:-1, 2:] + p[1:-1, :-2] + p[:-2, 1:-1] + p[2:, 1:-1]

    for _ in range(iterations):
        for m in (red, black):
            nv = (C + nsum(u)) / 4
            u = np.where(m, omega * nv + (1 - omega) * u, u)
    return u, interior


def field(alpha4096, work=512, out=512):
    """R = Paper's edge after blurEdge3x3 and pow 1.6, G = alpha. Built the
    way toProcessedLiquidMetal builds its PNG from a 4096 SVG raster, then
    reduced to `out` (the GPU mipmaps Paper's 4096 texture to about this)."""
    size = alpha4096.shape[0]
    small = np.asarray(
        Image.fromarray((alpha4096 * 255).astype(np.uint8)).resize((work, work), Image.BILINEAR),
        dtype=np.float32,
    ) / 255.0
    shape = small > 0
    u, interior = poisson(shape)
    maxv = u[interior].max()
    gray = np.where(shape, 1 - u / maxv, 1.0)
    # upscale gray (premultiplied with the shape's alpha, as canvas does)
    a_small = shape.astype(np.float32)
    up_g = np.asarray(Image.fromarray((gray * a_small).astype(np.float32)).resize((size, size), Image.BILINEAR))
    up_a = np.asarray(Image.fromarray(a_small).resize((size, size), Image.BILINEAR))
    with np.errstate(invalid="ignore", divide="ignore"):
        up = np.where(up_a > 0, up_g / np.maximum(up_a, 1e-6), 0.0)
    r = np.where(alpha4096 == 0, 1.0, np.where(up_a == 0, 0.0, up))
    r = np.round(r * 255) / 255  # it was a PNG
    # blurEdge3x3 at 6 texels of the 4096 texture
    rad = 6
    p = np.pad(r, rad, mode="edge")
    H = r.shape[0]

    def sh(dy, dx):
        return p[rad + dy:rad + dy + H, rad + dx:rad + dx + H]

    b = (4 * r + 2 * (sh(-rad, 0) + sh(rad, 0) + sh(0, -rad) + sh(0, rad))
         + sh(-rad, -rad) + sh(-rad, rad) + sh(rad, -rad) + sh(rad, rad)) / 16
    edge = np.power(np.clip(b, 0, 1), 1.6)
    # contour .4: smoothstep(0,.4,.4) = 1, so no further factor
    R = np.asarray(Image.fromarray(edge.astype(np.float32)).resize((out, out), Image.BOX))
    G = np.asarray(Image.fromarray(alpha4096.astype(np.float32)).resize((out, out), Image.BOX))
    return R, G


# --------------------------------------------- reference fragment shader
def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def gmod(x, y):
    return x - y * np.floor(x / y)


def snoise(vx, vy):
    C = (0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439)
    s = (vx + vy) * C[1]
    ix, iy = np.floor(vx + s), np.floor(vy + s)
    t = (ix + iy) * C[0]
    x0x, x0y = vx - ix + t, vy - iy + t
    i1x = np.where(x0x > x0y, 1.0, 0.0)
    i1y = 1.0 - i1x
    x12x, x12y = x0x + C[0] - i1x, x0y + C[0] - i1y
    x12z, x12w = x0x + C[2], x0y + C[2]
    ix, iy = gmod(ix, 289.0), gmod(iy, 289.0)

    def permute(x):
        return gmod(((x * 34.0) + 1.0) * x, 289.0)

    p0 = permute(permute(iy + 0.0) + ix + 0.0)
    p1 = permute(permute(iy + i1y) + ix + i1x)
    p2 = permute(permute(iy + 1.0) + ix + 1.0)
    m0 = np.maximum(0.5 - (x0x * x0x + x0y * x0y), 0)
    m1 = np.maximum(0.5 - (x12x * x12x + x12y * x12y), 0)
    m2 = np.maximum(0.5 - (x12z * x12z + x12w * x12w), 0)
    m0, m1, m2 = m0 ** 4, m1 ** 4, m2 ** 4
    out = 0
    for m, p, gx, gy in ((m0, p0, x0x, x0y), (m1, p1, x12x, x12y), (m2, p2, x12z, x12w)):
        x = 2.0 * np.modf(p * C[3])[0] - 1.0
        x = 2.0 * (p * C[3] - np.floor(p * C[3])) - 1.0
        h = np.abs(x) - 0.5
        ox = np.floor(x + 0.5)
        a0 = x - ox
        m = m * (1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h))
        out = out + m * (a0 * gx + h * gy)
    return 130.0 * out


def fwidth(a):
    # 2x2 quad derivatives, as a GPU takes them
    h, w = a.shape
    dx = np.zeros_like(a)
    dy = np.zeros_like(a)
    dx[:, 0::2] = a[:, 1::2] - a[:, 0::2]
    dx[:, 1::2] = dx[:, 0::2]
    dy[0::2, :] = a[1::2, :] - a[0::2, :]
    dy[1::2, :] = dy[0::2, :]
    return np.abs(dx) + np.abs(dy)


DEFAULTS = dict(repetition=2.0, softness=0.1, shiftRed=0.3, shiftBlue=0.3,
                distortion=0.07, contour=0.4, angle=70.0, tint=(1, 1, 1, 1))


def shade(R, G, size, time, P=DEFAULTS):
    """Premultiplied RGBA float image of size x size. uv covers the field."""
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float64) + 0.5
    ux, uy = xs / size, ys / size
    # bilinear sample of the field (clamp to edge)
    fr = np.asarray(Image.fromarray(R.astype(np.float32)).resize((size, size), Image.BILINEAR), dtype=np.float64)
    fg = np.asarray(Image.fromarray(G.astype(np.float32)).resize((size, size), Image.BILINEAR), dtype=np.float64)
    t = 0.3 * (time + 2.8)
    cw = P["repetition"]
    edge = fr * smoothstep(0.0, 0.4, P["contour"])
    opacity = fg
    ang = (-P["angle"] + 70.0) * math.pi / 180
    rx = (ux - .5) * math.cos(ang) - (uy - .5) * math.sin(ang) + .5
    ry = (ux - .5) * math.sin(ang) + (uy - .5) * math.cos(ang) + .5
    diagBL = rx - ry
    diagTL = rx + ry
    c1 = (0.98, 0.98, 1.0)
    c2 = (0.1, 0.1, 0.1 + 0.1 * smoothstep(0.7, 1.3, diagTL))
    gx, gy = ux - .5, uy - .5
    dist = np.hypot(gx, gy + .2 * diagBL)
    th = (.25 - .2 * diagBL) * math.pi
    direction = np.cos(th) * gx - np.sin(th) * gy
    bump = 1 - np.power(1.8 * dist, 1.2)
    bump = bump * np.power(uy, .3)
    thin1 = .12 / cw * (1 - .4 * bump)
    thin2 = .07 / cw * (1 + .4 * bump)
    wide = 1 - thin1 - thin2
    w0, w1, w2 = cw * thin1, cw * thin2, wide
    noise = snoise(ux - t, uy - t)
    edge = edge + (1 - edge) * P["distortion"] * noise
    se = smoothstep(0., 1., edge)
    direction = direction + diagBL
    direction = direction - 2 * noise * diagBL * (se * (1 - se))
    k = smoothstep(.5, 1., P["contour"])
    direction = direction * (1 + (-edge) * k)
    direction = direction - 1.7 * edge * k
    direction = direction + .2 * P["contour"] ** 4 * (1 - se)
    bump = bump * np.clip(np.power(uy, .1), .3, 1)
    direction = direction * (.1 + (1.1 - edge) * bump)
    direction = direction * (.4 + .6 * (1 - smoothstep(.5, 1., edge)))
    direction = direction + .18 * (smoothstep(.1, .2, uy) * (1 - smoothstep(.2, .4, uy)))
    direction = direction + .03 * (smoothstep(.1, .2, 1 - uy) * (1 - smoothstep(.2, .4, 1 - uy)))
    direction = direction * (.5 + .5 * uy * uy)
    direction = direction * cw
    direction = direction - t
    disp = np.clip(1 - bump, 0, 1)
    dR = disp + .03 * bump * noise
    dR = dR + 5 * (smoothstep(-.1, .2, uy) * (1 - smoothstep(.1, .5, uy))) * (smoothstep(.4, .6, bump) * (1 - smoothstep(.4, 1., bump)))
    dR = dR - diagBL
    dB = disp * 1.3
    dB = dB + (smoothstep(0., .4, uy) * (1 - smoothstep(.1, .8, uy))) * (smoothstep(.4, .6, bump) * (1 - smoothstep(.4, .8, bump)))
    dB = dB - .2 * edge
    dR = dR * (P["shiftRed"] / 20)
    dB = dB * (P["shiftBlue"] / 20)
    soft = .05 * P["softness"]
    blur = soft + .5 * smoothstep(1., 10., cw) * smoothstep(0., 1., edge)
    small_t = 1 - smoothstep(100., 500., float(size))
    blur = blur + small_t * smoothstep(0., 1., edge)
    rEx = soft * (.05 + .1 * (P["shiftRed"] / 20) * bump)
    gEx = soft * .05 / np.maximum(.001, np.abs(1 - diagBL))
    w1 = w1 - .02 * smoothstep(0., 1., edge + bump)
    tint = P["tint"]

    def changes(a, b, sp, bl, bmp, tn):
        bmp = smoothstep(.2, .8, bmp)
        ch = a * 0 + b + (a - b) * smoothstep(0., 2 * bl, sp)
        ch = ch + (b - ch) * smoothstep(w0, w0 + 2 * bl, sp)
        border = w0 + .4 * (1 - bmp) * w1
        ch = ch + (a - ch) * smoothstep(border, border + 2 * bl, sp)
        border = w0 + .5 * (1 - bmp) * w1
        ch = ch + (b - ch) * smoothstep(border, border + 2 * bl, sp)
        border = w0 + w1
        ch = ch + (a - ch) * smoothstep(border, border + 2 * bl, sp)
        gt = (sp - w0 - w1) / w2
        grad = a + (b - a) * smoothstep(0., 1., gt)
        ch = ch + (grad - ch) * smoothstep(border, border + .5 * bl, sp)
        burn = 1 - np.minimum(1., (1 - ch) / max(tn, 1e-4))
        return ch + (burn - ch) * tint[3]

    def fract(x):
        return x - np.floor(x)

    sr = fract(direction + dR)
    sg = fract(direction)
    sb = fract(direction - dB)
    r = changes(c1[0], c2[0], sr, blur + fwidth(sr) + rEx, bump, tint[0])
    g = changes(c1[1], c2[1], sg, blur + fwidth(sg) + gEx, bump, tint[1])
    b = changes(c1[2], c2[2], sb, blur + fwidth(sb), bump, tint[2])
    rgb = np.stack([r, g, b], -1) * opacity[..., None]
    return np.concatenate([rgb, opacity[..., None]], -1)


def composite(rgba, bg):
    bg = np.array(bg, dtype=np.float64) / 255
    out = rgba[..., :3] + bg * (1 - rgba[..., 3:4])
    return Image.fromarray((np.clip(out, 0, 1) * 255 + .5).astype(np.uint8))


if __name__ == "__main__":
    outdir = sys.argv[1]
    preview = "--preview" in sys.argv
    fields = {}
    for v, name in (("h", "cloud"), ("plain", "cloud-plain")):
        text, _ = svg(v)
        open(f"{outdir}/{name}.svg", "w").write(text)
        R, G = field(mask(v))
        fields[v] = (R, G)
        # Opaque RGB, so no tool on the way premultiplies it.
        rgb = np.stack([R, G, np.zeros_like(R)], -1)
        Image.fromarray((np.clip(rgb, 0, 1) * 255 + .5).astype(np.uint8)).save(f"{outdir}/{name}-liquid-metal.png", optimize=True)
        if not preview:
            continue
        np.save(f"{outdir}/{name}-liquid-metal.npy", np.stack([R, G]))
        tiles = []
        for bg in ((255, 255, 255), (0, 0, 0)):
            for tm in (0.0, 2.0, 5.0):
                tiles.append(composite(shade(R, G, 384, tm), bg))
        sheet = Image.new("RGB", (384 * 3, 384 * 2))
        for i, tl in enumerate(tiles):
            sheet.paste(tl, ((i % 3) * 384, (i // 3) * 384))
        sheet.save(f"{outdir}/preview-{name}.png")
    if preview:
        # Both marks at the slide's sizes, 96 pt at 3x (288 px) and 2x
        # (192 px), on light and dark, at the same moment.
        W = 288 * 2 + 192 * 2 + 5 * 24
        sheet = Image.new("RGB", (W, 288 * 2 + 3 * 24), (128, 128, 128))
        for row, bg in enumerate(((255, 255, 255), (0, 0, 0))):
            x = 24
            for v in ("plain", "h"):
                for px in (288, 192):
                    R, G = fields[v]
                    sheet.paste(composite(shade(R, G, px, 2.0), bg), (x, 24 + row * (288 + 24) + (288 - px) // 2))
                    x += px + 24
        sheet.save(f"{outdir}/compare.png")


