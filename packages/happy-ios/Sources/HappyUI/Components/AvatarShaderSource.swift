/*
 * The fragment shader below is ported from @craftedstudios/shaders 1.0.1
 * (https://shaders.craftedstudios.co, src/shader.js), the avatar half only.
 *
 * MIT License, Copyright (c) 2026 Crafted Studios. Its full text is
 * Resources/AvatarPlaceholders/LICENSE-craftedstudios-shaders.txt.
 *
 * Changes from the original: GLSL ES to Metal; only the five effects an
 * avatar's seed can pick (no metals) and no outlines; no goo, pointer
 * interaction, entrance or ring, so an avatar fills its square and its view
 * clips it; GLSL's smoothstep (which allows edges in either order) written
 * out; sin in `hash` precise, so the noise is the browser's; a Black & White
 * mode.
 */
#if canImport(UIKit)

let avatarShaderMetal = """
#include <metal_stdlib>
using namespace metal;

struct Uniforms {
  float4 col1, col2, col3, col4;
  float4 layout;    // per-seed pattern offset (xy), turn (z) and zoom (w)
  float fx;         // which effect: 0 linear, 1 thermal, 2 topography, 3 plasma, 4 radial
  float t;          // seconds, phase included
  float angle;      // per-seed angle for effects that have a direction
  float warp;       // distortion: 1 is each effect's own amount
  float scale;      // pattern zoom
  float grain;
  float grainCell;
  float mono;       // 1 drains the colour
  float2 size;      // device px
  float2 pad;
};

vertex float4 avatar_vertex(uint id [[vertex_id]]) {
  float2 p = float2((id << 1) & 2, id & 2);
  return float4(p * 2.0 - 1.0, 0.0, 1.0);
}

// GLSL's smoothstep, which runs either way between its edges.
float sstep(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float hash(float2 p) { return fract(precise::sin(dot(p, float2(41.3, 289.1))) * 43758.5); }
float noise(float2 p) {
  float2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + float2(1, 0)), f.x), mix(hash(i + float2(0, 1)), hash(i + float2(1, 1)), f.x), f.y);
}

float rfHash12(float2 p) {
  float3 p3 = fract(float3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float rfFilmGrain(float2 px, float3 col, constant Uniforms &u) {
  float t = floor(fract(u.t * 0.731) * 240.0);
  float n = rfHash12(floor(px / u.grainCell) + float2(t * 17.0, t * 9.0));
  float luma = dot(col, float3(0.2126, 0.7152, 0.0722));
  float resp = mix(0.35, 1.0, sstep(0.0, 0.22, luma)) * (1.0 - 0.8 * sstep(0.72, 1.0, luma));
  return (n - 0.5) * resp * 1.5;
}

float3 toLab(float3 c) {
  c = pow(max(c, 0.0), float3(2.2));
  float3 lms = pow(float3(
    0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b,
    0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b,
    0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b), float3(1.0 / 3.0));
  return float3(
    0.2104542553 * lms.x + 0.7936177850 * lms.y - 0.0040720468 * lms.z,
    1.9779984951 * lms.x - 2.4285922050 * lms.y + 0.4505937099 * lms.z,
    0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.8086757660 * lms.z);
}
float3 fromLab(float3 L) {
  float3 lms = float3(
    L.x + 0.3963377774 * L.y + 0.2158037573 * L.z,
    L.x - 0.1055613458 * L.y - 0.0638541728 * L.z,
    L.x - 0.0894841775 * L.y - 1.2914855480 * L.z);
  lms = lms * lms * lms;
  float3 c = float3(
    4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,
    -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,
    -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.7076147010 * lms.z);
  return pow(clamp(c, 0.0, 1.0), float3(1.0 / 2.2));
}

float3 blend(float3 a, float3 b, float t) {
  return fromLab(mix(toLab(a), toLab(b), t));
}

float3 steps4(float g, float3 c1, float3 c2, float3 c3, float3 c4) {
  if (g < 0.34) return c1;
  if (g < 0.57) return blend(c1, c2, sstep(0.34, 0.57, g));
  if (g < 0.59) return c2;
  if (g < 0.76) return blend(c2, c3, sstep(0.59, 0.76, g));
  if (g < 0.78) return c3;
  if (g < 0.93) return blend(c3, c4, sstep(0.78, 0.93, g));
  return c4;
}

float2 rot2(float2 v, float a) { float c = cos(a), s = sin(a); return float2(v.x * c - v.y * s, v.x * s + v.y * c); }

float3 fxPlasma(float2 uv, float t, float warp, float3 c1, float3 c2, float3 c3, float3 c4) {
  t *= 0.15;
  float2 p = uv * 1.8;
  for (float i = 1.0; i <= 3.0; i += 1.0) {
    p.x += 0.16 * warp / i * sin(i * 1.7 * p.y + t * 0.9 + i * 0.3);
    p.y += 0.16 * warp / i * cos(i * 2.1 * p.x + t * 1.1 - i * 0.5);
  }
  float v = sin(p.x * 3.0 + t) + sin(p.y * 2.7 - t * 0.7) + sin((p.x + p.y) * 2.3 + t * 0.5);
  float2 c = p - 0.9;
  v += sin(length(c) * 4.0 - t * 1.3);
  v += 0.7 * sin(p.x * 1.8 - p.y * 2.5 + t * 0.8) + 0.5 * sin(rot2(p, 0.7).x * 3.5 + t * 0.4);
  v = v / 5.2 * 0.5 + 0.5;
  float g = fract(v * 1.5);
  if (g > 0.88) return blend(c4, c1, sstep(0.88, 1.0, g));
  return steps4(g / 0.88, c1, c2, c3, c4);
}

float3 fxLinear(float2 uv, float t, float warp, float ang, float3 c1, float3 c2, float3 c3, float3 c4) {
  t *= 0.15;
  float2 p = uv;
  for (float i = 1.0; i <= 2.0; i += 1.0) {
    p.x += 0.12 * warp / i * sin(i * 5.1 * p.y + t * 0.9 + i * 0.3);
    p.y += 0.12 * warp / i * cos(i * 6.3 * p.x + t * 1.1 - i * 0.5);
  }
  float g = clamp((p.x - 0.5) * cos(ang) + (p.y - 0.5) * sin(ang) + 0.5, 0.0, 1.0);
  return steps4(g, c1, c2, c3, c4);
}

float3 fxRadial(float2 uv, float t, float warp, float3 c1, float3 c2, float3 c3, float3 c4) {
  t *= 0.15;
  float g = clamp(length(uv - 0.5) * 2.0 / 1.2, 0.0, 1.0);
  float n = noise(uv * 3.0 + t * 0.4) + noise(uv * 2.5 - t * 0.3 + 50.0) - 1.0;
  return steps4(1.0 - clamp(g + n * 0.15 * warp * sstep(1.0, 0.6, g), 0.0, 1.0), c1, c2, c3, c4);
}

float3 fxThermal(float2 uv, float t, float warp, float3 c1, float3 c2, float3 c3, float3 c4) {
  t *= 0.15;
  float light = 0.0;
  for (int k = 0; k < 2; k++) {
    float fk = float(k);
    float x = uv.x * (1.0 + fk * 0.4) + fk * 5.3;
    float mid = mix(0.62, 0.34, fk)
      + (mix(0.12, 0.08, fk) * sin(x * 2.0 + t * (0.8 + fk * 0.3) + fk * 2.0)
      + 0.04 * sin(x * 4.7 - t * 1.2 + fk)
      + 0.07 * (noise(float2(x * 1.4, t * 0.3 + fk * 4.0)) - 0.5)) * warp;
    float thick = mix(0.13, 0.09, fk) * (0.75 + 0.5 * noise(float2(x * 1.8 - t * 0.3, fk * 5.0)));
    float d = mid - uv.y;
    float ray = 0.75 + 0.5 * noise(float2(x * 9.0 + t * 0.5, fk * 9.0));
    float up = thick * 1.6 * ray, down = thick * 0.7;
    float body = d > 0.0 ? exp(-pow(d / up, 1.6)) : exp(-pow(abs(d) / down, 2.0));
    float fold = 0.8 + 0.2 * noise(float2(x * 2.2 - t * 0.4, fk * 6.0));
    light = 1.0 - (1.0 - light) * (1.0 - clamp(body * fold * mix(1.0, 0.6, fk), 0.0, 1.0));
  }
  return steps4(light, c1, c2, c3, c4);
}

float topoFbm(float2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { p = rot2(p, 0.6); v += a * noise(p); p *= 2.0; a *= 0.5; }
  return v;
}
float3 fxTopo(float2 uv, float t, float warp, float3 line, float3 fillC, float3 ground) {
  t *= 0.15;
  float2 p = uv * 1.6;
  p += float2(topoFbm(p + t * 0.3), topoFbm(p + float2(5.2, 1.3) + t * 0.2)) * 0.3 * warp;
  float e = topoFbm(p + t * 0.1), se = e * 6.0;
  float ld = min(fract(se), 1.0 - fract(se));
  float l = 1.0 - sstep(0.04, 0.14, ld);
  float3 fill = mix(ground, fillC, e * 0.6);
  return mix(fill, line, l);
}

float3 effect(float2 uv, float2 ua, constant Uniforms &u) {
  float3 c1 = u.col1.xyz, c2 = u.col2.xyz, c3 = u.col3.xyz, c4 = u.col4.xyz;
  if (u.fx < 0.5) return fxLinear(uv, u.t, u.warp, u.angle, c1, c2, c3, c4);
  if (u.fx < 1.5) return fxThermal(ua, u.t, u.warp, c1, c2, c3, c4);
  if (u.fx < 2.5) return fxTopo(uv, u.t, u.warp, c1, c2, c3);
  if (u.fx < 3.5) return fxPlasma(uv, u.t, u.warp, c1, c2, c3, c4);
  return fxRadial(uv, u.t, u.warp, c1, c2, c3, c4);
}

fragment float4 avatar_fragment(float4 position [[position]], constant Uniforms &u [[buffer(0)]]) {
  float2 px = position.xy;
  float r = u.size.x * 0.5;
  float2 uv = (px - r) / (r * 2.0 * u.scale) + 0.5;
  // Each seed sees its own part of the pattern. Thermal only slides
  // sideways and zooms, so it stays upright.
  float2 ua = (uv - 0.5) / u.layout.w + 0.5 + float2(u.layout.x, 0.0);
  uv = rot2(uv - 0.5, u.layout.z) / u.layout.w + 0.5 + u.layout.xy;
  float3 c = effect(uv, ua, u);
  c += rfFilmGrain(px, c, u) * u.grain;
  c = clamp(c, 0.0, 1.0);
  if (u.mono > 0.5) c = float3(dot(c, float3(0.299, 0.587, 0.114)));
  return float4(c, 1.0);
}
"""
#endif
