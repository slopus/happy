/*
 * The fragment shader below is ported from Paper's Liquid Metal
 * (https://github.com/paper-design/shaders, packages/shaders/src/shaders/
 * liquid-metal.ts at e7003a2, @paper-design/shaders 0.0.82, with
 * simplexNoise, rotation2 and colorBandingFix from shader-utils.ts and the
 * image sizing from vertex-shader.ts). Its mask preprocessing
 * (toProcessedLiquidMetal, in the same file) is run ahead of time by
 * scripts/liquid-metal/cloud.py, which wrote cloud_liquid_metal.png.
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
 * Changes from the original: GLSL ES 3.0 to AGSL; only an image mask, with
 * Paper's default preset (fit contain, scale 1, no rotation or offset,
 * speed 1, repetition 2, softness 0.1, shiftRed 0.3, shiftBlue 0.3,
 * distortion 0.07, contour 0.4, angle 70) fixed in the source and a
 * transparent background; the mask's edge field, which never moves, worked
 * out once, ahead of time, blurred and raised to 1.6 as blurEdge3x3 and the
 * line after it do; fwidth, which AGSL lacks, replaced by the stripes'
 * differences one pixel right and one down, taken before fract so its wrap
 * is not an edge; pixels outside the mark return at once; the banding
 * dither scaled by the mark's opacity, so the square around it stays clear.
 * happy-ios's LiquidMetalView.swift is the same port in Metal.
 */
package com.slopus.happy.ui.start

import android.content.res.Resources
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.RuntimeShader
import android.graphics.Shader
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.compose.animation.core.withInfiniteAnimationFrameNanos
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.slopus.happy.R
import com.slopus.happy.ui.components.rememberReduceMotion
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object LiquidMetalTags {
    const val SHADER = "liquidMetal.shader"
    const val FALLBACK = "liquidMetal.fallback"
}

/**
 * The Happy Cloud mark (a cloud with the Happy H cut out of it) in Paper's
 * Liquid Metal: chrome stripes that flow over it, bending at its edges. It
 * fills [modifier]'s square (a wider or taller box centres it) and draws
 * nothing around it, so it sits on any background; happy-ios's
 * `LiquidMetalView` is the same mark.
 *
 * It moves at Paper's default speed, a frame on every one of the display's
 * (120 a second on the Fold), while the screen is resumed and not [paused],
 * and holds still while covered, in the background, or with animations
 * removed (Paper's frame 0 then). Only its own box is drawn and the mask's
 * edge field comes baked (`cloud_liquid_metal.png`, decoded once off the main
 * thread), so a frame is one texture read and the stripes' arithmetic per
 * pixel, three times over for the stripes' fwidth. Until the
 * field is decoded and the program compiled (once for the app, also off
 * the main thread, [LiquidMetalProgram]), and before Android 13, which has
 * no runtime shader, the cloud stands still in [fallbackColor].
 */
@Composable
fun LiquidMetalMark(modifier: Modifier = Modifier, paused: Boolean = false, fallbackColor: Color = Color.Gray) {
    val shader = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) rememberLiquidMetalShader() else null
    val field = rememberLiquidMetalField()
    if (shader != null && field != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        ShaderLiquidMetal(shader, field, paused, modifier)
    } else {
        Image(
            painter = painterResource(R.drawable.cloud_mark),
            contentDescription = null,
            colorFilter = ColorFilter.tint(fallbackColor),
            modifier = modifier.testTag(LiquidMetalTags.FALLBACK),
        )
    }
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
@Composable
private fun ShaderLiquidMetal(shader: RuntimeShader, field: BitmapShader, paused: Boolean, modifier: Modifier) {
    // Nanoseconds moved, summed whole so the clock's rate holds however long it runs.
    val elapsed = remember { mutableLongStateOf(0L) }
    val reduceMotion = rememberReduceMotion()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle, reduceMotion, paused) {
        if (reduceMotion) {
            elapsed.longValue = 0L
            return@LaunchedEffect
        }
        if (paused) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            // Time stands still while paused; it picks up where it stopped.
            var last = withInfiniteAnimationFrameNanos { it }
            while (true) {
                withInfiniteAnimationFrameNanos { now ->
                    elapsed.longValue += now - last
                    last = now
                }
            }
        }
    }
    Box(
        modifier.testTag(LiquidMetalTags.SHADER).drawBehind {
            shader.setInputBuffer("u_image", field)
            shader.setFloatUniform("u_resolution", size.width, size.height)
            shader.setFloatUniform("u_time", (elapsed.longValue / 1_000_000_000.0).toFloat())
            drawRect(ShaderBrush(shader))
        },
    )
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
@Composable
private fun rememberLiquidMetalShader(): RuntimeShader? {
    var shader by remember { mutableStateOf(LiquidMetalProgram.now) }
    LaunchedEffect(Unit) {
        if (shader == null) shader = withContext(Dispatchers.Default) { LiquidMetalProgram.get() }
    }
    return shader
}

/**
 * The mark's program, compiled the first time any mark asks, off the main
 * thread, and shared: every mark sets its uniforms just before it draws.
 */
@RequiresApi(Build.VERSION_CODES.TIRAMISU)
internal object LiquidMetalProgram {
    @Volatile
    var now: RuntimeShader? = null
        private set
    private var tried = false

    @Synchronized
    fun get(): RuntimeShader? {
        if (tried) return now
        tried = true
        now = try {
            RuntimeShader(LIQUID_METAL_AGSL)
        } catch (e: RuntimeException) {
            // A device whose compiler refuses the source gets the still cloud.
            Log.w("LiquidMetal", "Liquid Metal shader unavailable", e)
            null
        } catch (e: LinkageError) {
            // Robolectric without native graphics.
            null
        }
        return now
    }
}

/** The cloud's field, decoded off the main thread the first time any mark asks; null until then. */
@Composable
private fun rememberLiquidMetalField(): BitmapShader? {
    val resources = LocalContext.current.resources
    var field by remember { mutableStateOf(LiquidMetalField.cached) }
    LaunchedEffect(Unit) {
        if (field == null) field = withContext(Dispatchers.Default) { LiquidMetalField.load(resources) }
    }
    return field
}

internal object LiquidMetalField {
    /** Pixels a side, as cloud.py writes it. */
    const val SIZE = 512

    @Volatile
    var cached: BitmapShader? = null
        private set

    /** Red the edge, green the mask's alpha, read raw ([RuntimeShader.setInputBuffer]) and filtered. */
    fun load(resources: Resources): BitmapShader? = cached ?: try {
        val options = BitmapFactory.Options().apply {
            inScaled = false
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        BitmapFactory.decodeResource(resources, R.drawable.cloud_liquid_metal, options)?.let { bitmap ->
            bitmap.prepareToDraw()
            BitmapShader(bitmap, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).also {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) it.filterMode = BitmapShader.FILTER_MODE_LINEAR
                cached = it
            }
        }
    } catch (e: RuntimeException) {
        Log.w("LiquidMetal", "Liquid Metal field unavailable", e)
        null
    }
}

/** Paper's liquid-metal.ts fragment shader, image branch, with v_imageUV for fit contain worked out per pixel. */
internal const val LIQUID_METAL_AGSL = """
uniform shader u_image;
uniform float2 u_resolution;
uniform float u_time;

const float PI = 3.14159265358979323846;
const float FIELD = 512.;

const float REPETITION = 2.;
const float SOFTNESS = .1;
const float SHIFT_RED = .3;
const float SHIFT_BLUE = .3;
const float DISTORTION = .07;
const float CONTOUR = .4;
const float ANGLE = 70.;
// colorTint white at full strength: color burn by white changes nothing.
const float3 TINT = float3(1.);
const float TINT_ALPHA = 1.;

float2 rotate(float2 uv, float th) {
  return float2x2(cos(th), sin(th), -sin(th), cos(th)) * uv;
}

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

float getColorChanges(float c1, float c2, float stripe_p, float3 w, float blur, float bump, float tint) {
  float ch = mix(c2, c1, smoothstep(.0, 2. * blur, stripe_p));

  float border = w[0];
  ch = mix(ch, c2, smoothstep(border, border + 2. * blur, stripe_p));

  bump = smoothstep(.2, .8, bump);
  border = w[0] + .4 * (1. - bump) * w[1];
  ch = mix(ch, c1, smoothstep(border, border + 2. * blur, stripe_p));

  border = w[0] + .5 * (1. - bump) * w[1];
  ch = mix(ch, c2, smoothstep(border, border + 2. * blur, stripe_p));

  border = w[0] + w[1];
  ch = mix(ch, c1, smoothstep(border, border + 2. * blur, stripe_p));

  float gradient_t = (stripe_p - w[0] - w[1]) / w[2];
  float gradient = mix(c1, c2, smoothstep(0., 1., gradient_t));
  ch = mix(ch, gradient, smoothstep(border, border + .5 * blur, stripe_p));

  // Tint color is applied with color burn blending
  ch = mix(ch, 1. - min(1., (1. - ch) / max(tint, 0.0001)), TINT_ALPHA);
  return ch;
}

// v_imageUV for a square image, fit contain, scale 1: the shorter side's
// square, centred, y down.
float2 imageUv(float2 fragCoord) {
  return (fragCoord - .5 * u_resolution) / min(u_resolution.x, u_resolution.y) + .5;
}

float diagonal(float2 uv) {
  float angle = (-ANGLE + 70.) * PI / 180.;
  float2 r = rotate(uv - .5, angle) + .5;
  return r.x - r.y;
}

// The three stripes' phases before fract (red, green, blue) at a pixel,
// with what colouring them needs: the edge after the noise, the bump as
// the strips' widths read it (bump0) and as everything after does.
float3 stripes(float2 uv, float t, out float edge, out float bump0, out float bump) {
  float cycleWidth = REPETITION;

  // blurEdge3x3 and pow(edge, 1.6) are baked into the field's red.
  edge = u_image.eval(clamp(uv, 0., 1.) * FIELD).r;
  edge *= mix(0.0, 1.0, smoothstep(0.0, 0.4, CONTOUR));

  float diagBLtoTR = diagonal(uv);

  float2 grad_uv = uv - .5;
  float dist = length(grad_uv + float2(0., .2 * diagBLtoTR));
  grad_uv = rotate(grad_uv, (.25 - .2 * diagBLtoTR) * PI);
  float direction = grad_uv.x;

  bump = pow(1.8 * dist, 1.2);
  bump = 1. - bump;
  bump *= pow(max(uv.y, 0.), .3);
  bump0 = bump;

  float noise = snoise(uv - t);

  edge += (1. - edge) * DISTORTION * noise;

  direction += diagBLtoTR;
  direction -= 2. * noise * diagBLtoTR * (smoothstep(0., 1., edge) * (1.0 - smoothstep(0., 1., edge)));
  // u_contour range 2
  direction *= mix(1., 1. - edge, smoothstep(.5, 1., CONTOUR));
  direction -= 1.7 * edge * smoothstep(.5, 1., CONTOUR);
  direction += .2 * pow(CONTOUR, 4.) * (1.0 - smoothstep(0., 1., edge));

  bump *= clamp(pow(max(uv.y, 0.), .1), .3, 1.);
  direction *= (.1 + (1.1 - edge) * bump);

  direction *= (.4 + .6 * (1.0 - smoothstep(.5, 1., edge)));
  direction += .18 * (smoothstep(.1, .2, uv.y) * (1.0 - smoothstep(.2, .4, uv.y)));
  direction += .03 * (smoothstep(.1, .2, 1. - uv.y) * (1.0 - smoothstep(.2, .4, 1. - uv.y)));

  direction *= (.5 + .5 * pow(uv.y, 2.));
  direction *= cycleWidth;
  direction -= t;

  float colorDispersion = clamp(1. - bump, 0., 1.);
  float dispersionRed = colorDispersion;
  dispersionRed += .03 * bump * noise;
  dispersionRed += 5. * (smoothstep(-.1, .2, uv.y) * (1.0 - smoothstep(.1, .5, uv.y))) * (smoothstep(.4, .6, bump) * (1.0 - smoothstep(.4, 1., bump)));
  dispersionRed -= diagBLtoTR;

  float dispersionBlue = colorDispersion;
  dispersionBlue *= 1.3;
  dispersionBlue += (smoothstep(0., .4, uv.y) * (1.0 - smoothstep(.1, .8, uv.y))) * (smoothstep(.4, .6, bump) * (1.0 - smoothstep(.4, .8, bump)));
  dispersionBlue -= .2 * edge;

  dispersionRed *= (SHIFT_RED / 20.);
  dispersionBlue *= (SHIFT_BLUE / 20.);

  return float3(direction + dispersionRed, direction, direction - dispersionBlue);
}

half4 main(float2 fragCoord) {
  float2 uv = imageUv(fragCoord);
  // getImgFrame(v_imageUV, 0.) and the mask: nothing outside the mark.
  float opacity = u_image.eval(clamp(uv, 0., 1.) * FIELD).g;
  if (uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1. || opacity <= 0.) return half4(0.);

  const float firstFrameOffset = 2.8;
  float t = .3 * (u_time + firstFrameOffset);
  float cycleWidth = REPETITION;

  float edge, bump0, bump, e1, b1, c1;
  float3 phase = stripes(uv, t, edge, bump0, bump);
  // fwidth: the phases one pixel right and one down.
  float px = 1. / min(u_resolution.x, u_resolution.y);
  float3 fw = abs(stripes(uv + float2(px, 0.), t, e1, b1, c1) - phase) + abs(stripes(uv + float2(0., px), t, e1, b1, c1) - phase);

  float diagBLtoTR = diagonal(uv);
  float angle = (-ANGLE + 70.) * PI / 180.;
  float2 rotatedUV = rotate(uv - .5, angle) + .5;
  float diagTLtoBR = rotatedUV.x + rotatedUV.y;

  float3 color1 = float3(.98, 0.98, 1.);
  float3 color2 = float3(.1, .1, .1 + .1 * smoothstep(.7, 1.3, diagTLtoBR));

  float thin_strip_1_ratio = .12 / cycleWidth * (1. - .4 * bump0);
  float thin_strip_2_ratio = .07 / cycleWidth * (1. + .4 * bump0);
  float wide_strip_ratio = (1. - thin_strip_1_ratio - thin_strip_2_ratio);
  float thin_strip_1_width = cycleWidth * thin_strip_1_ratio;
  float thin_strip_2_width = cycleWidth * thin_strip_2_ratio;

  float softness = 0.05 * SOFTNESS;
  float blur = softness + .5 * smoothstep(1., 10., REPETITION) * smoothstep(.0, 1., edge);
  float smallCanvasT = 1.0 - smoothstep(100., 500., min(u_resolution.x, u_resolution.y));
  blur += smallCanvasT * smoothstep(.0, 1., edge);
  float rExtraBlur = softness * (0.05 + .1 * (SHIFT_RED / 20.) * bump);
  float gExtraBlur = softness * 0.05 / max(0.001, abs(1. - diagBLtoTR));

  float3 w = float3(thin_strip_1_width, thin_strip_2_width, wide_strip_ratio);
  w[1] -= .02 * smoothstep(.0, 1., edge + bump);
  float r = getColorChanges(color1.r, color2.r, fract(phase.r), w, blur + fw.r + rExtraBlur, bump, TINT.r);
  float g = getColorChanges(color1.g, color2.g, fract(phase.g), w, blur + fw.g + gExtraBlur, bump, TINT.g);
  float b = getColorChanges(color1.b, color2.b, fract(phase.b), w, blur + fw.b, bump, TINT.b);

  float3 color = float3(r, g, b) * opacity;
  color += opacity / 256. * (fract(sin(dot(.014 * fragCoord, float2(12.9898, 78.233))) * 43758.5453123) - .5);
  return half4(half3(color), half(opacity));
}
"""
