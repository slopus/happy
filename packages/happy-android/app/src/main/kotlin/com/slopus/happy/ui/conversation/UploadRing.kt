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
import androidx.compose.ui.graphics.StrokeCap
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
import com.slopus.happy.ui.components.rememberReduceMotion
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.min

/**
 * Telegram's radial status over a sending photo (iOS `UploadRingLayout`,
 * `RadialStatusNode`): the tile dimmed, a dark disc in its middle, the share
 * of bytes sent as a white arc inside the disc's edge that turns while it
 * fills, and a cross to take the picture out.
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

/**
 * The ring over a tile at [phase]; Done fills the arc, then the disc shrinks
 * away and the tile lightens. [onCancel] takes the picture out while it is
 * still going. Reduce Motion keeps it still: no turning, no tweens.
 */
@Composable
fun UploadRing(phase: UploadPhase, onCancel: (() -> Unit)?, modifier: Modifier = Modifier) {
    val reduceMotion = rememberReduceMotion()
    val target = when (phase) {
        UploadPhase.Preparing -> UploadRingSpec.WAITING_SHARE
        is UploadPhase.Uploading -> phase.share
        UploadPhase.Done -> 1f
    }
    val drawn = remember { Animatable(target) }
    val shown = remember { Animatable(1f) }
    var gone by remember { mutableStateOf(false) }
    var waited by remember { mutableStateOf(phase == UploadPhase.Preparing) }
    LaunchedEffect(phase, reduceMotion) {
        // From waiting's short arc, the real share starts from nothing.
        if (waited && phase !is UploadPhase.Preparing) drawn.snapTo(0f)
        waited = phase == UploadPhase.Preparing
        if (phase != UploadPhase.Done) {
            gone = false
            shown.snapTo(1f)
        }
        val ms = UploadRingSpec.tweenMs(drawn.value, target)
        if (reduceMotion || phase == UploadPhase.Preparing) drawn.snapTo(target) else launch { drawn.animateTo(target, tween(ms, easing = LinearEasing)) }
        if (phase == UploadPhase.Done) {
            if (!reduceMotion) {
                delay(ms.toLong())
                shown.animateTo(0f, tween(UploadRingSpec.OUT_MS))
            }
            gone = true
        }
    }
    if (gone) return
    val turning = phase != UploadPhase.Done && !reduceMotion
    val angle = if (turning) {
        rememberInfiniteTransition(label = "upload ring")
            .animateFloat(0f, 360f, infiniteRepeatable(tween(UploadRingSpec.TURN_MS, easing = LinearEasing), RepeatMode.Restart), label = "turn").value
    } else 0f
    val label = stringResource(R.string.conversation_remove_picture)
    BoxWithConstraints(modifier.fillMaxSize().graphicsLayer { alpha = shown.value }.background(UploadRingSpec.dim).testTag(UploadRingSpec.TAG), contentAlignment = Alignment.Center) {
        val side = UploadRingSpec.diameter(if (maxWidth < maxHeight) maxWidth else maxHeight)
        val tap = if (onCancel != null && phase != UploadPhase.Done) {
            Modifier
                .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onCancel)
                .semantics { contentDescription = label }
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
                val line = max(1.6.dp.toPx(), UploadRingSpec.LINE.dp.toPx() * factor)
                val radius = (size.minDimension - line - UploadRingSpec.ARC_INSET.dp.toPx() * 2) / 2
                val center = Offset(size.width / 2, size.height / 2)
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
                val arm = UploadRingSpec.CROSS.dp.toPx() * factor / 2
                val crossLine = max(1.3.dp.toPx(), UploadRingSpec.CROSS_LINE.dp.toPx() * factor)
                drawLine(UploadRingSpec.ink, Offset(center.x - arm, center.y - arm), Offset(center.x + arm, center.y + arm), crossLine, StrokeCap.Round)
                drawLine(UploadRingSpec.ink, Offset(center.x + arm, center.y - arm), Offset(center.x - arm, center.y + arm), crossLine, StrokeCap.Round)
            }
        }
    }
}
