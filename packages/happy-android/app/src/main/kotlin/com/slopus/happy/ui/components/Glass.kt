package com.slopus.happy.ui.components

import android.content.Context
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.Stable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.slopus.happy.BuildConfig
import java.io.File
import kotlin.math.ceil

/**
 * Frosted glass over scrolling content, hand-rolled on [GraphicsLayer]
 * (RenderNodes): the content records itself into one layer ([glassSource]),
 * drawn as usual; each glass surface ([glass], [glassFade]) draws that same
 * layer again, the part under it only, shrunk by [GlassSpec.downscale],
 * blurred and saturated there, then scaled back up under a tint and a
 * hairline. A layer drawn inside another stays live, so scrolling the content
 * re-blurs without the glass recording anything again. Blur needs
 * RenderEffect (API 31+); below that, or with [LocalGlassBlur] off, the glass
 * is its tint alone, nearly opaque.
 */
object GlassSpec {
    /** The blur runs on a copy this many times smaller; cheaper, and softer for it. */
    const val DOWNSCALE = 4f
    val blur = 24.dp
    const val SATURATION = 1.4f
    /** The tint over the blur; [FALLBACK_ALPHA] when there is no blur to see through. */
    const val ALPHA = 0.85f
    const val FALLBACK_ALPHA = 0.94f
    val hairline = 0.75.dp
    /** How far above what it backs the fade starts. */
    val fade = 32.dp
}

/** Whether this OS can blur at all (RenderEffect, API 31). */
fun glassBlurs(sdk: Int = Build.VERSION.SDK_INT): Boolean = sdk >= Build.VERSION_CODES.S

/**
 * Whether glass blurs here: [glassBlurs], and in a debug build not switched
 * off by a `files/glass-off` file (`adb shell run-as <app> touch files/glass-off`),
 * so a fling can be measured with and without it on one install.
 */
fun glassBlurEnabled(context: Context): Boolean =
    glassBlurs() && !(BuildConfig.DEBUG && File(context.filesDir, "glass-off").exists())

/** Off to draw every glass as its tint alone; tests set it to reach that path on any API. */
val LocalGlassBlur: ProvidableCompositionLocal<Boolean?> = compositionLocalOf { null }

@Composable
fun rememberGlassBlur(): Boolean {
    val forced = LocalGlassBlur.current
    val context = LocalContext.current
    return forced ?: remember(context) { glassBlurEnabled(context) }
}

/** One theme's glass: [tint] over the blur, and the [edge] hairline round it. */
@Immutable
data class GlassColors(val tint: Color, val edge: Color) {
    fun fill(blurs: Boolean): Color = tint.copy(alpha = if (blurs) GlassSpec.ALPHA else GlassSpec.FALLBACK_ALPHA)

    companion object {
        /** Light: a pale grey a shade under the page, a dark hairline; dark: lifted grey, a light one. */
        fun of(dark: Boolean): GlassColors =
            if (dark) GlassColors(tint = Color(0xFF2C2C2E), edge = Color.White.copy(alpha = 0.10f))
            else GlassColors(tint = Color(0xFFF2F2F4), edge = Color.Black.copy(alpha = 0.09f))
    }
}

/** What the glass shows through: the content's layer and where it sits. */
@Stable
class GlassSource internal constructor(internal val layer: GraphicsLayer) {
    internal var origin by mutableStateOf(Offset.Zero)
    internal var recorded by mutableStateOf(false)
}

@Composable
fun rememberGlassSource(): GlassSource {
    val layer = rememberGraphicsLayer()
    return remember(layer) { GlassSource(layer) }
}

/** Records this content for the glass over it, and draws it as usual. */
fun Modifier.glassSource(source: GlassSource): Modifier =
    onGloballyPositioned { source.origin = it.positionInRoot() }
        .drawWithContent {
            source.layer.record { this@drawWithContent.drawContent() }
            drawLayer(source.layer)
            if (!source.recorded) source.recorded = true
        }

/** A glass surface in [shape]: the blurred content under it, the tint, the hairline. */
fun Modifier.glass(source: GlassSource?, shape: Shape, colors: GlassColors, blurs: Boolean): Modifier = composed {
    val blurred = rememberGraphicsLayer()
    var origin by remember { mutableStateOf(Offset.Zero) }
    onGloballyPositioned { origin = it.positionInRoot() }
        .drawWithCache {
            val path = Path().apply { addOutline(shape.createOutline(size, layoutDirection, this@drawWithCache)) }
            val hairline = GlassSpec.hairline.toPx()
            val fill = colors.fill(blurs)
            onDrawBehind {
                if (blurs && source != null && source.recorded) {
                    blurred.recordBlurOf(this, source, origin - source.origin, size)
                    clipPath(path) { drawBlurred(blurred) }
                }
                drawPath(path, fill)
                drawPath(path, colors.edge, style = Stroke(hairline))
            }
        }
}

/**
 * The band behind a bottom dock: the content blurred and tinted like the
 * glass, fading in over its top [GlassSpec.fade] so what scrolls under it
 * goes soft and pale instead of meeting an edge.
 */
fun Modifier.glassFade(source: GlassSource?, tint: Color, blurs: Boolean): Modifier = composed {
    val blurred = rememberGraphicsLayer()
    var origin by remember { mutableStateOf(Offset.Zero) }
    onGloballyPositioned { origin = it.positionInRoot() }
        .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
        .drawBehind {
            if (blurs && source != null && source.recorded) {
                blurred.recordBlurOf(this, source, origin - source.origin, size)
                drawBlurred(blurred)
            }
            drawRect(tint.copy(alpha = if (blurs) GlassSpec.ALPHA else GlassSpec.FALLBACK_ALPHA))
            val fade = (GlassSpec.fade.toPx() / size.height).coerceIn(0f, 1f)
            // Eased in, as a straight ramp reads as a band.
            drawRect(
                Brush.verticalGradient(
                    0f to Color.Transparent,
                    fade * 0.35f to Color.Black.copy(alpha = 0.38f),
                    fade * 0.7f to Color.Black.copy(alpha = 0.7f),
                    fade to Color.Black,
                    1f to Color.Black,
                ),
                blendMode = BlendMode.DstIn,
            )
        }
}

private val saturate = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(GlassSpec.SATURATION) })

/** Records the part of [source] at [offset] under a [size] glass, shrunk and blurred. */
private fun GraphicsLayer.recordBlurOf(scope: DrawScope, source: GlassSource, offset: Offset, size: Size) {
    val k = GlassSpec.DOWNSCALE
    val radius = with(scope) { GlassSpec.blur.toPx() } / k
    if (renderEffect == null) {
        renderEffect = BlurEffect(radius, radius, TileMode.Clamp)
        colorFilter = saturate
    }
    with(scope) {
        this@recordBlurOf.record(IntSize(ceil(size.width / k).toInt().coerceAtLeast(1), ceil(size.height / k).toInt().coerceAtLeast(1))) {
            scale(1 / k, 1 / k, pivot = Offset.Zero) {
                translate(-offset.x, -offset.y) { drawLayer(source.layer) }
            }
        }
    }
}

private fun DrawScope.drawBlurred(blurred: GraphicsLayer) {
    scale(GlassSpec.DOWNSCALE, GlassSpec.DOWNSCALE, pivot = Offset.Zero) { drawLayer(blurred) }
}
