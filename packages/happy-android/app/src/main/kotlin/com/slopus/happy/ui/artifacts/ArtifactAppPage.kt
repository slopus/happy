package com.slopus.happy.ui.artifacts

import android.os.Build
import android.view.WindowManager
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.slopus.happy.R
import com.slopus.happy.artifacts.AppClose
import com.slopus.happy.ui.browser.BrowserAppMode
import com.slopus.happy.ui.browser.BrowserAppMode.Sides
import com.slopus.happy.ui.browser.BrowserPage
import com.slopus.happy.ui.browser.BrowserState
import com.slopus.happy.ui.browser.BrowserView
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.PageDialog
import kotlinx.coroutines.delay

object ArtifactAppPageTags {
    const val PAGE = "artifact.app"
    const val CLOSE = "artifact.app.close"

    /** The opacity the close button is at or going to. */
    val CloseAlpha = SemanticsPropertyKey<Float>("ArtifactAppCloseAlpha")
}

/** The close button over an app (task_206's fullscreen-spec.md and its addendum, iOS's alike). */
object ArtifactAppPageSpec {
    /** The button's circle. */
    val button = 32.dp
    /** Around it, inside the safe area's corner. */
    val margin = 8.dp
    /** The button and its margins: the box the page keeps clear, and the 48 its edge's inset grows by. */
    val box = button + margin * 2
    /** The × in it. */
    val glyph = 18.dp
    /** A touch this near the button wakes it. */
    val wakeRadius = 64.dp
    /** With no button (`none`): a swipe down that starts this near the top, and goes this far, shows it. */
    val revealEdge = 24.dp
    // Small: the system takes a pull from the top edge for itself a move or two in.
    val revealDrag = 8.dp
    /** Fully there this long after opening or a touch near it, then faded (hidden, with no button). */
    const val AWAKE_MS = 3_000L
    const val FADED_ALPHA = 0.35f
    const val FADE_MS = 300
    /** The circle: black at 45% with a white hairline, readable over any page (Android has no material blur behind a WebView). */
    val fill = Color.Black.copy(alpha = 0.45f)
    val hairline = Color.White.copy(alpha = 0.18f)

    /**
     * Where [close]'s box is in a page of [width] × [height] with the [safe]
     * sides, all in dp: in its corner of the safe area, start and end by
     * [rtl]. `none` shows its button, when revealed, where top-start's is.
     */
    fun box(close: AppClose, width: Float, height: Float, safe: Sides, rtl: Boolean): BrowserAppMode.Box {
        val side = box.value
        val left = close.start != rtl
        val x = if (left) safe.left else width - safe.right - side
        val y = if (close.top) safe.top else height - safe.bottom - side
        return BrowserAppMode.Box(x, y, side, side)
    }

    /** What the page is told: the safe sides with the box's 48 on its edge, and the box; plain sides and none for `none`. */
    fun layout(close: AppClose, width: Float, height: Float, safe: Sides, rtl: Boolean): Pair<Sides, BrowserAppMode.Box?> {
        val side = box.value
        return when {
            close == AppClose.None -> safe to null
            close.top -> safe.copy(top = safe.top + side) to box(close, width, height, safe, rtl)
            else -> safe.copy(bottom = safe.bottom + side) to box(close, width, height, safe, rtl)
        }
    }
}

/**
 * An HTML artifact that asks to run as an app (`happy-page-mode: app`),
 * full screen over everything (task_206's fullscreen-spec.md, Android): a
 * dialog window edge to edge into the display cutout, the system bars
 * hidden and shown again when it closes; swiped in, they go again after
 * [ArtifactAppPageSpec.AWAKE_MS]. They are hidden with
 * [WindowInsetsControllerCompat.BEHAVIOR_DEFAULT], not
 * SHOW_TRANSIENT_BARS_BY_SWIPE: with that one SystemUI turns the back
 * gesture off while the navigation bar is hidden, and back must always
 * work. The page fills it ([BrowserView] with [BrowserAppMode]): no
 * scrolling, zoom, pull to reload or selection, the window's unsafe sides
 * as `--happy-app-inset-*` with the close button's room on its edge, the
 * button's box, and `happyApp.close()`. System back always closes it;
 * nothing excludes the back gesture. The close button ([AppCloseButton])
 * sits in the corner [close] names, or, for `none`, shows only when a swipe
 * down from the top asks for it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ArtifactAppPage(
    state: BrowserState,
    prepare: suspend () -> BrowserPage,
    computer: String,
    close: AppClose,
    onClose: () -> Unit,
    onOpenElsewhere: (String) -> Unit = {},
    artifactLink: (artifactId: String) -> String? = { null },
) {
    var open by remember { mutableStateOf(true) }
    if (!open) return
    val leave = {
        if (open) {
            open = false
            onClose()
        }
    }
    PageDialog(
        onDismissRequest = leave,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect {
            window?.setDimAmount(0f)
            window?.setBackgroundDrawableResource(android.R.color.black)
        }
        val bars = remember(window) { window?.let { WindowCompat.getInsetsController(it, it.decorView) } }
        DisposableEffect(window) {
            val shown = window ?: return@DisposableEffect onDispose {}
            shown.attributes = shown.attributes.apply {
                layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                } else {
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                }
            }
            // Edge gestures stay live while the bars are hidden: a swipe from the side is back at once.
            bars?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_DEFAULT
            bars?.hide(WindowInsetsCompat.Type.systemBars())
            // The app's own window never hid its bars; this one gives them back as it goes.
            onDispose { bars?.show(WindowInsetsCompat.Type.systemBars()) }
        }
        // Swiped in, the bars stay a while and go again (and with no button, the swipe shows it).
        // Read from the window itself: in a dialog, Compose's areSystemBarsVisible never turns true.
        var barsShown by remember { mutableStateOf(false) }
        DisposableEffect(window) {
            val decor = window?.decorView ?: return@DisposableEffect onDispose {}
            // Only once hidden: the window can still have them as it opens.
            var hidden = false
            ViewCompat.setOnApplyWindowInsetsListener(decor) { view, insets ->
                val visible = insets.isVisible(WindowInsetsCompat.Type.statusBars()) || insets.isVisible(WindowInsetsCompat.Type.navigationBars())
                if (!visible) hidden = true
                barsShown = visible && hidden
                ViewCompat.onApplyWindowInsets(view, insets)
            }
            onDispose { ViewCompat.setOnApplyWindowInsetsListener(decor, null) }
        }
        LaunchedEffect(barsShown) {
            if (!barsShown) return@LaunchedEffect
            delay(ArtifactAppPageSpec.AWAKE_MS)
            bars?.hide(WindowInsetsCompat.Type.systemBars())
        }
        val onClose by rememberUpdatedState(leave)
        val app = remember(close) { BrowserAppMode(close) { onClose() } }
        val density = LocalDensity.current
        // The cutout, and any bar the system keeps showing; hidden bars take no room.
        val unsafe = WindowInsets.systemBars.union(WindowInsets.displayCutout)
        val safe = with(density) {
            Sides(
                unsafe.getTop(density).toDp().value,
                unsafe.getRight(density, LayoutDirection.Ltr).toDp().value,
                unsafe.getBottom(density).toDp().value,
                unsafe.getLeft(density, LayoutDirection.Ltr).toDp().value,
            )
        }
        AppFrame(safe, close, leave, reveal = barsShown, onLayout = app::layout) {
            BrowserView(
                state,
                prepare = prepare,
                computer = computer,
                onOpenElsewhere = onOpenElsewhere,
                artifactLink = artifactLink,
                app = app,
            )
        }
    }
}

/**
 * The page under its close button, in [close]'s corner of the [safe] area
 * ([ArtifactAppPageSpec.box]); it says what the page is told to [onLayout].
 * Any touch within [ArtifactAppPageSpec.wakeRadius] of the button wakes it,
 * and goes on to the page. With no button (`none`) it is hidden until a
 * swipe down from the top [ArtifactAppPageSpec.revealEdge] or [reveal]
 * (the bars swiped in) shows it in the top-start corner for
 * [ArtifactAppPageSpec.AWAKE_MS].
 */
@Composable
internal fun AppFrame(
    safe: Sides,
    close: AppClose,
    onClose: () -> Unit,
    reveal: Boolean = false,
    onLayout: (Sides, BrowserAppMode.Box?) -> Unit = { _, _ -> },
    page: @Composable () -> Unit,
) {
    var wakes by remember { mutableIntStateOf(0) }
    LaunchedEffect(reveal) { if (reveal && close == AppClose.None) wakes++ }
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .testTag(ArtifactAppPageTags.PAGE),
    ) {
        val width = maxWidth.value
        val height = maxHeight.value
        val box = ArtifactAppPageSpec.box(if (close == AppClose.None) AppClose.TopStart else close, width, height, safe, rtl)
        val told = ArtifactAppPageSpec.layout(close, width, height, safe, rtl)
        SideEffect { onLayout(told.first, told.second) }
        Box(
            Modifier
                .fillMaxSize()
                .pointerInput(box, close) {
                    val spec = ArtifactAppPageSpec
                    awaitPointerEventScope {
                        var from: Offset? = null
                        while (true) {
                            // Seen on the way down, never taken: the page still gets every touch.
                            val event = awaitPointerEvent(PointerEventPass.Initial)
                            val change = event.changes.firstOrNull() ?: continue
                            when {
                                event.type == PointerEventType.Press && close == AppClose.None ->
                                    from = change.position.takeIf { it.y <= spec.revealEdge.toPx() }
                                event.type == PointerEventType.Press -> {
                                    val near = Rect(box.x.dp.toPx(), box.y.dp.toPx(), (box.x + box.width).dp.toPx(), (box.y + box.height).dp.toPx())
                                        .deflate(spec.margin.toPx())
                                        .inflate(spec.wakeRadius.toPx())
                                    if (event.changes.any { it.pressed && near.contains(it.position) }) wakes++
                                }
                                event.type == PointerEventType.Move -> from?.let { start ->
                                    if (change.position.y - start.y >= spec.revealDrag.toPx()) {
                                        from = null
                                        wakes++
                                    }
                                }
                                event.type == PointerEventType.Release -> from = null
                            }
                        }
                    }
                },
        ) {
            page()
            AppCloseButton(
                wakes = wakes,
                onClose = onClose,
                hidden = close == AppClose.None,
                modifier = Modifier.align(AbsoluteAlignment.TopLeft).absoluteOffset((box.x.dp + ArtifactAppPageSpec.margin), (box.y.dp + ArtifactAppPageSpec.margin)),
            )
        }
    }
}

/**
 * The × that closes an app: a [ArtifactAppPageSpec.button] circle, fully
 * there for [ArtifactAppPageSpec.AWAKE_MS] after it opens and after each
 * wake ([wakes] changing), then at [ArtifactAppPageSpec.FADED_ALPHA]; or,
 * [hidden], there only for that long after a wake, and otherwise not at all
 * (not drawn, tapped or read). Read as "Close" by TalkBack.
 */
@Composable
internal fun AppCloseButton(wakes: Int, onClose: () -> Unit, modifier: Modifier = Modifier, hidden: Boolean = false) {
    var awake by remember { mutableStateOf(!hidden) }
    LaunchedEffect(wakes) {
        if (hidden && wakes == 0) return@LaunchedEffect
        awake = true
        delay(ArtifactAppPageSpec.AWAKE_MS)
        awake = false
    }
    val target = if (awake) 1f else if (hidden) 0f else ArtifactAppPageSpec.FADED_ALPHA
    val alpha by animateFloatAsState(
        target,
        tween(ArtifactAppPageSpec.FADE_MS),
        label = "app-close",
    )
    val label = stringResource(R.string.browser_close)
    val gone = hidden && !awake
    Box(
        modifier
            .size(ArtifactAppPageSpec.button)
            .graphicsLayer { this.alpha = alpha }
            .clip(CircleShape)
            .background(ArtifactAppPageSpec.fill)
            .border(Dp.Hairline, ArtifactAppPageSpec.hairline, CircleShape)
            .clickable(enabled = !gone, role = Role.Button, onClickLabel = label, onClick = onClose)
            .semantics {
                contentDescription = label
                this[ArtifactAppPageTags.CloseAlpha] = target
                if (gone) hideFromAccessibility()
            }
            .testTag(ArtifactAppPageTags.CLOSE),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Ionicon.Close, ArtifactAppPageSpec.glyph, Color.White)
    }
}
