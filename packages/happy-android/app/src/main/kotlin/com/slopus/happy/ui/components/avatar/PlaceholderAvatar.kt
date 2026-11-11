package com.slopus.happy.ui.components.avatar

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Paint
import android.graphics.RuntimeShader
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.util.LruCache
import android.view.Choreographer
import androidx.annotation.RequiresApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Settings › Appearance › Animated Avatars (happy-ios's `LiveAvatars`):
 * placeholders drawn as the shaders they were made from, moving, instead of
 * their still pictures. Kept on this phone for every account; off unless
 * turned on. Provided once at the app's root.
 */
val LocalAnimatedAvatars = staticCompositionLocalOf { false }

object PlaceholderAvatarTags {
    const val STILL = "avatar.still"
    const val LIVE = "avatar.live"
}

/** Which bundled placeholder a [PlaceholderAvatar] wears, for tests. */
val PlaceholderIndexKey = SemanticsPropertyKey<Int>("AvatarPlaceholderIndex")
private var SemanticsPropertyReceiver.placeholderIndex by PlaceholderIndexKey

/**
 * What [seed] wears without a picture of its own: its bundled placeholder
 * ([AvatarPlaceholder]), [size] square, clipped to [shape], decoded off the
 * main thread at the size it is drawn; an empty disc until then, so
 * nothing else stands in for it. Greyed for [monochrome].
 *
 * Where it [may move][animated] and Animated Avatars is on, on Android 13
 * and later it is drawn as its live shader instead ([AVATAR_SHADER_AGSL]),
 * starting on the still picture's frame (its phase), [AvatarShader.speed]
 * times the package's rate for its size: [AvatarShader.FRAMES_PER_SECOND]
 * frames a second from one shared clock, only while composed (a lazy list's rows on
 * screen) and its screen is resumed, at most [LiveAvatarClock.MAX_LIVE] at
 * once (the rest stay still). With animations removed or in battery saver
 * each holds its picture, as happy-ios does under Reduce Motion or Low
 * Power Mode. Older Android, or a shader that won't build, draws the still
 * picture.
 */
@Composable
fun PlaceholderAvatar(
    seed: String,
    size: Dp,
    modifier: Modifier = Modifier,
    shape: Shape = CircleShape,
    monochrome: Boolean = false,
    animated: Boolean = true,
) {
    val index = remember(seed) { AvatarPlaceholder.index(seed) }
    val pixels = with(LocalDensity.current) { min(AvatarPlaceholderImages.MAX_PIXELS, max(1, ceil(size.toPx()).toInt())) }
    val box = modifier
        .size(size)
        .semantics { placeholderIndex = index }
        .clip(shape)
    val live = animated && LocalAnimatedAvatars.current && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        AvatarShaderProgram.available && rememberMotionAllowed()
    if (live && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        val token = remember { Any() }
        val resumed by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
        val joined = resumed.isAtLeast(Lifecycle.State.RESUMED)
        DisposableEffect(token, joined) {
            if (joined) LiveAvatarClock.join(token)
            onDispose { LiveAvatarClock.leave(token) }
        }
        val moving by remember(token) { derivedStateOf { token in LiveAvatarClock.live.value } }
        if (moving) {
            val parameters = remember(index) { AvatarShader.parameters(index) }
            val started = remember(index) { SystemClock.uptimeMillis() }
            val speed = AvatarShader.speed(size.value)
            Box(
                box.testTag(PlaceholderAvatarTags.LIVE).drawBehind {
                    val time = AvatarShader.time(parameters, LiveAvatarClock.millis.longValue - started, speed)
                    drawIntoCanvas { canvas ->
                        AvatarShaderProgram.draw(canvas.nativeCanvas, parameters, time, this.size.width, monochrome)
                    }
                },
            )
            return
        }
    }
    StillPlaceholder(index, pixels, box, monochrome)
}

@Composable
private fun StillPlaceholder(index: Int, pixels: Int, modifier: Modifier, monochrome: Boolean) {
    val context = LocalContext.current.applicationContext
    var image by remember(index, pixels) { mutableStateOf(AvatarPlaceholderImages.cached(index, pixels)) }
    if (image == null) {
        LaunchedEffect(index, pixels) { image = AvatarPlaceholderImages.load(context, index, pixels) }
    }
    val shown = image
    if (shown == null) {
        Box(modifier.testTag(PlaceholderAvatarTags.STILL).background(HappyTheme.colors.surfaceHigh))
    } else {
        Image(
            bitmap = shown,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            colorFilter = if (monochrome) grey else null,
            modifier = modifier.testTag(PlaceholderAvatarTags.STILL),
        )
    }
}

private val grey = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) })

/** Whether placeholders may move: not with animations removed, nor in battery saver. */
@Composable
private fun rememberMotionAllowed(): Boolean {
    val reduceMotion = rememberReduceMotion()
    val context = LocalContext.current
    val saver = remember(context) { (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isPowerSaveMode == true }
    return !reduceMotion && !saver
}

/**
 * The bundled placeholder pictures as bitmaps, decoded off the main thread
 * at the size they are drawn, and kept (happy-ios's AvatarPlaceholderImages).
 */
object AvatarPlaceholderImages {
    /** The pixels each is bundled at: the largest it is drawn at. */
    const val MAX_PIXELS = 384

    private val cache = object : LruCache<Long, ImageBitmap>(8 * 1024 * 1024) {
        override fun sizeOf(key: Long, value: ImageBitmap) = value.width * value.height * 4
    }

    private fun key(index: Int, pixels: Int) = index.toLong() shl 32 or pixels.toLong()

    fun cached(index: Int, pixels: Int): ImageBitmap? = cache.get(key(index, pixels))

    /** Placeholder [index], [pixels] across; null only when the bundle lacks it. */
    suspend fun load(context: Context, index: Int, pixels: Int): ImageBitmap? = cached(index, pixels) ?: withContext(Dispatchers.IO) {
        decode(context, index, pixels)?.also { cache.put(key(index, pixels), it) }
    }

    fun decode(context: Context, index: Int, pixels: Int): ImageBitmap? {
        val full = try {
            context.assets.open(AvatarPlaceholder.asset(index)).use { BitmapFactory.decodeStream(it) }
        } catch (_: java.io.IOException) {
            null
        } ?: return null
        val sized = if (full.width == pixels) full else Bitmap.createScaledBitmap(full, pixels, pixels, true).also { if (it !== full) full.recycle() }
        sized.prepareToDraw()
        return sized.asImageBitmap()
    }
}

/**
 * The one clock every moving placeholder reads, ticking
 * [AvatarShader.FRAMES_PER_SECOND] times a second (they drift slowly) on the main thread's
 * Choreographer while any has joined, and stopped when none has. The first
 * [MAX_LIVE] to join move; the rest wait their turn on their still picture.
 */
object LiveAvatarClock {
    const val MAX_LIVE = 32
    private const val FRAME_MS = 1000L / AvatarShader.FRAMES_PER_SECOND

    /** The last tick's vsync, in [SystemClock.uptimeMillis]'s time (the same monotonic clock); read in draw, so a tick only redraws. */
    val millis = mutableLongStateOf(SystemClock.uptimeMillis())

    /** The ones moving now. */
    val live = mutableStateOf<Set<Any>>(emptySet())
    private val joined = LinkedHashSet<Any>()
    private var ticking = false

    /** Moved to the vsync's time, on the first at least [FRAME_MS] (less its jitter) after the last tick. */
    private val tick: Choreographer.FrameCallback = Choreographer.FrameCallback { frameNanos ->
        val frame = frameNanos / 1_000_000
        if (frame - millis.longValue >= FRAME_MS - 2) millis.longValue = frame
        if (joined.isEmpty()) ticking = false else post()
    }

    /**
     * Woken [EARLY_MS] before the next tick is due, so the vsync at or just
     * past it moves it: every 6 vsyncs at 120 Hz, 3 at 60. Waking at the
     * tick itself would wait for the vsync after, 7 at 120 Hz (17 a second)
     * and 3 to 5 at 60, unevenly.
     */
    private fun post() {
        val delay = millis.longValue + FRAME_MS - EARLY_MS - SystemClock.uptimeMillis()
        Choreographer.getInstance().postFrameCallbackDelayed(tick, delay.coerceAtLeast(1))
    }

    private const val EARLY_MS = 4L

    /** Main thread only. */
    fun join(token: Any) {
        if (!joined.add(token)) return
        update()
        if (!ticking) {
            ticking = true
            millis.longValue = SystemClock.uptimeMillis()
            post()
        }
    }

    fun leave(token: Any) {
        if (joined.remove(token)) update()
    }

    /** Whether the clock is running, for tests. */
    val isTicking: Boolean get() = ticking

    private fun update() {
        val next = if (joined.size <= MAX_LIVE) joined.toSet() else joined.take(MAX_LIVE).toSet()
        if (next != live.value) live.value = next
    }
}

/**
 * The live placeholder's program: one [RuntimeShader] built on first use
 * and shared by every placeholder, its uniforms set just before each one
 * draws (a draw takes the shader as it is then). Main thread only.
 */
internal object AvatarShaderProgram {
    private var built = false
    private var shader: Any? = null
    private val paint = Paint()

    /** Whether the shader builds here: Android 13 and later, and it compiles. */
    val available: Boolean
        get() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
            if (!built) {
                built = true
                shader = try {
                    RuntimeShader(AVATAR_SHADER_AGSL)
                } catch (e: RuntimeException) {
                    Log.w("PlaceholderAvatar", "The avatar shader is unavailable", e)
                    null
                } catch (_: LinkageError) {
                    null
                }
            }
            return shader != null
        }

    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    fun draw(canvas: android.graphics.Canvas, parameters: AvatarShader.Parameters, time: Float, side: Float, monochrome: Boolean) {
        val shader = (shader ?: return) as RuntimeShader
        configure(shader, parameters, time, side, monochrome)
        paint.shader = shader
        canvas.drawRect(0f, 0f, side, side, paint)
    }

    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    fun configure(shader: RuntimeShader, parameters: AvatarShader.Parameters, time: Float, side: Float, monochrome: Boolean) {
        val c = parameters.colors
        shader.setFloatUniform("col1", c[0], c[1], c[2])
        shader.setFloatUniform("col2", c[3], c[4], c[5])
        shader.setFloatUniform("col3", c[6], c[7], c[8])
        shader.setFloatUniform("col4", c[9], c[10], c[11])
        shader.setFloatUniform("seedLayout", parameters.layout)
        shader.setFloatUniform("turn", kotlin.math.cos(parameters.layout[2].toDouble()).toFloat(), kotlin.math.sin(parameters.layout[2].toDouble()).toFloat())
        shader.setFloatUniform("fx", parameters.effect.ordinal.toFloat())
        shader.setFloatUniform("t", time)
        shader.setFloatUniform("angle", parameters.angle)
        shader.setFloatUniform("warp", AvatarShader.WARP)
        shader.setFloatUniform("scale", AvatarShader.SCALE)
        shader.setFloatUniform("grain", AvatarShader.GRAIN)
        shader.setFloatUniform("grainCell", AvatarShader.grainCell(ceil(side).toInt()))
        shader.setFloatUniform("mono", if (monochrome) 1f else 0f)
        shader.setFloatUniform("size", side, side)
    }

    /** One frame of placeholder [index] at [time] (its phase when null), [pixels] across: for checks against its picture. */
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    fun frame(index: Int, pixels: Int, time: Float? = null): Bitmap? {
        val shader = try {
            RuntimeShader(AVATAR_SHADER_AGSL)
        } catch (_: RuntimeException) {
            return null
        }
        val parameters = AvatarShader.parameters(index)
        configure(shader, parameters, time ?: parameters.phase, pixels.toFloat(), false)
        // A bitmap's own canvas is software, which has no runtime shaders: the picture is drawn by the GPU renderer.
        val picture = android.graphics.Picture()
        picture.beginRecording(pixels, pixels).drawRect(0f, 0f, pixels.toFloat(), pixels.toFloat(), Paint().also { it.shader = shader })
        picture.endRecording()
        return Bitmap.createBitmap(picture, pixels, pixels, Bitmap.Config.ARGB_8888)
    }
}
