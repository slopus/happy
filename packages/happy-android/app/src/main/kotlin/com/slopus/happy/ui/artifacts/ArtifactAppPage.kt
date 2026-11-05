package com.slopus.happy.ui.artifacts

import android.os.Build
import android.view.WindowManager
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.slopus.happy.R
import com.slopus.happy.ui.browser.BrowserAppMode
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

/** The close button over an app (task_206's fullscreen-spec.md, iOS's alike). */
object ArtifactAppPageSpec {
    /** The button's circle. */
    val button = 32.dp
    /** From the safe area's top-start corner. */
    val margin = 8.dp
    /** The × in it. */
    val glyph = 18.dp
    /** A touch this near the button wakes it. */
    val wakeRadius = 64.dp
    /** Fully there this long after opening or a touch near it, then faded. */
    const val AWAKE_MS = 3_000L
    const val FADED_ALPHA = 0.35f
    const val FADE_MS = 300
    /** The circle: black at 45% with a white hairline, readable over any page (Android has no material blur behind a WebView). */
    val fill = Color.Black.copy(alpha = 0.45f)
    val hairline = Color.White.copy(alpha = 0.18f)

    /** The page's top inset: the safe area's top, then the button with a margin above and below. */
    fun topInset(safeTop: Dp): Dp = safeTop + margin + button + margin
}

/**
 * An HTML artifact that asks to run as an app (`happy-page-mode: app`),
 * full screen over everything (task_206's fullscreen-spec.md, Android): a
 * dialog window edge to edge into the display cutout, the system bars
 * hidden until swiped in and shown again when it closes. They are hidden
 * with [WindowInsetsControllerCompat.BEHAVIOR_DEFAULT], not the spec's
 * SHOW_TRANSIENT_BARS_BY_SWIPE: with that one SystemUI turns the back
 * gesture off while the navigation bar is hidden, and back must always
 * work. The page fills it ([BrowserView] with [BrowserAppMode]): no
 * scrolling, zoom, pull to reload or selection, the
 * window's unsafe sides as `--happy-app-inset-*`, the close button's room
 * on top. System back always closes it; nothing excludes the back gesture.
 * The close button ([AppCloseButton]) is the other way out.
 */
@Composable
fun ArtifactAppPage(
    state: BrowserState,
    prepare: suspend () -> BrowserPage,
    computer: String,
    onClose: () -> Unit,
    onOpenElsewhere: (String) -> Unit = {},
    artifactLink: (artifactId: String) -> String? = { null },
) {
    var open by remember { mutableStateOf(true) }
    if (!open) return
    val close = {
        open = false
        onClose()
    }
    PageDialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect {
            window?.setDimAmount(0f)
            window?.setBackgroundDrawableResource(android.R.color.black)
        }
        DisposableEffect(window) {
            val shown = window ?: return@DisposableEffect onDispose {}
            shown.attributes = shown.attributes.apply {
                layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                } else {
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                }
            }
            val bars = WindowCompat.getInsetsController(shown, shown.decorView)
            // Edge gestures stay live while the bars are hidden: a swipe from the side is back at once.
            bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_DEFAULT
            bars.hide(WindowInsetsCompat.Type.systemBars())
            // The app's own window never hid its bars; this one gives them back as it goes.
            onDispose { bars.show(WindowInsetsCompat.Type.systemBars()) }
        }
        val app = remember { BrowserAppMode() }
        val density = LocalDensity.current
        val direction = LocalLayoutDirection.current
        // The cutout, and any bar the system keeps showing; hidden bars take no room.
        val unsafe = WindowInsets.systemBars.union(WindowInsets.displayCutout)
        val top = with(density) { unsafe.getTop(density).toDp() }
        val bottom = with(density) { unsafe.getBottom(density).toDp() }
        val left = with(density) { unsafe.getLeft(density, direction).toDp() }
        val right = with(density) { unsafe.getRight(density, direction).toDp() }
        SideEffect { app.insets(ArtifactAppPageSpec.topInset(top).value, right.value, bottom.value, left.value) }
        val start = if (direction == LayoutDirection.Ltr) left else right
        AppFrame(top, start, close) {
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
 * The page under its close button, [ArtifactAppPageSpec.margin] in from the
 * safe area's top-start corner ([safeTop], [safeStart]). Any touch within
 * [ArtifactAppPageSpec.wakeRadius] of the button wakes it, and goes on to the page.
 */
@Composable
internal fun AppFrame(safeTop: Dp, safeStart: Dp, onClose: () -> Unit, page: @Composable () -> Unit) {
    var wakes by remember { mutableIntStateOf(0) }
    val direction = LocalLayoutDirection.current
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .pointerInput(safeTop, safeStart, direction) {
                val spec = ArtifactAppPageSpec
                awaitPointerEventScope {
                    while (true) {
                        // Seen on the way down, never taken: the page still gets every touch.
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        if (event.type != PointerEventType.Press) continue
                        val side = spec.button.toPx()
                        val inset = (safeStart + spec.margin).toPx()
                        val x = if (direction == LayoutDirection.Ltr) inset else size.width - inset - side
                        val y = (safeTop + spec.margin).toPx()
                        val near = Rect(x, y, x + side, y + side).inflate(spec.wakeRadius.toPx())
                        if (event.changes.any { it.pressed && near.contains(it.position) }) wakes++
                    }
                }
            }
            .testTag(ArtifactAppPageTags.PAGE),
    ) {
        page()
        // Aligned to the start and padded from it, so it mirrors with the layout.
        AppCloseButton(
            wakes = wakes,
            onClose = onClose,
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(start = safeStart + ArtifactAppPageSpec.margin, top = safeTop + ArtifactAppPageSpec.margin),
        )
    }
}

/**
 * The × that closes an app: a [ArtifactAppPageSpec.button] circle, fully
 * there for [ArtifactAppPageSpec.AWAKE_MS] after it opens and after each
 * wake ([wakes] changing), then at [ArtifactAppPageSpec.FADED_ALPHA]. Read
 * as "Close" by TalkBack.
 */
@Composable
internal fun AppCloseButton(wakes: Int, onClose: () -> Unit, modifier: Modifier = Modifier) {
    var awake by remember { mutableStateOf(true) }
    LaunchedEffect(wakes) {
        awake = true
        delay(ArtifactAppPageSpec.AWAKE_MS)
        awake = false
    }
    val target = if (awake) 1f else ArtifactAppPageSpec.FADED_ALPHA
    val alpha by animateFloatAsState(
        target,
        tween(ArtifactAppPageSpec.FADE_MS),
        label = "app-close",
    )
    val label = stringResource(R.string.browser_close)
    Box(
        modifier
            .size(ArtifactAppPageSpec.button)
            .graphicsLayer { this.alpha = alpha }
            .clip(CircleShape)
            .background(ArtifactAppPageSpec.fill)
            .border(Dp.Hairline, ArtifactAppPageSpec.hairline, CircleShape)
            .clickable(role = Role.Button, onClickLabel = label, onClick = onClose)
            .semantics {
                contentDescription = label
                this[ArtifactAppPageTags.CloseAlpha] = target
            }
            .testTag(ArtifactAppPageTags.CLOSE),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Ionicon.Close, ArtifactAppPageSpec.glyph, Color.White)
    }
}
