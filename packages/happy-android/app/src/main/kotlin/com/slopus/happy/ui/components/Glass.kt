package com.slopus.happy.ui.components

import android.content.Context
import android.os.Build
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.State
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.geometry.Size
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
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.isSpecified
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.CompositingStrategy as LayerCompositing
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalGraphicsContext
import androidx.compose.ui.graphics.GraphicsContext
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.toSize
import com.slopus.happy.BuildConfig
import com.slopus.happy.ui.FirstFrame
import java.io.File
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToInt

/**
 * Frosted glass over scrolling content, hand-rolled on [GraphicsLayer]
 * (RenderNodes): the content records itself into one layer ([glassSource]),
 * drawn as usual; the glass surfaces over it ([glass], [glassFade], [glassBar])
 * share one capture of that layer, only the bands under them, at full size,
 * halved three times to [GlassSpec.DOWNSCALE] ([GlassAtlas], Telegram's merged
 * glass rects), and each paints the source's ground, then its band blurred and
 * saturated, scaled back up under a tint. A layer drawn inside another stays live, so scrolling
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
class GlassSource internal constructor(internal val layer: GraphicsLayer, graphics: GraphicsContext) {
    internal var origin by mutableStateOf(Offset.Zero)
    internal var recorded by mutableStateOf(false)
    internal var ground by mutableStateOf(Color.Unspecified)

    /** The bands of this source its glasses blur, captured together, Telegram's merged glass rects. */
    internal val atlas = GlassAtlas(graphics)

    /**
     * A motion the source is part way through ([GlassTravel]), read where the
     * glasses over it draw; null while it rests.
     */
    var travel: GlassTravel? = null
}

/**
 * A source carried up the screen by [now] pixels this frame, on its way from
 * [from] to [to]: a list riding the keyboard. A glass the source slides under
 * (the bar over the transcript) blurs the band the whole way passes under it
 * once and moves that blur each frame, where it would blur again every frame;
 * a glass that rides with the source sees the same band throughout and blurs
 * nothing anyway. Read in draw.
 */
interface GlassTravel {
    val now: Int
    val from: Int
    val to: Int

    /**
     * How much higher than it is laid out the source is drawn this frame: the
     * part of [now] that is a translation (a keyboard's, AdjustPanLayoutHelper's),
     * which a glass it slides under adds to where it is over it. Glasses that
     * ride with the source are drawn as much higher themselves.
     */
    val lift: Int get() = 0
}

/** A source drawn on [ground], the screen's colour under the content; unspecified for content opaque itself. */
@Composable
fun rememberGlassSource(ground: Color = Color.Unspecified): GlassSource {
    val layer = rememberGraphicsLayer()
    val graphics = LocalGraphicsContext.current
    val source = remember(layer, graphics) { GlassSource(layer, graphics) }
    DisposableEffect(source) { onDispose { source.atlas.release() } }
    return source.also { it.ground = ground }
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
    val key = rememberGlassKey(source)
    var origin by remember { mutableStateOf(Offset.Zero) }
    val at = rememberSourceOffset(source) { origin }
    onGloballyPositioned { origin = it.positionInRoot() }
        .drawWithCache {
            val path = Path().apply { addOutline(shape.createOutline(size, layoutDirection, this@drawWithCache)) }
            val hairline = GlassSpec.hairline.toPx()
            val fill = colors.fill(blurs)
            onDrawBehind {
                if (source != null) {
                    val blurred = blurOf(key, source, at.value, size, blurs)
                    clipPath(path) { drawSource(source, at.value, blurred) }
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
    val key = rememberGlassKey(source)
    var origin by remember { mutableStateOf(Offset.Zero) }
    val at = rememberSourceOffset(source) { origin }
    onGloballyPositioned { origin = it.positionInRoot() }
        .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
        .drawBehind {
            if (source != null) {
                val blurred = blurOf(key, source, at.value, size, blurs)
                clipRect { drawSource(source, at.value, blurred) }
            }
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
    val key = rememberGlassKey(source)
    // The glass drawn once into a layer of its own: a frame where only something over it redraws (a
    // caret, a shimmer) composites it as it is, and the feather's mask needs no layer of its own.
    val glass = rememberGraphicsLayer()
    var origin by remember { mutableStateOf(Offset.Zero) }
    // The bar stays where it is while the source travels under it, drawn higher than it is laid out.
    val at = rememberSourceOffset(source, travels = true) { origin }
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
            glass.compositingStrategy = LayerCompositing.Offscreen
            onDrawBehind {
                // The glass is the bar and the feather under it.
                val whole = IntSize(size.width.roundToInt(), (bar + feather).roundToInt())
                val blurred = source?.let { blurOf(key, it, at.value, whole.toSize(), blurs, travels = true) }
                glass.record(whole) {
                    // The blur spreads past the layer's edge: keep it to the glass.
                    if (source != null) clipRect { drawSource(source, at.value, blurred) }
                    if (backdrop == null) {
                        drawRect(tint)
                    } else {
                        drawIntoCanvas { it.saveLayer(size.toRect(), Paint()) }
                        backdrop()
                        drawRect(mask, blendMode = BlendMode.DstIn)
                        drawIntoCanvas { it.restore() }
                    }
                    if (fade != null) drawRect(fade, blendMode = BlendMode.DstIn)
                }
                drawLayer(glass)
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
 * One blurred band of a source: [area] of it (whole pixels, in the source's
 * coordinates), an eighth of its size, blurred and saturated in [blurred],
 * read from the source's one merged capture ([GlassAtlas]) at [slot].
 * [stretched], it is the band a whole [GlassTravel] passes under, larger
 * than its glass needs at rest.
 */
internal class GlassBand(val area: Rect, val stretched: Boolean, val blurred: GraphicsLayer) {
    /** Where the band starts down the merged capture, a multiple of [GlassSpec.DOWNSCALE] pixels. */
    var slot = 0
}

/**
 * Telegram's merged capture (DownscaleScrollableNoiseSuppressor's source
 * parts, RecyclerListView's `capture`): the glasses over one source say which
 * band of it each needs ([want]); bands that overlap become one, and the
 * bands are drawn, one under the other, into one capture of the source at
 * full size ([capture]). That capture is halved, then halved again
 * ([half], [quarter]), each a bilinear 2×2 average, and each band's
 * [GlassBand.blurred] takes its part of the quarter, halved once more to an
 * eighth, and blurs it there. So a frame where the content moves renders
 * one capture and two halvings whatever the number of glasses, and only the
 * small blurs are a glass's own.
 *
 * Each band is drawn from the source clipped to the band: the source's
 * drawing culls what lies outside it, so only the rows under the glass are
 * drawn again, as Telegram's `captureChildren` draws only the children that
 * intersect a glass. Every band starts on a multiple of
 * [GlassSpec.DOWNSCALE] pixels, so no 2×2 average at any level reaches
 * across two bands, and each band's eighth is what it was blurred alone: the
 * same pixels, steady per 1 px step (research/telegram-glass.md).
 *
 * The layers draw the source by reference, so they are recorded again only
 * when the bands change, never because the content moved: the RenderThread
 * then renders the capture again by itself.
 */
@Stable
internal class GlassAtlas(private val graphics: GraphicsContext) {
    private class Want(val area: Rect, val stretched: Boolean)

    private val wants = LinkedHashMap<Any, Want>()
    private val bandOf = HashMap<Any, GlassBand>()
    private var bands = emptyList<GlassBand>()
    private var capture: GraphicsLayer? = null
    private var half: GraphicsLayer? = null
    private var quarter: GraphicsLayer? = null
    private var radius = 0f
    private var dirty = false

    /** The bands blurred now, in the order they lie down the merged capture. */
    val areas: List<Rect> get() = bands.map { it.area }

    /** Raised as the bands change: every glass over the source draws again, from its band. Read in draw. */
    var version by mutableIntStateOf(0)
        private set

    /** The band [glass] needs now; null for none. */
    fun want(glass: Any, area: Rect?, stretched: Boolean = false) {
        val now = wants[glass]
        if (area == null) {
            if (now != null) {
                wants.remove(glass)
                dirty = true
            }
            return
        }
        if (now != null && now.area == area && now.stretched == stretched) return
        wants[glass] = Want(area, stretched)
        dirty = true
    }

    /** What [glass] asked for last, if anything. */
    fun wanted(glass: Any): Rect? = wants[glass]?.area

    /** [glass] is gone: the bands without it are drawn from the next frame. */
    fun drop(glass: Any) {
        if (wants.remove(glass) == null) return
        dirty = true
        version++
    }

    /** The band [glass] draws from, the merged capture recorded again first if the bands changed. */
    fun band(scope: DrawScope, source: GlassSource, glass: Any, radius: Float): GlassBand? {
        if (dirty || radius != this.radius) rebuild(scope, source, radius)
        return bandOf[glass]
    }

    private fun rebuild(scope: DrawScope, source: GlassSource, radius: Float) {
        dirty = false
        val radiusChanged = radius != this.radius
        this.radius = radius
        // Overlapping bands become one round both (the composer's pill over the dock's fade); a
        // travel's band stays alone, as it is larger than its glass and only lasts the travel.
        val groups = ArrayList<Pair<Rect, MutableList<Any>>>()
        val alone = ArrayList<Pair<Want, Any>>()
        for ((glass, want) in wants) {
            if (want.stretched) {
                alone += want to glass
                continue
            }
            var area = want.area
            val members = mutableListOf(glass)
            var merged = true
            while (merged) {
                merged = false
                val other = groups.firstOrNull { it.first.overlaps(area) } ?: break
                groups.remove(other)
                area = area.union(other.first)
                members.addAll(other.second)
                merged = true
            }
            groups += area to members
        }
        // A band kept as it was keeps its blur; a new radius blurs every band anew.
        val old = (if (radiusChanged) emptyMap() else bands.associateBy { it.area to it.stretched }).toMutableMap()
        if (radiusChanged) bands.forEach { graphics.releaseGraphicsLayer(it.blurred) }
        fun bandFor(area: Rect, stretched: Boolean): GlassBand = old.remove(area to stretched) ?: GlassBand(area, stretched, newBlurred())
        bandOf.clear()
        val next = ArrayList<GlassBand>()
        for ((area, members) in groups) bandFor(area, false).also { band -> next += band; members.forEach { bandOf[it] = band } }
        for ((want, glass) in alone) bandFor(want.area, true).also { band -> next += band; bandOf[glass] = band }
        old.values.forEach { graphics.releaseGraphicsLayer(it.blurred) }
        bands = next
        record(scope, source)
        version++
    }

    private fun newBlurred(): GraphicsLayer = graphics.createGraphicsLayer().apply {
        renderEffect = BlurEffect(radius, radius, TileMode.Clamp)
        colorFilter = saturate
    }

    private fun layer(): GraphicsLayer =
        // Drawn into a layer of its own, so the next halving samples a picture, not the ops.
        graphics.createGraphicsLayer().apply { compositingStrategy = LayerCompositing.Offscreen }

    private fun record(scope: DrawScope, source: GlassSource) {
        if (bands.isEmpty()) return
        val step = GlassSpec.DOWNSCALE.toInt()
        var y = 0
        var width = 0
        for (band in bands) {
            band.slot = y
            y += ceil(band.area.height / step).toInt() * step
            width = maxOf(width, band.area.width.toInt())
        }
        fun size(at: Int) = IntSize(ceil(width.toFloat() / at).toInt().coerceAtLeast(1), ceil(y.toFloat() / at).toInt().coerceAtLeast(1))
        val capture = capture ?: layer().also { capture = it }
        val half = half ?: layer().also { half = it }
        val quarter = quarter ?: layer().also { quarter = it }
        with(scope) {
            capture.record(size(1)) {
                for (band in bands) {
                    val area = band.area
                    translate(-area.left, band.slot - area.top) {
                        clipRect(area.left, area.top, area.right, area.bottom) { drawLayer(source.layer) }
                    }
                }
            }
            half.record(size(2)) { scale(0.5f, 0.5f, pivot = Offset.Zero) { drawLayer(capture) } }
            quarter.record(size(4)) { scale(0.5f, 0.5f, pivot = Offset.Zero) { drawLayer(half) } }
            for (band in bands) {
                val small = IntSize(ceil(band.area.width / step).toInt().coerceAtLeast(1), ceil(band.area.height / step).toInt().coerceAtLeast(1))
                band.blurred.record(small) {
                    scale(0.5f, 0.5f, pivot = Offset.Zero) { translate(0f, -band.slot / 4f) { drawLayer(quarter) } }
                }
            }
        }
    }

    /** The source is gone: its layers go back. */
    fun release() {
        listOfNotNull(capture, half, quarter).forEach(graphics::releaseGraphicsLayer)
        bands.forEach { graphics.releaseGraphicsLayer(it.blurred) }
        capture = null
        half = null
        quarter = null
        bands = emptyList()
        bandOf.clear()
        wants.clear()
    }
}

private fun Rect.union(other: Rect) = Rect(minOf(left, other.left), minOf(top, other.top), maxOf(right, other.right), maxOf(bottom, other.bottom))

/** A glass's place among its source's bands: it gives up its band when it leaves. */
@Composable
private fun rememberGlassKey(source: GlassSource?): Any {
    val key = remember { Any() }
    DisposableEffect(source, key) { onDispose { source?.atlas?.drop(key) } }
    return key
}

/**
 * Where a glass at [origin] is over its [source], in the source's own
 * coordinates. Drawn from this alone, a glass that moves with what it shows
 * (the dock and the transcript riding the keyboard together) isn't drawn
 * again, nor its blur made again. A glass that [travels] stays put while the
 * source is drawn [GlassTravel.lift] higher under it (the bar over a
 * transcript riding the keyboard), so it adds that.
 */
@Composable
private fun rememberSourceOffset(source: GlassSource?, travels: Boolean = false, origin: () -> Offset): State<Offset> =
    remember(source) {
        derivedStateOf { source?.let { origin() - it.origin + Offset(0f, if (travels) (it.travel?.lift ?: 0).toFloat() else 0f) } ?: Offset.Zero }
    }

/**
 * The band a glass of [size] at [offset] over [source] draws from
 * ([GlassAtlas]). The band takes in [GlassSpec.capture] of content round
 * the glass, kept to the source as Telegram keeps it to the list. Moving
 * under a travelling source (the bar over a transcript riding the
 * keyboard), it is the band the whole travel passes under, blurred once as
 * the travel starts and only moved each frame. Recorded in the glass's own
 * draw, not inside another layer's recording (a layer recorded while
 * another records draws through the other's scope and never returns). Null
 * where there is nothing to blur.
 */
private fun DrawScope.blurOf(glass: Any, source: GlassSource, offset: Offset, size: Size, blurs: Boolean, travels: Boolean = false): GlassBand? {
    val atlas = source.atlas
    atlas.version
    if (!blurs || !source.recorded) {
        atlas.want(glass, null)
        return null
    }
    val bounds = Rect(Offset.Zero, source.layer.size.toSize())
    val margin = GlassSpec.capture.toPx()
    // Whole pixels, so the full-size capture lies on the screen's pixels and isn't resampled.
    fun band(at: Offset) = Rect(at, size).inflate(margin).intersect(bounds).let {
        Rect(floor(it.left), floor(it.top), ceil(it.right), ceil(it.bottom))
    }
    val needed = band(offset)
    if (needed.isEmpty) {
        atlas.want(glass, null)
        return null
    }
    val radius = GlassSpec.downscaledRadius(GlassSpec.blur.toPx(), GlassSpec.DOWNSCALE)
    // Only a glass the source slides under; one that rides with it sees the same band throughout.
    val travel = source.travel?.takeIf { travels && it.from != it.to }
    val whole = if (travel == null || atlas.wanted(glass) == null) needed else {
        val y = offset.y - travel.now
        listOf(band(Offset(offset.x, y + travel.from)), band(Offset(offset.x, y + travel.to))).fold(needed) { a, b ->
            if (b.isEmpty) a else a.union(b)
        }
    }
    atlas.want(glass, whole, stretched = whole != needed)
    return atlas.band(this, source, glass, radius)
}

/**
 * What a glass at [offset] over [source] shows: its ground, then the content
 * [blurred] over that ([blurOf]), as Telegram's
 * BlurredBackgroundSourceRenderNode draws; the caller clips it to the glass.
 * Without blur, the ground alone, so the tint over it is opaque, as
 * Telegram's bar is with blur off.
 */
private fun DrawScope.drawSource(source: GlassSource, offset: Offset, blurred: GlassBand?) {
    if (source.ground.isSpecified) drawRect(source.ground)
    val area = blurred?.area ?: return
    translate(area.left - offset.x, area.top - offset.y) {
        scale(GlassSpec.DOWNSCALE, GlassSpec.DOWNSCALE, pivot = Offset.Zero) { drawLayer(blurred.blurred) }
    }
}
