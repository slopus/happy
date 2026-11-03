package com.slopus.happy.ui.call

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.os.PowerManager
import android.os.Build
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.inspector.WindowInspector
import android.view.WindowManager
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredHeight
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.systemBars
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max
import androidx.compose.ui.unit.min
import androidx.compose.ui.zIndex
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.R
import com.slopus.happy.call.CallActivity
import com.slopus.happy.call.CallController
import com.slopus.happy.call.CallProblem
import com.slopus.happy.call.CallState
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.MaterialCommunityIcon
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow

/**
 * The voice call's bar (iOS `CallBarView`, after Telegram-iOS's in-call
 * status bar): full width from the window's top, in the first screen's
 * Grain colours ([CallBarSpec]). It takes the status bar's place and grows a
 * row past it, and everything under it, the top app bar first, is pushed
 * down by its height ([CallFrame]) rather than covered. Mute at the start,
 * "Happy" and the call's clock in the middle, end (or close) at the end, in
 * a 24 dp row at its foot; the waves overhang its bottom edge.
 *
 * Adapted from Telegram-iOS `submodules/Display/Source/Navigation/NavigationController.swift`
 * (the in-call status bar's frame and its 0.3 s ease-in-out slide) and
 * `submodules/TelegramCallsUI/Sources/CallStatusBarNode.swift` (the content row).
 */
object CallBarSpec {
    /** The row at the bar's foot the words and buttons share. */
    val row = 24.dp
    /** The bar never gets shorter than this: a whole [touch] box, with no status bar above (landscape). */
    val minHeight = 48.dp
    /**
     * A button's glyph, its 44 dp slot in the row (Telegram's), and the box
     * that takes a touch: 48 dp, Android's least, reaching past the slot
     * toward the title and up into the bar.
     */
    val glyph = 18.dp
    val button = 44.dp
    val touch = 48.dp
    /** From the bar's side to a button's glyph. */
    val sideInset = 14.dp
    /** Between the title and the clock. */
    val titleSpacing = 5.dp
    val title = happyTextStyle(fontSize = 13, lineHeight = 16, weight = FontWeight.SemiBold)
    val subtitle = happyTextStyle(fontSize = 13, lineHeight = 16).copy(fontFeatureSettings = "tnum")
    /** Telegram's show and hide: 0.3 s, ease-in-out. */
    const val MOTION_MS = 300
    val easing = CubicBezierEasing(0.42f, 0f, 0.58f, 1f)

    /** The first screen's Grain palette (`StartSpec.darkPalette`), start to end. */
    val connecting = listOf(Color(0xFF6C6C70), Color(0xFF6C6C70))
    val listening = listOf(Color(0xFF4338CA), Color(0xFF7C3AED))
    val speaking = listOf(Color(0xFF1D4ED8), Color(0xFF2A00FF))
    val muted = listOf(Color(0xFF7C3AED), Color(0xFF4338CA))
    val failed = listOf(Color(0xFFD70015), Color(0xFFD70015))
    val text = Color.White

    /** Under a status bar of [statusTop]: the status bar's place and a row past it. */
    fun height(statusTop: Dp): Dp = max(statusTop + row, minHeight)

    fun colors(state: CallState): List<Color> = when (state) {
        CallState.Idle, CallState.Connecting -> connecting
        is CallState.Active -> when {
            state.muted -> muted
            state.activity == CallActivity.Listening -> listening
            else -> speaking
        }
        is CallState.Ended -> failed
    }
}

object CallBarTags {
    const val BAR = "call-bar"
    const val TITLE = "call-bar-title"
    const val SUBTITLE = "call-bar-subtitle"
    const val MUTE = "call-bar-mute"
    const val END = "call-bar-end"
    const val CONTENT = "call-frame-content"
    /** A bar a window over it carries again, left out for TalkBack. */
    const val COVERED = "call-bar-covered"
}

/**
 * The window under the call's bar: while a call shows, the bar slides down
 * from above the screen and [content] is laid out below it, its top inset
 * taken by the bar (the status bar is inside the bar now), so the top app
 * bar keeps its own height and moves down with everything else. With
 * animations removed it is there at once. Light status bar icons over it.
 */
@Composable
fun CallFrame(calls: CallController, content: @Composable () -> Unit) =
    CallFrame(calls.state, calls.level, calls::toggleMute, calls::close, content)

/**
 * What a [CallFrame] shows, for the windows over it to show the same
 * ([WindowCallFrame]). While one of them carries its own bar, this one's is
 * covered and is left out for TalkBack, so the call is read once.
 */
class CallFrameSource(val state: StateFlow<CallState>, val level: StateFlow<Float>, val onMute: () -> Unit, val onEnd: () -> Unit) {
    var covers by mutableIntStateOf(0)
}

/** The call the window under this one shows its bar for, if any. */
val LocalCallFrame = staticCompositionLocalOf<CallFrameSource?> { null }

/**
 * A full-window dialog's content under the same call bar as the app's
 * window, which the dialog's window covers ([com.slopus.happy.ui.components.PageDialog]
 * puts every edge-to-edge dialog in one). Outside a [CallFrame] it is the
 * content alone.
 */
@Composable
fun WindowCallFrame(content: @Composable () -> Unit) {
    val source = LocalCallFrame.current ?: return content()
    DisposableEffect(source) {
        source.covers++
        onDispose { source.covers-- }
    }
    CallFrame(source.state, source.level, source.onMute, source.onEnd, content)
}

/**
 * A dialog someone else lays out ([dialog], RevenueCat's paywall), kept
 * below the call's bar: its window, full-screen on a phone, is moved down
 * by the bar's height while a call shows and given back the whole screen
 * after. It dims nothing behind it, and touches outside it go to the app's
 * window, so the bar works as it does everywhere else. The window is the dialog window
 * that appears after this is composed; Android 9 and older can't list
 * windows, so there the dialog covers the bar.
 */
@Composable
fun DialogBelowCallBar(dialog: @Composable () -> Unit) {
    val source = LocalCallFrame.current
    val before = remember { dialogWindows() }
    dialog()
    if (source == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val state by source.state.collectAsStateWithLifecycle()
    val density = LocalDensity.current
    val view = LocalView.current
    val statusTop = WindowInsets.statusBars.getTop(density)
    val bar = if (state.isShown) with(density) { CallBarSpec.height(statusTop.toDp()).roundToPx() } else 0
    var window by remember { mutableStateOf<Window?>(null) }
    LaunchedEffect(Unit) {
        // A few seconds of frames: it opens on the next, unless it decides not to open at all.
        repeat(300) {
            withFrameNanos {}
            window = dialogWindows().firstOrNull { it !in before } ?: return@repeat
            return@LaunchedEffect
        }
    }
    val moved = window ?: return
    DisposableEffect(moved, bar) {
        val whole = WindowManager.LayoutParams().apply { copyFrom(moved.attributes) }
        if (bar > 0) {
            moved.attributes = WindowManager.LayoutParams().apply {
                copyFrom(whole)
                gravity = Gravity.TOP
                y = bar
                height = view.rootView.height - bar
                // Its dim would lie over the bar alone, all the rest being the dialog.
                flags = (flags or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL) and WindowManager.LayoutParams.FLAG_DIM_BEHIND.inv()
            }
        }
        onDispose { if (bar > 0) moved.attributes = whole }
    }
}

/** The windows of the dialogs Compose shows in this process. */
private fun dialogWindows(): List<Window> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return emptyList()
    fun find(view: View): Window? = (view as? DialogWindowProvider)?.window
        ?: (view as? ViewGroup)?.let { group -> (0 until group.childCount).firstNotNullOfOrNull { find(group.getChildAt(it)) } }
    return WindowInspector.getGlobalWindowViews().mapNotNull(::find)
}

/** [CallFrame] over a call's [calls] state and waves' [level]. */
@Composable
fun CallFrame(calls: StateFlow<CallState>, level: StateFlow<Float>, onMute: () -> Unit, onEnd: () -> Unit, content: @Composable () -> Unit) {
    val source = remember(calls, level, onMute, onEnd) { CallFrameSource(calls, level, onMute, onEnd) }
    val state by calls.collectAsStateWithLifecycle()
    val density = LocalDensity.current
    val statusTop = with(density) { WindowInsets.statusBars.getTop(this).toDp() }
    val full = CallBarSpec.height(statusTop)
    val shown by animateDpAsState(if (state.isShown) full else 0.dp, tween(CallBarSpec.MOTION_MS, easing = CallBarSpec.easing), label = "call-bar")
    // A bar going away keeps what it last said while it slides out.
    var last by remember { mutableStateOf<CallState>(CallState.Idle) }
    if (state.isShown) last = state
    val visible = shown > 0.dp
    StatusIcons(lightOverBar = visible && shown >= statusTop / 2)
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.zIndex(1f).fillMaxWidth().height(shown).then(if (source.covers > 0) Modifier.clearAndSetSemantics { testTag = CallBarTags.COVERED } else Modifier)) {
            if (visible) {
                CallBar(
                    state = last,
                    level = level,
                    onMute = onMute,
                    onEnd = onEnd,
                    // Its full height, its foot on the box's: it slides out from above the screen.
                    modifier = Modifier.layout { measurable, constraints ->
                        val height = full.roundToPx()
                        val placeable = measurable.measure(constraints.copy(minHeight = height, maxHeight = height))
                        layout(placeable.width, constraints.maxHeight) { placeable.place(0, constraints.maxHeight - height) }
                    },
                    statusTop = statusTop,
                )
            }
        }
        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .consumeWindowInsets(PaddingValues(top = min(shown, statusTop)))
                .testTag(CallBarTags.CONTENT),
        ) { CompositionLocalProvider(LocalCallFrame provides source, content = content) }
    }
}

/**
 * The status bar's icons: light while the bar is under them, the theme's
 * otherwise. A dialog's window keeps the icons it chose: light ones are lent
 * while the bar shows and what it had is given back.
 */
@Composable
private fun StatusIcons(lightOverBar: Boolean) {
    val dark = HappyTheme.colors.dark
    val dialog = (LocalView.current.parent as? DialogWindowProvider)?.window
    val window = dialog ?: LocalContext.current.activity()?.window ?: return
    DisposableEffect(window, lightOverBar, dark) {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (dialog != null) {
            if (!lightOverBar) return@DisposableEffect onDispose {}
            val before = controller.isAppearanceLightStatusBars
            controller.isAppearanceLightStatusBars = false
            return@DisposableEffect onDispose { controller.isAppearanceLightStatusBars = before }
        }
        controller.isAppearanceLightStatusBars = !lightOverBar && !dark
        onDispose { controller.isAppearanceLightStatusBars = !dark }
    }
}

/** [CallFrame]'s bar, [CallBarSpec.height] tall over a status bar of [statusTop]. */
@Composable
fun CallBar(
    state: CallState,
    level: StateFlow<Float>,
    onMute: () -> Unit,
    onEnd: () -> Unit,
    modifier: Modifier = Modifier,
    statusTop: Dp = 0.dp,
) {
    val colors = CallBarSpec.colors(state)
    val start by animateColorAsState(colors[0], tween(CallBarSpec.MOTION_MS), label = "call-start")
    val end by animateColorAsState(colors[1], tween(CallBarSpec.MOTION_MS), label = "call-end")
    val live = state.isLive
    val active = state as? CallState.Active
    val clock = active?.let { rememberClock(it.since) }
    val title = when (state) {
        is CallState.Ended -> problemText(state.problem)
        else -> stringResource(R.string.call_title)
    }
    val subtitle = when (state) {
        CallState.Idle, CallState.Connecting -> stringResource(R.string.voice_status_bar_connecting)
        is CallState.Active -> if (state.muted) listOfNotNull(stringResource(R.string.call_muted), clock).joinToString(" · ") else clock
        is CallState.Ended -> null
    }
    val spoken = when (state) {
        CallState.Idle, CallState.Connecting -> stringResource(R.string.voice_status_bar_connecting)
        is CallState.Active -> if (state.muted) stringResource(R.string.call_muted) else stringResource(
            when (state.activity) {
                CallActivity.Listening -> R.string.call_listening
                CallActivity.UserSpeaking -> R.string.call_user_speaking
                CallActivity.AgentSpeaking -> R.string.call_agent_speaking
            },
        )
        is CallState.Ended -> title
    }
    val context = LocalContext.current
    val summary = listOfNotNull(stringResource(R.string.call_voice_call), spoken, clock.takeIf { live }).joinToString(", ")
    Box(modifier.fillMaxWidth().testTag(CallBarTags.BAR)) {
        CallWavesCanvas(start, end, flat = active == null, level = level, modifier = Modifier.matchParentSize())
        Row(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(CallBarSpec.row)
                .windowInsetsPadding(WindowInsets.systemBars.only(WindowInsetsSides.Horizontal)),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(CallBarSpec.button, CallBarSpec.row)) {
                if (active != null) {
                    BarButton(
                        description = stringResource(if (active.muted) R.string.call_unmute else R.string.call_mute),
                        onClick = onMute,
                        tag = CallBarTags.MUTE,
                        leading = true,
                    ) { Icon(if (active.muted) Ionicon.MicOff else Ionicon.Mic, CallBarSpec.glyph, CallBarSpec.text) }
                }
            }
            Row(
                Modifier
                    .weight(1f)
                    .then(if (state == CallState.Ended(CallProblem.MicrophonePermission)) Modifier.clickable(onClickLabel = stringResource(R.string.call_open_settings)) { context.openAppSettings() } else Modifier)
                    .semantics(mergeDescendants = true) {
                        contentDescription = summary
                        liveRegion = LiveRegionMode.Polite
                    },
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(title, style = CallBarSpec.title, color = CallBarSpec.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false).wrapContentHeight(unbounded = true).testTag(CallBarTags.TITLE))
                if (subtitle != null) {
                    Spacer(Modifier.width(CallBarSpec.titleSpacing))
                    Text(subtitle, style = CallBarSpec.subtitle, color = CallBarSpec.text, maxLines = 1,
                        modifier = Modifier.wrapContentHeight(unbounded = true).testTag(CallBarTags.SUBTITLE))
                }
            }
            Box(Modifier.size(CallBarSpec.button, CallBarSpec.row)) {
                BarButton(
                    description = stringResource(if (live) R.string.call_end else R.string.call_close),
                    onClick = onEnd,
                    tag = CallBarTags.END,
                    leading = false,
                ) {
                    if (live) Icon(MaterialCommunityIcon.PhoneHangup, CallBarSpec.glyph, CallBarSpec.text)
                    else Icon(Ionicon.Close, CallBarSpec.glyph, CallBarSpec.text)
                }
            }
        }
    }
}

/**
 * A [CallBarSpec.touch] square touch box standing on the bar's foot at the
 * bar's side, so it reaches up into the bar and in toward the title, never
 * below the bar; its glyph [CallBarSpec.sideInset] in from the bar's side,
 * in the row. It dims while pressed.
 */
@Composable
private fun BarButton(description: String, onClick: () -> Unit, tag: String, leading: Boolean, glyph: @Composable () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        Modifier
            .fillMaxSize()
            .layout { measurable, constraints ->
                val side = CallBarSpec.touch.roundToPx()
                val placeable = measurable.measure(Constraints.fixed(side, side))
                layout(constraints.maxWidth, constraints.maxHeight) {
                    placeable.place(if (leading) 0 else constraints.maxWidth - side, constraints.maxHeight - side)
                }
            }
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description }
            .testTag(tag),
    ) {
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(CallBarSpec.row)
                .padding(start = if (leading) CallBarSpec.sideInset else 0.dp, end = if (leading) 0.dp else CallBarSpec.sideInset)
                .alpha(if (pressed) 0.5f else 1f),
            contentAlignment = if (leading) Alignment.CenterStart else Alignment.CenterEnd,
        ) { glyph() }
    }
}

/** The three waves, each filling from the bar's top down to its crest in the bar's gradient, the lower two fainter. */
@Composable
private fun CallWavesCanvas(start: Color, end: Color, flat: Boolean, level: StateFlow<Float>, modifier: Modifier) {
    val reduceMotion = rememberReduceMotion()
    val context = LocalContext.current
    val saver = remember(context) { context.getSystemService(Context.POWER_SERVICE) as? PowerManager }
    val waves = remember { CallWaves() }
    val still = flat || reduceMotion || saver?.isPowerSaveMode == true
    var frame by remember { mutableLongStateOf(0L) }
    LaunchedEffect(still) {
        if (still) return@LaunchedEffect
        var previous = 0L
        while (true) {
            withFrameNanos { now ->
                if (previous != 0L) waves.advance(((now - previous) / 1e9f).coerceAtMost(0.1f))
                previous = now
                waves.update(level.value)
                frame = now
            }
        }
    }
    val overhang = CallWaves.OVERHANG.dp
    Canvas(modifier.requiredHeightOver(overhang)) {
        frame // Redrawn each frame while it moves.
        waves.scale = density
        val bar = size.height - overhang.toPx()
        val brush = Brush.horizontalGradient(listOf(start, end), startX = 0f, endX = size.width * 2f)
        val crests = waves.crests(size.width, bar, still)
        crests.forEachIndexed { index, crest ->
            val path = Path().apply {
                moveTo(0f, 0f)
                lineTo(crest.start.x, crest.start.y)
                for (segment in crest.segments) cubicTo(segment.control1.x, segment.control1.y, segment.control2.x, segment.control2.y, segment.to.x, segment.to.y)
                lineTo(size.width, 0f)
                close()
            }
            drawPath(path, brush, alpha = CallWaves.ALPHAS[index])
        }
    }
}

/** The box's own height plus [extra] below it, drawn past its foot. */
private fun Modifier.requiredHeightOver(extra: Dp): Modifier = this.then(
    Modifier.layout { measurable, constraints ->
        val height = constraints.maxHeight + extra.roundToPx()
        val placeable = measurable.measure(constraints.copy(minHeight = height, maxHeight = height))
        layout(placeable.width, constraints.maxHeight) { placeable.place(0, 0) }
    },
)

/** The call's clock, m:ss, once a half second. */
@Composable
private fun rememberClock(since: Long): String {
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(since) {
        while (true) {
            now = SystemClock.elapsedRealtime()
            delay(500)
        }
    }
    return CallController.clock(((now - since) / 1000).coerceAtLeast(0))
}

@Composable
private fun problemText(problem: CallProblem): String = stringResource(
    when (problem) {
        CallProblem.NotSetUp -> R.string.call_not_set_up
        CallProblem.MicrophonePermission -> R.string.call_microphone
        CallProblem.SubscriptionRequired -> R.string.call_subscription
        CallProblem.LimitReached -> R.string.call_limit
        CallProblem.Authentication -> R.string.call_authentication
        CallProblem.Connection -> R.string.call_connection
    },
)

private fun Context.openAppSettings() {
    startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}
