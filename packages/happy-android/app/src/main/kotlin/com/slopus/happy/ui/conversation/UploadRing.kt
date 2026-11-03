package com.slopus.happy.ui.conversation

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.UploadPhase
import com.slopus.happy.media.DownloadPhase
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.IoniconsFamily
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.rememberReduceMotion
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.min

/**
 * Telegram's radial status over chat media (iOS `UploadRingLayout`,
 * `MediaStatusLayout`, `RadialStatusNode`): a dark disc in the tile's
 * middle, the share of bytes moved as a white arc inside the disc's edge
 * that turns while it fills, and a cross to stop it; a download arrow, a
 * retry arrow or a play glyph where nothing moves.
 */
object UploadRingSpec {
    val diameter = 50.dp
    val smallDiameter = 32.dp
    /** A tile narrower than this takes the small disc. */
    val smallBelow = 90.dp
    /** At 50: the arc's line and its inset from the disc's edge, the cross's arms and line. */
    const val LINE = 2.25f
    const val ARC_INSET = 2.5f
    const val CROSS = 14f
    const val CROSS_LINE = 2f
    /** At 50: the download arrow's half length and its head's wings. */
    const val ARROW_HALF = 9f
    const val ARROW_WING = 7f
    /** The play glyph a little under half the disc, nudged right of the middle so it looks centred. */
    const val PLAY_SHARE = 0.44f
    const val PLAY_NUDGE = 0.04f
    const val RETRY_SHARE = 0.48f
    /** While nothing has gone yet, the arc's length, turning. */
    const val WAITING_SHARE = 0.27f
    const val TURN_MS = 1500
    /** Done: the disc shrinks to this and the ring fades. */
    const val OUT_MS = 250
    const val OUT_SCALE = 0.2f
    val dim = Color.Black.copy(alpha = 0.2f)
    val disc = Color.Black.copy(alpha = 0.45f)
    val ink = Color.White
    /** Taps a little past the disc still hit it. */
    val touchSlop = 8.dp
    const val TAG = "conversation.uploadRing"

    fun diameter(tile: Dp): Dp = if (tile < smallBelow) smallDiameter else diameter

    /** Telegram's progress tween: a fifth of a second, longer for a big jump. */
    fun tweenMs(from: Float, to: Float): Int {
        val delta = max(0f, to - from)
        return 200 + if (delta > 0.25f) min(450f, 450f * (delta - 0.25f) * 5).toInt() else 0
    }
}

/** What the ring shows (iOS `MediaRingView.State`). */
@Immutable
sealed interface MediaRingState {
    /** Queued, or a size not known yet: a short arc turns, with the cross. */
    data object Waiting : MediaRingState

    /** This share moved, turning, with the cross. */
    data class Progress(val share: Float) : MediaRingState

    /** It failed: the retry arrow. */
    data object Failed : MediaRingState

    /** Finished: the arc fills, then the disc shrinks away. */
    data object Done : MediaRingState

    /** Not on this phone: the download arrow. */
    data object Download : MediaRingState

    /** A recording, ready to play from what is here and what streams in. */
    data object Play : MediaRingState

    /** A recording while it downloads: the play glyph inside the arc (null: its size isn't known, so the short arc turns). */
    data class Playing(val share: Float?) : MediaRingState

    companion object {
        /** The ring for a download at [phase]: a picture's, or a recording's play button. */
        fun of(phase: DownloadPhase?, video: Boolean): MediaRingState {
            if (video) return if (phase is DownloadPhase.Downloading) Playing(phase.share) else Play
            return when (phase) {
                null, is DownloadPhase.Complete -> Done
                is DownloadPhase.Remote, is DownloadPhase.Paused -> Download
                is DownloadPhase.Downloading -> phase.share?.let(::Progress) ?: Waiting
                is DownloadPhase.Failed -> Failed
            }
        }

        fun of(phase: UploadPhase): MediaRingState = when (phase) {
            UploadPhase.Preparing -> Waiting
            is UploadPhase.Uploading -> Progress(phase.share)
            UploadPhase.Done -> Done
        }
    }
}

/**
 * The ring over a tile at [phase]; Done fills the arc, then the disc shrinks
 * away and the tile lightens. [onCancel] takes the picture out while it is
 * still going. Reduce Motion keeps it still: no turning, no tweens.
 */
@Composable
fun UploadRing(phase: UploadPhase, onCancel: (() -> Unit)?, modifier: Modifier = Modifier) {
    MediaRing(MediaRingState.of(phase), onCancel, stringResource(R.string.conversation_remove_picture), modifier, dim = true)
}

/**
 * The ring at [state] in the middle of the box it fills; [dim] darkens the
 * tile under it, as a sending picture's is. [onClick] is the disc's tap,
 * spoken as [label]; a finished ring takes none. Reduce Motion keeps it
 * still: no turning, no tweens.
 */
@Composable
fun MediaRing(state: MediaRingState, onClick: (() -> Unit)?, label: String?, modifier: Modifier = Modifier, dim: Boolean = false) {
    val reduceMotion = rememberReduceMotion()
    val arcShown = state is MediaRingState.Waiting || state is MediaRingState.Progress || state is MediaRingState.Playing || state is MediaRingState.Done
    val target = when (state) {
        MediaRingState.Waiting -> UploadRingSpec.WAITING_SHARE
        is MediaRingState.Progress -> state.share
        is MediaRingState.Playing -> state.share ?: UploadRingSpec.WAITING_SHARE
        else -> 1f
    }
    val drawn = remember { Animatable(target) }
    val shown = remember { Animatable(1f) }
    var gone by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf(state.moving) }
    LaunchedEffect(state, reduceMotion) {
        // From waiting's short arc, the real share starts where it is, without a tween.
        val was = moving
        moving = state.moving
        if (state != MediaRingState.Done) {
            gone = false
            shown.snapTo(1f)
        }
        val ms = UploadRingSpec.tweenMs(drawn.value, target)
        val tween = !reduceMotion && (state == MediaRingState.Done || (was && state.moving))
        if (tween) launch { drawn.animateTo(target, tween(ms, easing = LinearEasing)) } else drawn.snapTo(target)
        if (state == MediaRingState.Done) {
            if (!reduceMotion) {
                delay(ms.toLong())
                shown.animateTo(0f, tween(UploadRingSpec.OUT_MS))
            }
            gone = true
        }
    }
    if (gone) return
    val turning = !reduceMotion && (state is MediaRingState.Waiting || state is MediaRingState.Progress || state is MediaRingState.Playing)
    val angle = if (turning) {
        rememberInfiniteTransition(label = "media ring")
            .animateFloat(0f, 360f, infiniteRepeatable(tween(UploadRingSpec.TURN_MS, easing = LinearEasing), RepeatMode.Restart), label = "turn").value
    } else 0f
    val play = rememberVectorPainter(MaterialSymbols.PlayArrow)
    val retry = remember { String(Character.toChars(Ionicon.Refresh.codepoint)) }
    val glyphs = rememberTextMeasurer()
    BoxWithConstraints(
        modifier.fillMaxSize().graphicsLayer { alpha = shown.value }.then(if (dim) Modifier.background(UploadRingSpec.dim) else Modifier).testTag(UploadRingSpec.TAG),
        contentAlignment = Alignment.Center,
    ) {
        val side = UploadRingSpec.diameter(if (maxWidth < maxHeight) maxWidth else maxHeight)
        val tap = if (onClick != null && state != MediaRingState.Done) {
            Modifier
                .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onClick)
                .semantics { if (label != null) contentDescription = label }
        } else Modifier
        Box(tap.padding(UploadRingSpec.touchSlop), contentAlignment = Alignment.Center) {
            Canvas(
                Modifier
                    .size(side)
                    .graphicsLayer {
                        val scale = UploadRingSpec.OUT_SCALE + (1 - UploadRingSpec.OUT_SCALE) * shown.value
                        scaleX = scale
                        scaleY = scale
                    }
                    .background(UploadRingSpec.disc, CircleShape),
            ) {
                val factor = size.minDimension / UploadRingSpec.diameter.toPx()
                val center = Offset(size.width / 2, size.height / 2)
                if (arcShown) {
                    val line = max(1.6.dp.toPx(), UploadRingSpec.LINE.dp.toPx() * factor)
                    val radius = (size.minDimension - line - UploadRingSpec.ARC_INSET.dp.toPx() * 2) / 2
                    rotate(angle) {
                        drawArc(
                            UploadRingSpec.ink,
                            startAngle = -90f,
                            sweepAngle = 360f * drawn.value.coerceIn(0f, 1f),
                            useCenter = false,
                            topLeft = Offset(center.x - radius, center.y - radius),
                            size = Size(radius * 2, radius * 2),
                            style = Stroke(line, cap = StrokeCap.Round),
                        )
                    }
                }
                val stroke = max(1.3.dp.toPx(), UploadRingSpec.CROSS_LINE.dp.toPx() * factor)
                when (state) {
                    MediaRingState.Waiting, is MediaRingState.Progress, MediaRingState.Done -> {
                        val arm = UploadRingSpec.CROSS.dp.toPx() * factor / 2
                        drawLine(UploadRingSpec.ink, Offset(center.x - arm, center.y - arm), Offset(center.x + arm, center.y + arm), stroke, StrokeCap.Round)
                        drawLine(UploadRingSpec.ink, Offset(center.x + arm, center.y - arm), Offset(center.x - arm, center.y + arm), stroke, StrokeCap.Round)
                    }
                    MediaRingState.Download -> {
                        val half = UploadRingSpec.ARROW_HALF.dp.toPx() * factor
                        val wing = UploadRingSpec.ARROW_WING.dp.toPx() * factor
                        val point = Offset(center.x, center.y + half)
                        drawLine(UploadRingSpec.ink, Offset(center.x, center.y - half), point, stroke, StrokeCap.Round)
                        drawPath(
                            Path().apply {
                                moveTo(center.x - wing, point.y - wing)
                                lineTo(point.x, point.y)
                                lineTo(center.x + wing, point.y - wing)
                            },
                            UploadRingSpec.ink,
                            style = Stroke(stroke, cap = StrokeCap.Round, join = StrokeJoin.Round),
                        )
                    }
                    MediaRingState.Play, is MediaRingState.Playing -> {
                        val glyph = (size.minDimension * UploadRingSpec.PLAY_SHARE)
                        translate(center.x - glyph / 2 + size.minDimension * UploadRingSpec.PLAY_NUDGE, center.y - glyph / 2) {
                            with(play) { draw(Size(glyph, glyph), colorFilter = ColorFilter.tint(UploadRingSpec.ink)) }
                        }
                    }
                    MediaRingState.Failed -> {
                        val glyph = glyphs.measure(retry, TextStyle(fontFamily = IoniconsFamily, fontSize = (size.minDimension * UploadRingSpec.RETRY_SHARE).toSp(), color = UploadRingSpec.ink))
                        drawText(glyph, topLeft = Offset(center.x - glyph.size.width / 2f, center.y - glyph.size.height / 2f))
                    }
                }
            }
        }
    }
}

/** An arc that shows a real share, so the next tweens from it. */
private val MediaRingState.moving: Boolean
    get() = this is MediaRingState.Progress || (this is MediaRingState.Playing && share != null)
