/*
 * The fragment shader below is ported from Paper's Grain Gradient
 * (https://github.com/paper-design/shaders, packages/shaders/src/shaders/
 * grain-gradient.ts, with simplexNoise, rotation2 and proceduralHash21 from
 * shader-utils.ts and the object sizing from vertex-shader.ts).
 *
 * Its NOTICE file reads:
 *
 *     Powered by Paper Shaders:
 *     https://shaders.paper.design
 *
 * Paper Shaders is licensed under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the
 * License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 *
 * Changes from the original: GLSL ES 3.0 to AGSL; only the "corners" shape,
 * with Paper's defaults (fit contain, scale 1, no rotation or offset,
 * speed 1, softness 0.5, intensity 0.5, noise 0.25, four colours) fixed in
 * the source; the noise texture behind randomR replaced by Paper's
 * proceduralHash21 over the same 100-cell period; fwidth, which AGSL lacks,
 * replaced by forward differences of the grain one pixel right and one down.
 */
package com.slopus.happy.ui.start

import android.graphics.RuntimeShader
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.compose.animation.core.withInfiniteAnimationFrameNanos
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.slopus.happy.ui.components.rememberReduceMotion
import kotlin.math.max

/** The background colour and the four colours Grain Gradient blends, in Paper's order. */
@Immutable
data class GrainPalette(val back: Color, val colors: List<Color>) {
    init {
        require(colors.size == 4) { "Grain Gradient takes four colours" }
    }
}

object GrainGradientTags {
    const val SHADER = "grainGradient.shader"
    const val FALLBACK = "grainGradient.fallback"
}

/**
 * Paper's Grain Gradient, "corners" shape, behind [modifier]'s bounds. It
 * moves at Paper's default speed while the screen is resumed, at most
 * [FRAME_NANOS] apart, and holds still while covered, in the background,
 * or with animations removed (the first frame then, as Paper's frame 0).
 * Before Android 13 there is no runtime shader: a still gradient in the
 * same colours stands in.
 */
@Composable
fun GrainGradient(palette: GrainPalette, modifier: Modifier = Modifier) {
    val shader = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) rememberGrainShader() else null
    if (shader != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        ShaderGrainGradient(shader, palette, modifier)
    } else {
        Box(modifier.testTag(GrainGradientTags.FALLBACK).drawBehind { drawFallback(palette) })
    }
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
@Composable
private fun ShaderGrainGradient(shader: RuntimeShader, palette: GrainPalette, modifier: Modifier) {
    val time = remember { mutableFloatStateOf(0f) }
    val reduceMotion = rememberReduceMotion()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle, reduceMotion) {
        if (reduceMotion) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            // Time stands still while paused; it picks up where it stopped.
            var last = withInfiniteAnimationFrameNanos { it }
            while (true) {
                withInfiniteAnimationFrameNanos { now ->
                    if (now - last >= FRAME_NANOS) {
                        time.floatValue += (now - last) / 1_000_000_000f
                        last = now
                    }
                }
            }
        }
    }
    Box(
        modifier.testTag(GrainGradientTags.SHADER).drawBehind {
            shader.setFloatUniform("u_resolution", size.width, size.height)
            shader.setFloatUniform("u_time", time.floatValue)
            shader.setColorUniform("u_colorBack", palette.back.toArgb())
            palette.colors.forEachIndexed { i, color -> shader.setColorUniform("u_color$i", color.toArgb()) }
            drawRect(ShaderBrush(shader))
        },
    )
}

/** About 30 frames a second: Paper's default speed moves slowly enough. */
private const val FRAME_NANOS = 33_000_000L

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
@Composable
private fun rememberGrainShader(): RuntimeShader? = remember {
    try {
        RuntimeShader(GRAIN_GRADIENT_AGSL)
    } catch (e: RuntimeException) {
        // A device whose compiler refuses the source gets the still gradient.
        Log.w("GrainGradient", "Grain Gradient shader unavailable", e)
        null
    } catch (e: LinkageError) {
        // Robolectric without native graphics.
        null
    }
}

/** The still stand-in: the background with each colour glowing in from a corner, as "corners" does. */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawFallback(palette: GrainPalette) {
    drawRect(palette.back)
    val radius = max(size.width, size.height) * 0.75f
    val corners = listOf(
        Offset(0f, size.height),
        Offset(size.width, 0f),
        Offset(0f, size.height * 0.6f),
        Offset(size.width, size.height * 0.35f),
    )
    palette.colors.zip(corners).forEach { (color, center) ->
        drawRect(Brush.radialGradient(listOf(color.copy(alpha = 0.7f), Color.Transparent), center, radius))
    }
}

/**
 * Paper's grain-gradient.ts fragment shader for the "corners" shape (4),
 * with Paper's v_objectUV for fit contain worked out per pixel.
 */
internal const val GRAIN_GRADIENT_AGSL = """
uniform float2 u_resolution;
uniform float u_time;
layout(color) uniform half4 u_colorBack;
layout(color) uniform half4 u_color0;
layout(color) uniform half4 u_color1;
layout(color) uniform half4 u_color2;
layout(color) uniform half4 u_color3;

const float COUNT = 4.;
const float SOFTNESS = .5;
const float INTENSITY = .5;
const float NOISE = .25;

float3 permute(float3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }

float snoise(float2 v) {
  const float4 C = float4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  float2 i = floor(v + dot(v, C.yy));
  float2 x0 = v - i + dot(i, C.xx);
  float2 i1 = (x0.x > x0.y) ? float2(1.0, 0.0) : float2(0.0, 1.0);
  float4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  float3 p = permute(permute(i.y + float3(0.0, i1.y, 1.0)) + i.x + float3(0.0, i1.x, 1.0));
  float3 m = max(0.5 - float3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  float3 x = 2.0 * fract(p * C.www) - 1.0;
  float3 h = abs(x) - 0.5;
  float3 ox = floor(x + 0.5);
  float3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  float3 g = float3(0.);
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float2 rotate(float2 uv, float th) {
  return float2x2(cos(th), sin(th), -sin(th), cos(th)) * uv;
}

float hash21(float2 p) {
  p = fract(p * float2(0.3183099, 0.3678794)) + 0.1;
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

// textureRandomizerR: one value per whole cell, repeating every 100 cells.
float randomR(float2 p) {
  return hash21(mod(floor(p), 100.));
}

float valueNoiseR(float2 st) {
  float2 i = floor(st);
  float2 f = fract(st);
  float a = randomR(i);
  float b = randomR(i + float2(1.0, 0.0));
  float c = randomR(i + float2(0.0, 1.0));
  float d = randomR(i + float2(1.0, 1.0));
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// One channel of fbmR: its four channels never mix, so each is its own sum.
float fbm(float2 n) {
  float amplitude = 0.2;
  float total = 0.;
  for (int i = 0; i < 3; i++) {
    n = rotate(n, 0.3);
    total += valueNoiseR(n) * amplitude;
    n *= 1.99;
    amplitude *= 0.6;
  }
  return total;
}

// What the grain adds to the shape at g. fbmR's x, y and the first half of
// its z change too slowly to differ between neighbouring pixels, so they
// come in worked out once ([slow]); fbmR's w is never written, so 0.
float grain(float2 g, float3 slow) {
  float baseNoise = snoise(g * .5);
  float grainDist = baseNoise * snoise(g * .2) - slow.x - slow.y;
  float rawNoise = .75 * baseNoise - (slow.z + fbm(rotate(.4 * g, 2.)));
  float noise = clamp(rawNoise, 0., 1.);
  return INTENSITY * 2. / COUNT * (grainDist + .5) + NOISE * 10. / COUNT * noise;
}

float band(float mixer, float aa) {
  return smoothstep(.5 - .5 * SOFTNESS - aa, .5 + .5 * SOFTNESS + aa, clamp(mixer, 0., 1.));
}

half4 main(float2 fragCoord) {
  float t = .1 * (u_time + 7.);

  // v_objectUV for fit contain: a square box the size of the shorter side,
  // centred, y up.
  float box = min(u_resolution.x, u_resolution.y);
  float2 uv = fragCoord / u_resolution - .5;
  uv.y = -uv.y;
  float2 shape_uv = uv * u_resolution / box;
  float2 grain_uv = shape_uv * box * .7;

  // Corners
  shape_uv *= .6;
  float2 outer = float2(.5);
  float2 bl = smoothstep(float2(0.), outer, shape_uv + float2(.1 + .1 * sin(3. * t), .2 - .1 * sin(5.25 * t)));
  float2 tr = smoothstep(float2(0.), outer, 1. - shape_uv);
  float shape = 1. - bl.x * bl.y * tr.x * tr.y;
  shape_uv = -shape_uv;
  bl = smoothstep(float2(0.), outer, shape_uv + float2(.1 + .1 * sin(3. * t), .2 - .1 * cos(5.25 * t)));
  tr = smoothstep(float2(0.), outer, 1. - shape_uv);
  shape -= bl.x * bl.y * tr.x * tr.y;
  shape = 1. - smoothstep(0., 1., shape);

  float3 slow = float3(fbm(.002 * grain_uv + 10.), fbm(.003 * grain_uv), fbm(.001 * grain_uv));
  float added = grain(grain_uv, slow);
  shape += added;

  // fwidth(shape): the grain one pixel right and one pixel down (y is up
  // in grain_uv); the corners themselves barely change over a pixel.
  float aa = abs(grain(grain_uv + float2(.7, 0.), slow) - added) + abs(grain(grain_uv - float2(0., .7), slow) - added);

  shape = clamp(shape - .5 / COUNT, 0., 1.);
  float totalShape = smoothstep(0., SOFTNESS + 2. * aa, clamp(shape * COUNT, 0., 1.));
  float mixer = shape * (COUNT - 1.);

  half4 gradient = u_color0;
  gradient = mix(gradient, u_color1, band(mixer, aa));
  gradient = mix(gradient, u_color2, band(mixer - 1., aa));
  gradient = mix(gradient, u_color3, band(mixer - 2., aa));

  half3 color = gradient.rgb * totalShape + u_colorBack.rgb * (1. - totalShape);
  return half4(color, 1.);
}
"""
