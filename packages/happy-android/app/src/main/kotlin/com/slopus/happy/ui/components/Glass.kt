package com.slopus.happy.ui.components

import android.content.Context
import android.os.Build
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.State
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
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.toRect
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.inset
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.isSpecified
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.toSize
import com.slopus.happy.BuildConfig
import com.slopus.happy.ui.FirstFrame
import java.io.File
import kotlin.math.ceil
import kotlin.math.floor

/**
 * Frosted glass over scrolling content, hand-rolled on [GraphicsLayer]
 * (RenderNodes): the content records itself into one layer ([glassSource]),
 * drawn as usual; each glass surface ([glass], [glassFade], [glassBar]) paints
 * the source's ground, then draws that same layer again, the part round it
 * only, at full size and slightly softened, then shrunk by
 * [GlassSpec.DOWNSCALE], blurred and saturated there, scaled
 * back up under a tint. A layer drawn inside another stays live, so scrolling
 * the content re-blurs without the glass recording anything again. Blur needs
 * RenderEffect (API 31+); below that, or with [LocalGlassBlur] off, the glass
 * is its tint over the ground alone, opaque.
 *
 * The numbers are Telegram's frosted glass (13.1.1, blur3's
 * DownscaleScrollableNoiseSuppressor and BlurredBackgroundProviderImpl; see
 * research/telegram-glass.md): an eighth-size copy, a 40 dp blur, saturation
 * tripled, and the page's colour over it at 216/255 in light and 178/255
 * in dark (bars; floating glass keeps 0.85 in dark, for contrast).
 */
object GlassSpec {
    /** The blur runs on a copy this many times smaller; cheaper, and softer for it. */
    const val DOWNSCALE = 8f
    /** The blur's radius at full size; [downscaledRadius] keeps it that wide on the small copy. */
    val blur = 40.dp
    const val SATURATION = 3f
    /**
     * Floating glass's tint over the blur, light and dark; [FALLBACK_ALPHA]
     * when there is no blur to see through. Telegram's dark is 0.76; 0.85
     * keeps the composer's placeholder at 4.5:1 over a white picture.
     */
    const val ALPHA = 216f / 255f
    const val ALPHA_DARK = 0.85f
    const val FALLBACK_ALPHA = 0.94f
    val hairline = 0.55.dp
    /** A bar's ground over the blur at its foot, light and dark: Telegram's chat list bar. */
    const val BAR_ALPHA = 216f / 255f
    const val BAR_ALPHA_DARK = 178f / 255f
    /**
     * A bar's ground over the status bar, nearly opaque: the screen's edge,
     * where content enters under the glass with the least blurred round it,
     * is the ground and not glass, as iOS 26's scroll edge and our iOS
     * header scrim (0.94) are. Below it [barAlpha] eases to the foot's.
     */
    const val BAR_EDGE_ALPHA = 0.96f

    /**
     * A bar's ground at [y] of its [height]: [BAR_EDGE_ALPHA] down to [edge]
     * (the status bar's foot), then smoothstep to [foot] at the bar's foot.
     * Flat at both ends of the ramp, so neither the status bar's foot nor the
     * bar's reads as a line; the title sits where it is still mostly ground,
     * the bar's lower part is clearly glass.
     */
    fun barAlpha(y: Float, edge: Float, height: Float, foot: Float): Float {
        if (height <= edge) return BAR_EDGE_ALPHA
        val t = ((y - edge) / (height - edge)).coerceIn(0f, 1f)
        return BAR_EDGE_ALPHA + (foot - BAR_EDGE_ALPHA) * smoothstep(t)
    }

    /**
     * How far a bar's glass runs on past its foot, fading out
     * ([featherAlpha]): iOS's chat header feathers over 24 pt, its home over
     * 36, Telegram's chat over 48 dp. Below the bar rather than in it, so the
     * controls' lower half keeps the bar's whole ground; a list keeps it
     * clear at rest ([GlassBarLayout]'s top), so only what scrolls up goes
     * under it.
     */
    val feather = 24.dp

    /**
     * How much of a bar's glass (ground, blur and tint alike) shows [t] of
     * the way through its [feather], from the bar's foot (0) to the
     * feather's end (1): all of it, then none, along a smoothstep, flat at
     * both ends so neither reads as a line.
     */
    fun featherAlpha(t: Float): Float = 1 - smoothstep(t.coerceIn(0f, 1f))

    private fun smoothstep(t: Float): Float = t * t * (3 - 2 * t)

    /**
     * How far down from the top of what it backs the fade ramps in. It starts
     * at that top, not above it, so content resting above a dock is never
     * under it (Telegram's lies inside its input zone).
     */
    val fade = 48.dp
    /**
     * How much content round a glass goes into its blur (Telegram records 48
     * dp round each glass), so what nears the glass glows into it before it
     * slides under, instead of the blur clamping at the glass's edge.
     */
    val capture = 48.dp

    /**
     * A blur [radius] for a copy [scale] times smaller that looks as wide as
     * [radius] at full size: through sigma (hwui's 1/sqrt(3) and 0.5), not
     * straight division, as Telegram's downscaleRadius does.
     */
    fun downscaledRadius(radius: Float, scale: Float): Float {
        val sigma = if (radius > 0) SIGMA_SCALE * radius + 0.5f else 0f
        val small = sigma / scale
        return maxOf(1f, if (small > 0.5f) (small - 0.5f) / SIGMA_SCALE else 0f)
    }

    /**
     * The blur radius, in pixels, that softens the full-size capture before it
     * is shrunk [scale] times: a sigma of half the small copy's pixel, so
     * shrinking it leaves nothing to alias and a line moving 1 px moves the
     * blur 1 px. Against the 40 dp blur it adds nothing you can see.
     */
    fun prefilterRadius(scale: Float): Float = (scale / 2 - 0.5f) / SIGMA_SCALE

    private const val SIGMA_SCALE = 0.57735f
}

/** Whether this OS can blur at all (RenderEffect, API 31). */
fun glassBlurs(sdk: Int = Build.VERSION.SDK_INT): Boolean = sdk >= Build.VERSION_CODES.S

/**
 * Whether glass blurs here: [glassBlurs], and in a debug build not switched
 * off by a `files/glass-off` file (`adb shell run-as <app> touch files/glass-off`),
 * so a fling can be measured with and without it on one install.
 */
fun glassBlurEnabled(context: Context): Boolean =
    glassBlurs() && !(BuildConfig.DEBUG && (glassOff ?: File(context.filesDir, "glass-off").exists().also { glassOff = it }))

/** The `glass-off` file, looked for once per process; the app graph's thread looks first, so the main thread doesn't. */
@Volatile private var glassOff: Boolean? = null

/** Off to draw every glass as its tint alone; tests set it to reach that path on any API. */
val LocalGlassBlur: ProvidableCompositionLocal<Boolean?> = compositionLocalOf { null }

@Composable
fun rememberGlassBlur(): Boolean {
    val forced = LocalGlassBlur.current
    val context = LocalContext.current
    // From the window's second frame (FirstFrame): the blur's layers would cost the first one.
    return forced ?: (remember(context) { glassBlurEnabled(context) } && FirstFrame.drawn)
}

/** One theme's glass: [tint] over the blur, and the [edge] hairline round it. */
@Immutable
data class GlassColors(val tint: Color, val edge: Color, val alpha: Float = GlassSpec.ALPHA) {
    fun fill(blurs: Boolean): Color = tint.copy(alpha = if (blurs) alpha else GlassSpec.FALLBACK_ALPHA)

    companion object {
        /**
         * Light: a pale grey a shade under the page, a dark hairline; dark:
         * lifted grey, Telegram's white hairline at 0x20.
         */
        fun of(dark: Boolean): GlassColors =
            if (dark) GlassColors(tint = Color(0xFF2C2C2E), edge = Color.White.copy(alpha = 0x20 / 255f), alpha = GlassSpec.ALPHA_DARK)
            else GlassColors(tint = Color(0xFFF2F2F4), edge = Color.Black.copy(alpha = 0.09f))
    }
}

/**
 * What the glass shows through: the content's layer, where it sits, and the
 * [ground] it is drawn on. Telegram's frosted source is the window's colour
 * with the blurred content over it (DialogsActivity's
 * `renderNodeUpdateDisplayList`: `drawColor(windowBackgroundWhite)`, then
 * the blur), so the glass is opaque and hides the sharp content under it.
 * The content's layer has no ground of its own (the screen paints it), so
 * the glass paints it: without it the blurred copy is nearly empty and the
 * sharp content shows through the tint.
 */
@Stable
class GlassSource internal constructor(internal val layer: GraphicsLayer) {
    internal var origin by mutableStateOf(Offset.Zero)
    internal var recorded by mutableStateOf(false)
    internal var ground by mutableStateOf(Color.Unspecified)
}

/** A source drawn on [ground], the screen's colour under the content; unspecified for content opaque itself. */
@Composable
fun rememberGlassSource(ground: Color = Color.Unspecified): GlassSource {
    val layer = rememberGraphicsLayer()
    return remember(layer) { GlassSource(layer) }.also { it.ground = ground }
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
    val layers = rememberGlassLayers()
    var origin by remember { mutableStateOf(Offset.Zero) }
    val at = rememberSourceOffset(source) { origin }
    onGloballyPositioned { origin = it.positionInRoot() }
        .drawWithCache {
            val path = Path().apply { addOutline(shape.createOutline(size, layoutDirection, this@drawWithCache)) }
            val hairline = GlassSpec.hairline.toPx()
            val fill = colors.fill(blurs)
            onDrawBehind {
                if (source != null) clipPath(path) { drawSource(layers, source, at.value, blurs) }
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
    val layers = rememberGlassLayers()
    var origin by remember { mutableStateOf(Offset.Zero) }
    val at = rememberSourceOffset(source) { origin }
    onGloballyPositioned { origin = it.positionInRoot() }
        .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
        .drawBehind {
            if (source != null) clipRect { drawSource(layers, source, at.value, blurs) }
            drawRect(tint.copy(alpha = if (blurs) glassAlpha(tint) else GlassSpec.FALLBACK_ALPHA))
            val fade = (GlassSpec.fade.toPx() / size.height).coerceIn(0f, 1f)
            // Telegram's fade (BlurredBackgroundWithFadeDrawable, opacity mode): 0, 0x60, 0xB0, 0xE8 of
            // 285 over its height, eased in as a straight ramp reads as a band. Below it Telegram holds
            // 0.81; this goes opaque, so nothing shows sharp beside a dock narrower than the window.
            drawRect(
                Brush.verticalGradient(
                    0f to Color.Transparent,
                    fade / 3 to Color.Black.copy(alpha = 0x60 / 285f),
                    fade * 2 / 3 to Color.Black.copy(alpha = 0xB0 / 285f),
                    fade to Color.Black.copy(alpha = 0xE8 / 285f),
                    1f to Color.Black,
                ),
                blendMode = BlendMode.DstIn,
            )
        }
}

/**
 * A top bar's glass ([GlassBarLayout]): the content under it blurred, then
 * [ground] over the blur, progressively: nearly opaque over the status bar
 * ([GlassSpec.BAR_EDGE_ALPHA]), easing to [GlassSpec.BAR_ALPHA] on a light
 * ground and [GlassSpec.BAR_ALPHA_DARK] on a dark one at the bar's foot
 * ([GlassSpec.barAlpha]); nearly opaque throughout where nothing blurs.
 *
 * [feathered], the glass runs on [GlassSpec.feather] past the bar's foot and
 * fades out there, the blurred content and the ground over it alike, through
 * one mask ([GlassSpec.featherAlpha]), as iOS's header scrim feathers its
 * blur and its fade together and Telegram masks its blurred fade: what
 * scrolls up goes soft gradually, with no edge and no hairline. At rest the
 * content's own ground is all that is under the bar, so bar and page are one
 * surface.
 *
 * A [backdrop] takes the ground's place: drawn opaque over the blur at the
 * glass's size (its feather included), it is given the ground's alphas, so it
 * is as see-through as the ground would be wherever it is.
 */
fun Modifier.glassBar(
    source: GlassSource?,
    ground: Color,
    blurs: Boolean,
    backdrop: (DrawScope.() -> Unit)? = null,
    feathered: Boolean = true,
): Modifier = composed {
    val layers = rememberGlassLayers()
    var origin by remember { mutableStateOf(Offset.Zero) }
    val at = rememberSourceOffset(source) { origin }
    val statusBar = WindowInsets.statusBars.getTop(LocalDensity.current)
    onGloballyPositioned { origin = it.positionInRoot() }
        .drawWithCache {
            val bar = size.height
            // Whole pixels, as the room GlassBarLayout keeps for it is.
            val feather = if (feathered) GlassSpec.feather.roundToPx().toFloat() else 0f
            // Where the status bar ends inside the bar; a bar lower on the screen has none.
            val edge = (statusBar - origin.y).coerceIn(0f, bar)
            val foot = if (ground.luminance() < DARK_LUMINANCE) GlassSpec.BAR_ALPHA_DARK else GlassSpec.BAR_ALPHA
            fun ramp(color: Color) = if (blurs) barRamp(color, edge, bar, foot) else SolidColor(color.copy(alpha = GlassSpec.FALLBACK_ALPHA))
            val tint = ramp(ground)
            val mask = ramp(Color.Black)
            val fade = if (feather > 0f) featherMask(bar, feather) else null
            onDrawBehind {
                // The glass is the bar and the feather under it.
                inset(0f, 0f, 0f, -feather) {
                    if (fade != null) drawIntoCanvas { it.saveLayer(size.toRect(), Paint()) }
                    // The blur spreads past the layer's edge: keep it to the glass.
                    if (source != null) clipRect { drawSource(layers, source, at.value, blurs) }
                    if (backdrop == null) {
                        drawRect(tint)
                    } else {
                        drawIntoCanvas { it.saveLayer(size.toRect(), Paint()) }
                        backdrop()
                        drawRect(mask, blendMode = BlendMode.DstIn)
                        drawIntoCanvas { it.restore() }
                    }
                    if (fade != null) {
                        drawRect(fade, blendMode = BlendMode.DstIn)
                        drawIntoCanvas { it.restore() }
                    }
                }
            }
        }
}

/**
 * [GlassSpec.featherAlpha] as a mask: whole down to the bar's foot at [bar],
 * clear [feather] below it, sampled as finely as [barRamp].
 */
private fun featherMask(bar: Float, feather: Float): Brush {
    val stops = (0..BAR_RAMP_STEPS).map { i ->
        val t = i.toFloat() / BAR_RAMP_STEPS
        t to Color.Black.copy(alpha = GlassSpec.featherAlpha(t))
    }
    return Brush.verticalGradient(*stops.toTypedArray(), startY = bar, endY = bar + feather)
}

/**
 * [GlassSpec.barAlpha] of [color] as a gradient: a stop at the bar's top and
 * at [edge], and the smoothstep sampled finely enough below it that the
 * straight pieces between stops don't show. Below the bar's foot it holds the
 * foot's alpha, for the feather to fade out.
 */
private fun barRamp(color: Color, edge: Float, height: Float, foot: Float): Brush {
    val stops = buildList {
        add(0f to color.copy(alpha = GlassSpec.BAR_EDGE_ALPHA))
        for (i in 0..BAR_RAMP_STEPS) {
            val y = edge + (height - edge) * i / BAR_RAMP_STEPS
            add(y / height to color.copy(alpha = GlassSpec.barAlpha(y, edge, height, foot)))
        }
    }
    return Brush.verticalGradient(*stops.toTypedArray(), startY = 0f, endY = height)
}

private const val BAR_RAMP_STEPS = 16

/** Below this a ground is dark (Telegram's perceived-brightness 0.721, as relative luminance). */
private const val DARK_LUMINANCE = 0.48f

/** A fade's tint over the blur: the floating glass's, by how dark [tint] is. */
private fun glassAlpha(tint: Color): Float = if (tint.luminance() < DARK_LUMINANCE) GlassSpec.ALPHA_DARK else GlassSpec.ALPHA

private val saturate = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(GlassSpec.SATURATION) })

/**
 * A glass's two layers: [capture], the content under it at full size and
 * softened by [GlassSpec.prefilterRadius], and [blurred], that shrunk and blurred.
 * They are recorded again only when the glass's [area] of the source moves:
 * they draw the source by reference, so when the content changes the
 * RenderThread blurs it again by itself, and when only something over the
 * glass redraws (a caret blinking, a button pressed) or the glass and the
 * content move together (the keyboard carrying the list and the dock), the
 * blur it made last is drawn again as it is.
 */
private class GlassLayers(val capture: GraphicsLayer, val blurred: GraphicsLayer) {
    var area: Rect? = null
    var radius = 0f
}

@Composable
private fun rememberGlassLayers(): GlassLayers {
    val capture = rememberGraphicsLayer()
    val blurred = rememberGraphicsLayer()
    return remember(capture, blurred) { GlassLayers(capture, blurred) }
}

/**
 * Records [area] of [source] (in the source's coordinates, whole pixels),
 * shrunk and blurred: DownscaleScrollableNoiseSuppressor's SourcePart, an
 * eighth of its size, blurred there, saturation chained after the blur.
 *
 * Unlike Telegram's, the content is not drawn at an eighth of its size: it
 * is drawn at full size into [GlassLayers.capture], softened there, and that
 * picture is shrunk. Drawn small, text is rasterised on the small copy's
 * grid and its glyphs snap to it, so a line scrolling 1 px at a time sits
 * still under the glass and then jumps a whole small pixel (8 px): white text
 * on black shimmers. Telegram's chats hide this under their bubbles, which
 * are antialiased rects and slide smoothly; ours are mostly bare text.
 */
private fun GlassLayers.record(scope: DrawScope, source: GlassSource, area: Rect) {
    val k = GlassSpec.DOWNSCALE
    val radius = GlassSpec.downscaledRadius(with(scope) { GlassSpec.blur.toPx() }, k)
    if (area == this.area && radius == this.radius && !capture.isReleased && !blurred.isReleased) return
    this.area = area
    this.radius = radius
    if (blurred.renderEffect == null) {
        // Softened to about half the small copy's pixel, so shrinking it has nothing left to alias.
        val prefilter = GlassSpec.prefilterRadius(k)
        capture.renderEffect = BlurEffect(prefilter, prefilter, TileMode.Clamp)
        blurred.renderEffect = BlurEffect(radius, radius, TileMode.Clamp)
        blurred.colorFilter = saturate
    }
    with(scope) {
        capture.record(IntSize(area.width.toInt(), area.height.toInt())) {
            translate(-area.left, -area.top) { drawLayer(source.layer) }
        }
        blurred.record(IntSize(ceil(area.width / k).toInt().coerceAtLeast(1), ceil(area.height / k).toInt().coerceAtLeast(1))) {
            scale(1 / k, 1 / k, pivot = Offset.Zero) { drawLayer(capture) }
        }
    }
}

/**
 * Where a glass at [origin] is over its [source], in the source's own
 * coordinates. Drawn from this alone, a glass that moves with what it shows
 * (the dock and the transcript riding the keyboard together) isn't drawn
 * again, nor its blur made again.
 */
@Composable
private fun rememberSourceOffset(source: GlassSource?, origin: () -> Offset): State<Offset> =
    remember(source) { derivedStateOf { source?.let { origin() - it.origin } ?: Offset.Zero } }

/**
 * What a glass at [offset] over [source] shows: its ground, then (when it
 * [blurs]) the content blurred over that, as Telegram's
 * BlurredBackgroundSourceRenderNode draws. The blur takes in
 * [GlassSpec.capture] of content round the glass, kept to the source as
 * Telegram keeps it to the list; the caller clips it to the glass. Without
 * blur, the ground alone, so the tint over it is opaque, as Telegram's bar is
 * with blur off.
 */
private fun DrawScope.drawSource(layers: GlassLayers, source: GlassSource, offset: Offset, blurs: Boolean) {
    if (source.ground.isSpecified) drawRect(source.ground)
    if (!blurs || !source.recorded) return
    val bounds = Rect(Offset.Zero, source.layer.size.toSize())
    // Whole pixels, so the full-size capture lies on the screen's pixels and isn't resampled.
    val area = Rect(offset, size).inflate(GlassSpec.capture.toPx()).intersect(bounds).let {
        Rect(floor(it.left), floor(it.top), ceil(it.right), ceil(it.bottom))
    }
    if (area.isEmpty) return
    layers.record(this, source, area)
    translate(area.left - offset.x, area.top - offset.y) {
        scale(GlassSpec.DOWNSCALE, GlassSpec.DOWNSCALE, pivot = Offset.Zero) { drawLayer(layers.blurred) }
    }
}
