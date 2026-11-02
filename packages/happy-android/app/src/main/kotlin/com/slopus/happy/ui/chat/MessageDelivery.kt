package com.slopus.happy.ui.chat

import android.content.Context
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.chat.MessageDelivery
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.theme.happyTextStyle
import java.util.Date
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.roundToInt

object DeliveryTags {
    const val STATUS = "message.delivery"
    const val TIME = "message.delivery.time"
    const val MARK = "message.delivery.mark"
}

/**
 * The time and the mark at the foot of an own bubble, as Telegram's
 * outgoing bubble sets them (iOS's `MessageStatusLayout`, at the 17 base;
 * Telegram Android `ChatMessageCell.drawTime`/`MsgClockDrawable`):
 *
 *     5 gap │ time │ 13 slot ┊ 5 overhang
 *               ╰ clock: 11 square, centred 8.5 past the time, 7.5 down
 *               ╰ checks: 11×9, 3 down; the first 1 past the time, the
 *                 second 6 further, reaching 5 past the slot into the
 *                 bubble's padding
 *               ╰ failed: the clock's square
 *
 * The slot is always kept, so the clock turning into checks never moves
 * anything; the time is in tabular digits, so times of one format are one
 * width. The clock's frame turns once in 6 s and its hand in 1 s, linear;
 * each check pops from 1.3 to 1 over 0.1 s as it comes. Marks scale with
 * the text size as Telegram's follow its font size; past it the overhang
 * stays 5 and the slot takes the rest.
 */
object DeliverySpec {
    val gap = 5.dp
    val slot = 13.dp
    val overhang = 5.dp
    val clock = 11.dp
    val clockX = 8.5.dp
    val clockY = 7.5.dp
    val checkWidth = 11.dp
    val checkHeight = 9.dp
    val checkY = 3.dp
    val checkOffset = 6.dp

    /** Telegram's 11 at its 17 base, tabular. */
    val time = happyTextStyle(fontSize = 11, lineHeight = 14).copy(fontFeatureSettings = "tnum")

    const val HOUR_PERIOD_MS = 6_000L
    const val MINUTE_PERIOD_MS = 1_000L
    const val POP_SCALE = 1.3f
    const val POP_MS = 100

    /** A refused send's mark (`deliveryFailed`). */
    val failed = Color(0xFFFF3B30)

    /** How far past the time the box runs at text scale [scale]: the scaled slot, and what the overhang can't take. */
    fun reach(scale: Float): Dp = (slot + overhang) * scale - minOf(overhang * scale, overhang)

    /** How far the mark draws past the box, into the bubble's padding. */
    fun overhang(scale: Float): Dp = minOf(overhang * scale, overhang)
}

/** A message's time as a bubble shows it: hours and minutes in the phone's 12 or 24 hour clock. */
fun messageTime(context: Context, millis: Long): String =
    android.text.format.DateFormat.getTimeFormat(context).format(Date(millis))

/**
 * Where an own bubble's last line ends, for the time to ride up onto it
 * (Telegram's `trailingContent`): [right] from the content's start edge
 * and [below] between that line's foot and the content's foot. A body
 * whose last block can't share its line (a list, code, a table) reports
 * nothing and the time goes on a line of its own.
 */
class TrailingLine(val right: Float, val below: Float)

/** Written by a bubble's body while it is measured; read by [BubbleFoot] right after. */
class TrailingSlot {
    var line: TrailingLine? = null

    /** Where the bubble's content, time and mark included, was last placed: a sent message's flight lands on it. */
    var content: LayoutCoordinates? = null
}

/** The slot of the bubble being measured; null outside an own bubble. */
val LocalTrailingSlot = staticCompositionLocalOf<TrailingSlot?> { null }

/** [layout]'s last line for [LocalTrailingSlot], [below] being the block's own margin under it. */
fun TrailingSlot.report(layout: TextLayoutResult, below: Float) {
    val last = layout.lineCount - 1
    if (last < 0) return
    line = TrailingLine(layout.getLineRight(last) - minOf(layout.getLineLeft(last), 0f), below + layout.size.height - layout.getLineBottom(last))
}

/**
 * An own bubble's content with its time and mark at the foot: on the last
 * line when that line and the box fit, the content growing wide enough for
 * both and the box's foot a dp under the line's; otherwise on a line of its
 * own, ending at the content's end edge (iOS `MessageStatusLayout.place`).
 * [body] reports its last line into the slot while it measures.
 */
@Composable
fun BubbleFoot(slot: TrailingSlot, status: @Composable () -> Unit, modifier: Modifier = Modifier, body: @Composable () -> Unit) {
    // The slot keeps the last line reported: a body measured again without laying its text out again doesn't report.
    Layout(contents = listOf(body, status), modifier = modifier.onPlaced { slot.content = it }) { (bodies, statuses), constraints ->
        val open = constraints.copy(minWidth = 0, minHeight = 0)
        val content = bodies.map { it.measure(open) }
        val box = statuses.first().measure(open)
        val width = content.maxOfOrNull { it.width } ?: 0
        val height = content.sumOf { it.height }
        val available = constraints.maxWidth
        val line = slot.line
        val nudge = 1.dp.roundToPx()
        val inline = line != null && line.right + box.width <= available
        val w: Int
        val h: Int
        val bx: Int
        val by: Int
        if (inline) {
            w = max(width, (line!!.right + box.width).roundToInt()).coerceAtMost(available)
            h = height
            bx = w - box.width
            by = (height - line.below - box.height).roundToInt() + nudge
        } else {
            // Its own line, starting where the last block's margin does.
            val margin = line?.below?.roundToInt() ?: 0
            w = max(width, box.width)
            by = height - minOf(margin, box.height)
            h = max(height, by + box.height)
            bx = w - box.width
        }
        layout(max(w, constraints.minWidth), max(h, constraints.minHeight)) {
            var y = 0
            for (p in content) {
                p.place(0, y)
                y += p.height
            }
            box.place(bx, by.coerceAtMost(h - box.height))
        }
    }
}

/**
 * The time and the mark ([DeliverySpec]). The mark draws past the box by
 * [DeliverySpec.overhang], into the bubble's padding.
 */
@Composable
fun MessageStatus(time: String, delivery: MessageDelivery, ink: Color, scale: Float, modifier: Modifier = Modifier) {
    Layout(
        content = {
            Text(
                time,
                style = DeliverySpec.time,
                color = ink,
                maxLines = 1,
                overflow = TextOverflow.Clip,
                modifier = Modifier.testTag(DeliveryTags.TIME),
            )
            DeliveryMark(delivery, ink, scale, Modifier.testTag(DeliveryTags.MARK))
        },
        modifier = modifier.testTag(DeliveryTags.STATUS),
    ) { (text, mark), constraints ->
        val t = text.measure(Constraints())
        val gap = DeliverySpec.gap.roundToPx()
        val reachPx = DeliverySpec.reach(scale).roundToPx()
        val m = mark.measure(Constraints())
        layout(gap + t.width + reachPx, t.height) {
            t.place(gap, 1.dp.roundToPx())
            // The mark's canvas is the slot plus the overhang, its end that far past the box.
            m.place(gap + t.width + reachPx + DeliverySpec.overhang(scale).roundToPx() - m.width, 0)
        }
    }
}

/**
 * The clock, the checks and the refusal, drawn in one canvas the slot and
 * overhang wide. Only the canvas redraws as the clock turns or a check
 * pops; nothing composes or lays out.
 */
@Composable
fun DeliveryMark(delivery: MessageDelivery, ink: Color, scale: Float, modifier: Modifier = Modifier) {
    val reduceMotion = rememberReduceMotion()
    val sent = remember { Animatable(1f) }
    val read = remember { Animatable(1f) }
    val previous = remember { arrayOfNulls<MessageDelivery>(1) }
    LaunchedEffect(delivery) {
        val before = previous[0]
        previous[0] = delivery
        // The same message moving on pops what came; a mark shown again doesn't.
        if (before == null || reduceMotion) return@LaunchedEffect
        val hadSent = before == MessageDelivery.Received || before == MessageDelivery.Accepted
        val hasSent = delivery == MessageDelivery.Received || delivery == MessageDelivery.Accepted
        if (hasSent && !hadSent) {
            sent.snapTo(DeliverySpec.POP_SCALE)
            launch { sent.animateTo(1f, tween(DeliverySpec.POP_MS, easing = FastOutSlowInEasing)) }
        }
        if (delivery == MessageDelivery.Accepted && before != MessageDelivery.Accepted) {
            read.snapTo(DeliverySpec.POP_SCALE)
            read.animateTo(1f, tween(DeliverySpec.POP_MS, easing = FastOutSlowInEasing))
        }
    }
    var clock by remember { mutableLongStateOf(0L) }
    if (delivery == MessageDelivery.Sending && !reduceMotion) {
        LaunchedEffect(Unit) {
            // Every clock counts from the same moment, so they turn in step.
            // About 30 frames a second: the hands are a few pixels long.
            while (true) {
                withFrameMillis { clock = System.currentTimeMillis() }
                delay(CLOCK_FRAME_MS)
            }
        }
    }
    val width = DeliverySpec.slot * scale + DeliverySpec.overhang * scale
    val height = DeliverySpec.clockY * scale * 2
    // TalkBack hears what the clock and the red mark say; the checks are the quiet, usual case.
    val said = when (delivery) {
        MessageDelivery.Sending -> stringResource(R.string.message_sending)
        MessageDelivery.Failed -> stringResource(R.string.chat_send_failed)
        else -> null
    }
    Spacer(
        modifier
            .size(width, height)
            .clearAndSetSemantics { if (said != null) stateDescription = said }
            .drawBehind {
                val s = density * scale
                val end = size.width
                when (delivery) {
                    MessageDelivery.Sending -> drawClock(end, s, ink, clock)
                    MessageDelivery.Received -> drawCheck(end, s, ink, sent.value, second = false)
                    MessageDelivery.Accepted -> {
                        drawCheck(end, s, ink, sent.value, second = false)
                        drawCheck(end, s, ink, read.value, second = true)
                    }
                    MessageDelivery.Failed -> drawFailed(end, s)
                }
            },
    )
}

private const val CLOCK_FRAME_MS = 30L

private fun clockOrigin(end: Float, s: Float): Offset {
    val mid = end - (13f + 5f - 8.5f) * s
    return Offset(mid - 5.5f * s, 7.5f * s - 5.5f * s)
}

private fun DrawScope.drawClock(end: Float, s: Float, ink: Color, now: Long) {
    val o = clockOrigin(end, s)
    val c = Offset(o.x + 5.5f * s, o.y + 5.5f * s)
    val hour = (now % DeliverySpec.HOUR_PERIOD_MS) / DeliverySpec.HOUR_PERIOD_MS.toFloat() * 360f
    val minute = (now % DeliverySpec.MINUTE_PERIOD_MS) / DeliverySpec.MINUTE_PERIOD_MS.toFloat() * 360f
    drawCircle(ink, radius = 5f * s, center = c, style = Stroke(width = s))
    rotate(hour, c) { drawRect(ink, Offset(o.x + 5f * s, o.y + 5.5f * s), Size(s, 2.5f * s)) }
    rotate(minute, c) { drawRect(ink, Offset(o.x + 5f * s, o.y + 5f * s), Size(4.5f * s, s)) }
}

private fun DrawScope.drawCheck(end: Float, s: Float, ink: Color, pop: Float, second: Boolean) {
    val left = end - 11f * s - if (second) 0f else 6f * s
    val top = 3f * s
    val path = Path().apply {
        if (second) {
            moveTo(1.5f, 8f); lineTo(8f, 1f)
        } else {
            moveTo(1f, 5f); lineTo(3.95f, 7.95f); lineTo(4.05f, 7.95f); lineTo(10.5f, 1f)
        }
    }
    translate(left, top) {
        scale(pop, pivot = Offset(5.5f * s, 4.5f * s)) {
            scale(s, pivot = Offset.Zero) {
                drawPath(path, ink, style = Stroke(width = 0.99f, cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
        }
    }
}

private fun DrawScope.drawFailed(end: Float, s: Float) {
    val o = clockOrigin(end, s)
    drawCircle(DeliverySpec.failed, radius = 5.5f * s, center = Offset(o.x + 5.5f * s, o.y + 5.5f * s))
    drawRoundRect(Color.White, Offset(o.x + 4.75f * s, o.y + 2.25f * s), Size(1.5f * s, 4.5f * s), CornerRadius(0.75f * s))
    drawCircle(Color.White, radius = 0.75f * s, center = Offset(o.x + 5.5f * s, o.y + 8.25f * s))
}

/** The text size's multiplier the marks follow, from the bubble's own font scale. */
@Composable
fun deliveryScale(): Float = androidx.compose.ui.platform.LocalDensity.current.fontScale

/** The phone's clock format, for [messageTime]. */
@Composable
fun rememberMessageTime(millis: Long): String {
    val context = LocalContext.current
    return remember(millis, context) { messageTime(context, millis) }
}
