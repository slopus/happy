package com.slopus.happy.ui.conversation

import android.text.format.DateFormat
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.R
import com.slopus.happy.conversation.AccountUsage
import com.slopus.happy.conversation.ContextGauge
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date

object ContextMeterTags {
    /** The bar and the touch round it. */
    const val METER = "conversation.context.meter"
    const val READOUT = "conversation.context.meter.readout"
    /** The usage ring before the model's name. */
    const val RING = "conversation.modes.ring"
}

/**
 * Desktop's ContextMeter (`context-meter.css`) as iOS draws it (083c30df4):
 * a 64 × 4 bar in a 20 row under the composer, its right end under send.
 * Revealed, the track grows to 6 tall and 1.0625 wide about its centre and
 * the readout opens 6 to its left.
 */
object ContextMeterSpec {
    val trackWidth = 64.dp
    val trackHeight = 4.dp
    val revealedTrackHeight = 6.dp
    const val REVEALED_TRACK_SCALE = 1.0625f
    val readoutGap = 6.dp
    val readoutSpacing = 4.dp
    val readoutMaxWidth = 140.dp
    val notchWidth = 1.dp
    val fontSize = 11.sp
    /** The row under the pill: 8 above the bar, 8 below it. */
    val height = 20.dp
    /** Wide enough for the whole readout, so revealing it never moves the bar. */
    val width = readoutMaxWidth + readoutGap + trackWidth
    /** The bar's right edge in from the pill's: send's own. */
    val trailingInset = 6.dp
    /** How far left of the bar a touch still lands, so the 4 dp bar takes a finger. */
    val touchSlop = 12.dp
    const val AMPLE_OPACITY = 0.72f
    const val TOKENS_OPACITY = 0.72f
    const val NOTCH_OPACITY = 0.9f
    const val REVEAL_MS = 4_000L
    const val REVEAL_DURATION_MS = 140
    const val FILL_DURATION_MS = 240
    const val GROW_DURATION_MS = 360
    const val SHRINK_DURATION_MS = 460
    const val SHINE_DURATION_MS = 520
    const val SHINE_WIDTH = 0.32f
    const val SHINE_START = -1.6f
    const val SHINE_END = 2.6f
    const val HOLD_MS = 300L
}

/** Desktop's colours over `theme.css`: the row's own voice with room, warning as compaction nears, error at it. */
private object MeterInk {
    fun ink(dark: Boolean) = if (dark) Color(0xFFCAC4D0) else Color(0xFF49454F)
    fun track(dark: Boolean) = if (dark) Color(0xFF292929) else Color(0xFFEAEAEA)
    fun compact(dark: Boolean) = if (dark) Color(0xFFFFAB00) else Color(0xFFFF9500)
    fun critical(dark: Boolean) = if (dark) Color(0xFFFF453A) else Color(0xFFFF3B30)
    fun usageTrack(dark: Boolean) = if (dark) Color(0xFF48484A) else Color(0xFFC0C0C0)
}

private val easeOut = CubicBezierEasing(0f, 0f, 0.58f, 1f)
private val bounceEasing = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)

/**
 * How much of the context window the conversation has spent: the bar alone
 * at rest, the percentage and the token counts sliding out to its left when
 * it is tapped (for four seconds) and for as long as it is held. It takes
 * colour only once compacting is next. A grown fill bumps the track and
 * sends a shine across it; a shrunk one (a compaction) squashes it.
 */
@Composable
internal fun ContextMeter(gauge: ContextGauge, modifier: Modifier = Modifier) {
    val dark = HappyTheme.colors.dark
    val surface = HappyTheme.colors.surface
    val reduceMotion = rememberReduceMotion()
    val scope = rememberCoroutineScope()
    var revealed by remember { mutableStateOf(false) }
    val hiding = remember { arrayOfNulls<Job>(1) }
    fun reveal(shown: Boolean) {
        hiding[0]?.cancel()
        hiding[0] = null
        revealed = shown
    }
    fun toggle() {
        reveal(!revealed)
        if (revealed) hiding[0] = scope.launch { delay(ContextMeterSpec.REVEAL_MS); revealed = false }
    }
    val ink = when (gauge.tone) {
        ContextGauge.Tone.Ample -> MeterInk.ink(dark)
        ContextGauge.Tone.Compact -> MeterInk.compact(dark)
        ContextGauge.Tone.Critical -> MeterInk.critical(dark)
    }
    val open by animateFloatAsState(if (revealed) 1f else 0f, if (reduceMotion) snap() else tween(ContextMeterSpec.REVEAL_DURATION_MS, easing = easeOut), label = "meter reveal")
    val fill by animateFloatAsState(gauge.fraction.toFloat(), if (reduceMotion) snap() else tween(ContextMeterSpec.FILL_DURATION_MS, easing = easeOut), label = "meter fill")
    // The track's bump or squash, and the shine's pass, as the reading moves.
    val scaleX = remember { Animatable(1f) }
    val scaleY = remember { Animatable(1f) }
    val shine = remember { Animatable(-1f) }
    val previous = remember { arrayOf<Double?>(null) }
    LaunchedEffect(gauge.fraction) {
        val before = previous[0]
        previous[0] = gauge.fraction
        if (before == null || before == gauge.fraction || reduceMotion) return@LaunchedEffect
        val grew = gauge.fraction > before
        launch { bounce(scaleX, if (grew) listOf(1f, 1.025f, 0.995f, 1f) else listOf(1f, 0.92f, 1.035f, 0.99f, 1f), grew) }
        launch { bounce(scaleY, if (grew) listOf(1f, 1.45f, 0.92f, 1f) else listOf(1f, 1.55f, 0.88f, 1.08f, 1f), grew) }
        if (grew) {
            shine.snapTo(0f)
            shine.animateTo(1f, tween(ContextMeterSpec.SHINE_DURATION_MS, easing = LinearEasing))
            shine.snapTo(-1f)
        }
    }
    val percent = if (gauge.measured) (if (gauge.approximate) "~" else "") + "${gauge.percent}%" else "—"
    val tokens = (if (gauge.measured) ContextGauge.tokens(gauge.usedTokens) else "—") + "/" + ContextGauge.tokens(gauge.totalTokens)
    val title = contextMeterTitle(gauge)
    val style = TextStyle(fontSize = ContextMeterSpec.fontSize, lineHeight = 13.sp, color = ink, fontFeatureSettings = "tnum")
    Box(
        modifier
            .size(ContextMeterSpec.width, ContextMeterSpec.height)
            .alpha(if (gauge.tone == ContextGauge.Tone.Ample) ContextMeterSpec.AMPLE_OPACITY else 1f),
    ) {
        // The readout opens leftward from the bar in a box that clips it.
        Readout(
            open = open,
            modifier = Modifier.align(Alignment.CenterEnd).offset(x = -(ContextMeterSpec.trackWidth + ContextMeterSpec.readoutGap * open)).testTag(ContextMeterTags.READOUT),
        ) {
            Row(Modifier.wrapContentWidth(Alignment.Start, unbounded = true).alpha(open)) {
                Text(percent, style = style, maxLines = 1)
                Spacer(Modifier.width(ContextMeterSpec.readoutSpacing))
                Text(tokens, style = style, maxLines = 1, modifier = Modifier.alpha(ContextMeterSpec.TOKENS_OPACITY))
            }
        }
        Canvas(
            Modifier
                .align(Alignment.CenterEnd)
                .width(ContextMeterSpec.trackWidth + ContextMeterSpec.touchSlop)
                .fillMaxHeight()
                .semantics(mergeDescendants = true) {
                    contentDescription = title
                    if (revealed) stateDescription = "$percent $tokens"
                    onClick { toggle(); true }
                }
                .testTag(ContextMeterTags.METER)
                .pointerInput(Unit) {
                    var held = false
                    detectTapGestures(
                        onPress = {
                            held = false
                            val holding = scope.launch {
                                delay(ContextMeterSpec.HOLD_MS)
                                held = true
                                reveal(true)
                            }
                            tryAwaitRelease()
                            holding.cancel()
                            if (held) reveal(false)
                        },
                        onTap = { if (!held) toggle() },
                    )
                },
        ) {
            val restWidth = ContextMeterSpec.trackWidth.toPx()
            val height = androidx.compose.ui.util.lerp(ContextMeterSpec.trackHeight.toPx(), ContextMeterSpec.revealedTrackHeight.toPx(), open)
            val width = restWidth * androidx.compose.ui.util.lerp(1f, ContextMeterSpec.REVEALED_TRACK_SCALE, open)
            val centre = Offset(size.width - restWidth / 2, size.height / 2)
            val left = centre.x - width / 2
            val top = centre.y - height / 2
            val radius = CornerRadius(height / 2)
            withTransform({ scale(scaleX.value, scaleY.value, centre) }) {
                drawRoundRect(MeterInk.track(dark), Offset(left, top), Size(width, height), radius)
                clipRect(left, top, left + width, top + height) {
                    val filled = width * fill.coerceIn(0f, 1f)
                    if (filled > 0f) drawRoundRect(ink, Offset(left, top), Size(filled, height), radius)
                    val streak = width * ContextMeterSpec.SHINE_WIDTH
                    val pass = shine.value
                    if (pass >= 0f) {
                        val startX = streak / 2 + ContextMeterSpec.SHINE_START * streak
                        val endX = streak / 2 + ContextMeterSpec.SHINE_END * streak
                        val mid = left + startX + (endX - startX) * bounceEasing.transform(pass)
                        // `opacity: 0 → 0.82 → 0`, the peak a quarter in.
                        val glow = if (pass < 0.24f) pass / 0.24f * 0.82f else (1 - pass) / 0.76f * 0.82f
                        drawRect(
                            Brush.horizontalGradient(listOf(surface.copy(alpha = 0f), surface.copy(alpha = 0.88f * glow), surface.copy(alpha = 0f)), mid - streak / 2, mid + streak / 2),
                            Offset(mid - streak / 2, top),
                            Size(streak, height),
                        )
                    }
                    val notch = ContextMeterSpec.notchWidth.toPx()
                    drawRect(surface.copy(alpha = ContextMeterSpec.NOTCH_OPACITY), Offset(left + width * gauge.compactFraction.toFloat() - notch / 2, top), Size(notch, height))
                }
            }
        }
    }
}

/** A box [open] of its content's width wide, clipping it, its right edge where it is placed. */
@Composable
private fun Readout(open: Float, modifier: Modifier, content: @Composable () -> Unit) {
    Layout(content, modifier.clipToBounds()) { measurables, constraints ->
        val placeable = measurables.first().measure(constraints.copy(minWidth = 0, maxWidth = ContextMeterSpec.readoutMaxWidth.roundToPx()))
        val width = (placeable.width * open).toInt()
        layout(width, placeable.height) { placeable.place(0, 0) }
    }
}

private suspend fun bounce(value: Animatable<Float, *>, scales: List<Float>, grew: Boolean) {
    val times = if (grew) listOf(0f, 0.32f, 0.68f, 1f) else listOf(0f, 0.24f, 0.58f, 0.8f, 1f)
    val duration = if (grew) ContextMeterSpec.GROW_DURATION_MS else ContextMeterSpec.SHRINK_DURATION_MS
    value.animateTo(1f, keyframes {
        durationMillis = duration
        scales.forEachIndexed { i, scale -> scale at (times[i] * duration).toInt() using bounceEasing }
    })
}

/** The meter's `title`, which TalkBack reads: what is spent, where it compacts, and what the colour asks. */
@Composable
internal fun contextMeterTitle(gauge: ContextGauge): String {
    val used = ContextGauge.tokens(gauge.usedTokens)
    val total = ContextGauge.tokens(gauge.totalTokens)
    val note = gauge.compactTokens?.let { " · " + stringResource(R.string.conversation_context_compacts_at, ContextGauge.tokens(it)) }.orEmpty()
    if (!gauge.measured) return stringResource(R.string.conversation_context_pending, total) + note
    val spent = stringResource(if (gauge.approximate) R.string.conversation_context_used_approximate else R.string.conversation_context_used, used, total)
    val advice = when (gauge.tone) {
        ContextGauge.Tone.Critical -> " — " + stringResource(R.string.conversation_context_compact_next)
        ContextGauge.Tone.Compact -> " — " + stringResource(R.string.conversation_context_compact_soon)
        ContextGauge.Tone.Ample -> ""
    }
    return spent + note + advice
}

/**
 * Desktop's UsageRing: how much of a usage window is left, read like a
 * battery. The arc runs clockwise from twelve and drains as the window is
 * spent: quiet with room, orange when little is left, red when almost
 * nothing is or the account is blocked, its track then tinted, all red once
 * nothing is left.
 */
@Composable
internal fun UsageRing(left: Int, tone: AccountUsage.Tone, modifier: Modifier = Modifier, diameter: Dp = UsageRingSpec.size, tagged: Boolean = true) {
    val dark = HappyTheme.colors.dark
    val arc = when (tone) {
        AccountUsage.Tone.Ample -> MeterInk.ink(dark)
        AccountUsage.Tone.Low -> MeterInk.compact(dark)
        AccountUsage.Tone.Critical -> MeterInk.critical(dark)
    }
    val critical = MeterInk.critical(dark)
    val track = when {
        tone != AccountUsage.Tone.Critical -> MeterInk.usageTrack(dark)
        left <= 0 -> critical
        else -> critical.copy(alpha = 0.4f)
    }
    Canvas(modifier.size(diameter).then(if (tagged) Modifier.testTag(ContextMeterTags.RING) else Modifier)) {
        val stroke = UsageRingSpec.stroke.toPx()
        val inset = stroke / 2
        val ring = Size(size.width - stroke, size.height - stroke)
        drawArc(track, 0f, 360f, false, Offset(inset, inset), ring, style = Stroke(stroke))
        val share = left.coerceIn(0, 100) / 100f
        if (share > 0f) drawArc(arc, -90f, 360f * share, false, Offset(inset, inset), ring, style = Stroke(stroke, cap = if (left < 100) StrokeCap.Round else StrokeCap.Butt))
    }
}

/** The model chip's ring (desktop's `composer-model-control__warning`): 12 before the name, 6 apart. */
object UsageRingSpec {
    val size = 12.dp
    val gap = 6.dp
    val stroke = 2.dp
}

/** `usageWarning`'s words: "Weekly limit · 12% left · Resets Fri 4:10 PM", or "Session limit reached · Resets 3:05 PM". */
@Composable
internal fun usageWarningText(warning: AccountUsage.Warning, now: Long = System.currentTimeMillis()): String {
    val name = stringResource(if (warning.window.kind == AccountUsage.Window.Kind.Week) R.string.conversation_usage_week_limit else R.string.conversation_usage_session_limit)
    val head = if (warning.window.blocking) stringResource(R.string.conversation_usage_reached, name) else stringResource(R.string.conversation_usage_left, name, warning.left)
    val resets = warning.window.resetsAt?.let { " · " + stringResource(R.string.agent_input_usage_popup_resets, dayTime(it, now)) }.orEmpty()
    return head + resets
}

/** `localDayTime`: today's time alone; any other day leads with its weekday. */
@Composable
internal fun dayTime(ms: Long, now: Long): String {
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    val time = DateFormat.getBestDateTimePattern(locale, if (DateFormat.is24HourFormat(context)) "Hm" else "hma")
    val sameDay = Calendar.getInstance().run {
        timeInMillis = ms
        val day = get(Calendar.YEAR) * 400 + get(Calendar.DAY_OF_YEAR)
        timeInMillis = now
        day == get(Calendar.YEAR) * 400 + get(Calendar.DAY_OF_YEAR)
    }
    val pattern = if (sameDay) time else "EEE " + time
    return SimpleDateFormat(pattern, locale).format(Date(ms))
}
