package com.slopus.happy.ui.connection

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.SceneAnimation
import com.slopus.happy.ui.components.rememberReduceMotion
import kotlinx.coroutines.delay
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

object CloudDriftTags {
    const val DRIFT = "cloud.drift"
    fun scene(index: Int) = "cloud.drift.$index"
}

/**
 * Desktop's CLOUD_DRIFT (CloudConnectScreen.tsx, SetupDrift.tsx): the scenes
 * drifting down the welcome's sides, the first half on the left. The four
 * desktop scenes Android didn't have are its files byte for byte
 * (assets/animations/PROVENANCE.md at dca9b205: cloud-variation 4833ea8c,
 * closed-lock f6087f51, open-hands 7b5b9d98, tree cb7c9a13).
 */
val CloudDriftScenes = listOf(
    R.raw.state_cloud_variation, R.raw.state_robot, R.raw.state_sparkles,
    R.raw.state_llama, R.raw.state_closed_lock, R.raw.state_tree,
)

/** Where each drifting scene goes and how it moves, in dp: iOS's numbers, desktop's on a tablet. */
object CloudDriftSpec {
    /** A window whose short side is at least this is a tablet's, with desktop's sizes and paths. */
    const val TABLET_SHORT_SIDE = 600f
    /** Phone: 40–56, at most two a side, against the edge with up to 35% of it off screen, wandering ±8 across and ±20 down. */
    const val PHONE_MIN = 40f
    const val PHONE_MAX = 56f
    const val PHONE_PER_SIDE = 2
    const val PHONE_OFF_SCREEN = 0.35f
    const val PHONE_WANDER_X = 8f
    const val PHONE_WANDER_Y = 20f
    /** Tablet: 64–104, centred 5–19% in from the edge, 14–80% down, wandering ±36 and ±48. */
    const val TABLET_MIN = 64f
    const val TABLET_MAX = 104f
    const val TABLET_WANDER_X = 36f
    const val TABLET_WANDER_Y = 48f
    /** Kept between a scene's whole path and anything it must stay clear of. */
    const val CLEARANCE = 8f
    /** Under the bar's row, which back and ⋮ hold. */
    const val TOP_ROW = 52f
    const val OPACITY = 0.9f
    const val FADE_MILLIS = 1_600
    const val TRIES = 60
}

/** One scene's place: its square's top left and side, and how far it wanders, in dp. */
data class DriftPlacement(val scene: Int, val x: Float, val y: Float, val size: Float, val dx: Float, val dy: Float, val delayMillis: Long, val periodMillis: Int) {
    /** All the room its path takes, [clearance] around it. */
    fun room(clearance: Float) = Rect(
        min(x, x + dx) - clearance,
        min(y, y + dy) - clearance,
        max(x, x + dx) + size + clearance,
        max(y, y + dy) + size + clearance,
    )
}

/**
 * Places desktop's scenes in a [width] × [height] window (dp) whose safe
 * area runs from [top] to [bottom], kept clear of [keepClear] (the slides,
 * the note and the button): each one's whole wander, plus 8, touches none of
 * them and no other scene. A side short of room shows fewer, or none.
 */
fun placeDrift(width: Float, height: Float, top: Float, bottom: Float, keepClear: List<Rect>, random: Random): List<DriftPlacement> {
    val tablet = min(width, height) >= CloudDriftSpec.TABLET_SHORT_SIDE
    val placed = ArrayList<DriftPlacement>()
    val half = (CloudDriftScenes.size + 1) / 2
    fun between(from: Float, to: Float) = from + random.nextFloat() * (to - from)
    for ((index, scene) in CloudDriftScenes.withIndex()) {
        val left = index < half
        if (!tablet && placed.count { (it.x < width / 2) == left } >= CloudDriftSpec.PHONE_PER_SIDE) continue
        for (attempt in 0 until CloudDriftSpec.TRIES) {
            val size: Float
            val x: Float
            val y: Float
            val dx: Float
            val dy: Float
            if (tablet) {
                size = between(CloudDriftSpec.TABLET_MIN, CloudDriftSpec.TABLET_MAX)
                val centre = width * between(0.05f, 0.19f)
                x = (if (left) centre else width - centre) - size / 2
                y = top + (bottom - top) * between(0.14f, 0.80f) - size / 2
                dx = between(-CloudDriftSpec.TABLET_WANDER_X, CloudDriftSpec.TABLET_WANDER_X)
                dy = between(-CloudDriftSpec.TABLET_WANDER_Y, CloudDriftSpec.TABLET_WANDER_Y)
            } else {
                size = between(CloudDriftSpec.PHONE_MIN, CloudDriftSpec.PHONE_MAX)
                val off = size * between(0f, CloudDriftSpec.PHONE_OFF_SCREEN)
                x = if (left) -off else width - size + off
                y = between(top + CloudDriftSpec.TOP_ROW, bottom - size)
                dx = between(-CloudDriftSpec.PHONE_WANDER_X, CloudDriftSpec.PHONE_WANDER_X)
                dy = between(-CloudDriftSpec.PHONE_WANDER_Y, CloudDriftSpec.PHONE_WANDER_Y)
            }
            val candidate = DriftPlacement(
                scene, x, y, size, dx, dy,
                delayMillis = (between(0.2f, 2.4f) * 1000).toLong(),
                periodMillis = (between(16f, 28f) * 1000).toInt(),
            )
            val room = candidate.room(CloudDriftSpec.CLEARANCE)
            val inside = room.top >= top + CloudDriftSpec.TOP_ROW && room.bottom <= bottom
            if (inside && keepClear.none { it.overlaps(room) } && placed.none { it.room(0f).overlaps(room) }) {
                placed += candidate
                break
            }
        }
    }
    return placed
}

/**
 * The scenes drifting behind the welcome ([placeDrift]), once [keepClear]
 * is known (in the window's pixels). Each fades in to 0.9 over 1.6 s after
 * its own wait, plays once as it does and holds its last frame (animated
 * emoji never loop, Kirill), then wanders back and forth over 16–28 s.
 * Decoration only: no semantics, no touches, and still with animations off.
 * Placed once per window size.
 */
@Composable
fun CloudDrift(keepClear: List<Rect>?, modifier: Modifier = Modifier) {
    if (keepClear == null) return
    val density = LocalDensity.current
    val reduceMotion = rememberReduceMotion()
    BoxWithConstraints(modifier.fillMaxSize().clearAndSetSemantics {}.testTag(CloudDriftTags.DRIFT)) {
        val width = maxWidth.value
        val height = maxHeight.value
        val insets = WindowInsets.systemBars.union(WindowInsets.displayCutout)
        val top = with(density) { insets.getTop(this).toDp().value }
        val bottom = height - with(density) { insets.getBottom(this).toDp().value }
        val placements = remember(width, height) {
            val clear = keepClear.map { Rect(it.left / density.density, it.top / density.density, it.right / density.density, it.bottom / density.density) }
            placeDrift(width, height, top, bottom, clear, Random.Default)
        }
        placements.forEachIndexed { index, placement -> DriftScene(placement, reduceMotion, Modifier.testTag(CloudDriftTags.scene(index))) }
    }
}

@Composable
private fun DriftScene(placement: DriftPlacement, reduceMotion: Boolean, modifier: Modifier) {
    val alpha = remember { Animatable(if (reduceMotion) CloudDriftSpec.OPACITY else 0f) }
    var plays by remember { mutableIntStateOf(0) }
    LaunchedEffect(reduceMotion) {
        if (reduceMotion) {
            alpha.snapTo(CloudDriftSpec.OPACITY)
            return@LaunchedEffect
        }
        delay(placement.delayMillis)
        plays = 1
        alpha.animateTo(CloudDriftSpec.OPACITY, tween(CloudDriftSpec.FADE_MILLIS))
    }
    val wander = if (reduceMotion) null else rememberInfiniteTransition(label = "drift").animateFloat(
        0f, 1f, infiniteRepeatable(tween(placement.periodMillis, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "wander",
    )
    Box(
        modifier
            .offset(placement.x.dp, placement.y.dp)
            .graphicsLayer {
                this.alpha = alpha.value
                val t = wander?.value ?: 0f
                translationX = placement.dx.dp.toPx() * t
                translationY = placement.dy.dp.toPx() * t
            },
    ) {
        SceneAnimation(placement.scene, requested = plays, onReplay = null, size = placement.size.dp)
    }
}
