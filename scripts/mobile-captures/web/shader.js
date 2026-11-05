const VERT = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;
const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime, uSeed, uGrain;
uniform vec3 c0, c1, c2, c3;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.x * 1.05 + uSeed;
  float t = uTime * 0.05;
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p + 3.2 * q + vec2(1.7, 9.2) + 0.7 * t), fbm(p + 3.2 * q + vec2(8.3, 2.8) - 0.6 * t));
  float f = fbm(p + 3.0 * r);

  vec3 col = mix(c0, c1, clamp(f * f * 2.6, 0.0, 1.0));
  col = mix(col, c2, clamp(length(q) * 1.1 - 0.45, 0.0, 1.0));
  col = mix(col, c3, clamp(r.x * r.x * 1.8 - 0.15, 0.0, 1.0));

  // silk sheen along the warped contours
  float band = 0.5 + 0.5 * sin(f * 13.0 + r.y * 5.0 - uTime * 0.3);
  col += pow(band, 10.0) * 0.13 * (0.4 + f);
  col += pow(smoothstep(0.55, 1.0, f), 3.0) * 0.35;

  // keep the headline area a touch deeper, fade to a soft glow behind the phone
  col *= mix(1.0, 0.82, smoothstep(0.62, 1.0, uv.y));
  col += c1 * 0.12 * smoothstep(0.6, 0.0, length(uv - vec2(0.5, 0.35)));

  float g = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(g), col, 1.18);
  col += (hash(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.045 * uGrain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
