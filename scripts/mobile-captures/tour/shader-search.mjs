// CPU port of art.html's FRAG (the hero shader with the glow moved behind the phone and the
// noise scaled by uRef), for the search-results video. Writes raw RGB frames [from, to) to stdout.
// usage: node shader-search.mjs W H FPS SPEED REF GLOWX GLOWY FROM TO
const [W, H, FPS, SPEED, REF, GX, GY, FROM, TO] = process.argv.slice(2).map(Number);
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const [c0, c1, c2, c3] = ["#2a0670", "#ff3d9a", "#ffa63d", "#3d5bff"].map(hex);
const fract = x => x - Math.floor(x);
function hash(x, y) {
  x = fract(x * 123.34); y = fract(y * 456.21);
  const d = x * (x + 45.32) + y * (y + 45.32);
  x += d; y += d;
  return fract(x * y);
}
function noise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
}
function fbm(x, y) {
  let v = 0, a = 0.5;
  for (let i = 0; i < 5; i++) {
    v += a * noise(x, y);
    const nx = 1.6 * x - 1.2 * y, ny = 1.2 * x + 1.6 * y;
    x = nx; y = ny; a *= 0.5;
  }
  return v;
}
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const buf = Buffer.alloc(W * H * 3);
const col = [0, 0, 0];
for (let f = FROM; f < TO; f++) {
  const uTime = 20 + (f / FPS) * SPEED;
  const t = uTime * 0.05;
  for (let j = 0; j < H; j++) {
    const fy = H - 1 - j + 0.5;
    const uvy = fy / H;
    const dark = 1 + (0.82 - 1) * smooth(0.62, 1, uvy);
    for (let i = 0; i < W; i++) {
      const fx = i + 0.5;
      const uvx = fx / W;
      const px = (fx - 0.5 * W) / REF * 1.05, py = (fy - 0.5 * H) / REF * 1.05;
      const qx = fbm(px, py + t), qy = fbm(px + 5.2 - t, py + 1.3 - t);
      const rx = fbm(px + 3.2 * qx + 1.7 + 0.7 * t, py + 3.2 * qy + 9.2 + 0.7 * t);
      const ry = fbm(px + 3.2 * qx + 8.3 - 0.6 * t, py + 3.2 * qy + 2.8 - 0.6 * t);
      const fv = fbm(px + 3 * rx, py + 3 * ry);
      const m0 = clamp(fv * fv * 2.6), m1 = clamp(Math.hypot(qx, qy) * 1.1 - 0.45), m2 = clamp(rx * rx * 1.8 - 0.15);
      const band = 0.5 + 0.5 * Math.sin(fv * 13 + ry * 5 - uTime * 0.3);
      const sheen = Math.pow(band, 10) * 0.13 * (0.4 + fv) + Math.pow(smooth(0.55, 1, fv), 3) * 0.35;
      const dx = (uvx - GX) * (W / H) * 0.7, dy = (uvy - (1 - GY)) * 0.7;
      const glow = 0.12 * smooth(0.6, 0, Math.hypot(dx, dy));
      for (let k = 0; k < 3; k++) {
        let v = c0[k] + (c1[k] - c0[k]) * m0;
        v += (c2[k] - v) * m1;
        v += (c3[k] - v) * m2;
        col[k] = (v + sheen) * dark + c1[k] * glow;
      }
      const g = col[0] * 0.299 + col[1] * 0.587 + col[2] * 0.114;
      const o = (j * W + i) * 3;
      for (let k = 0; k < 3; k++) buf[o + k] = Math.round(clamp(g + (col[k] - g) * 1.18) * 255);
    }
  }
  process.stdout.write(Buffer.from(buf));
}
