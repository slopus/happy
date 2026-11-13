package com.slopus.happy.ui.conversation

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.res.Configuration
import android.os.Build
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsAnimation
import android.view.animation.PathInterpolator
import androidx.annotation.RequiresApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.offset
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.slopus.happy.ui.components.GlassTravel
import com.slopus.happy.R
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The keyboard as Telegram's AdjustPanLayoutHelper moves a chat for it
 * (`ui/ActionBar/AdjustPanLayoutHelper.java`): the layout takes the
 * keyboard's height once, at whichever end of its animation that is lower
 * ([rest]: as a hide starts, as a show ends), and on every frame between,
 * what rides it is only drawn higher ([lift], a translation), with no
 * composition, measure, placement or positioned callback.
 *
 * The frames come from [KeyboardMotion]: on Android 11+ the IME's own
 * animation (`WindowInsetsAnimation.Callback`, AdjustPanLayoutHelper's
 * inset-animator path), which it also keeps from the Compose tree, so
 * Compose's own insets don't animate a layout under it; before Android 11,
 * Telegram's 250 ms on cubic-bezier(0.199, 0.011, 0.279, 0.910), from
 * where the keyboard was to where the window says it is, as
 * AdjustPanLayoutHelper's pre-draw path animates. Read [rest] only where
 * things are measured or placed, [lift] and [travel] only where they draw.
 */
@Stable
class KeyboardLift internal constructor(private val motion: KeyboardMotion) {
    /** The keyboard's height over the navigation bar that the layout is given, in pixels. Read where it lays out or places, not where it composes. */
    val rest: Int get() = motion.rest

    /** How far above [rest] the keyboard is this frame, in pixels. Read only where things draw. */
    val lift: Int get() = motion.lift

    /**
     * The tallest the keyboard has come to rest at in this orientation since
     * the app started, in pixels over the navigation bar: what [reservingKeyboard]
     * keeps clear whether the keyboard is up or not. Read where it lays out.
     */
    val reserve: Int get() = motion.reserve

    /** The keyboard's height over the navigation bar this frame, in pixels. Read only where things draw. */
    val now: Int get() = motion.now

    /**
     * What is placed [aboveKeyboard] travels with it: up by the keyboard's
     * height over the navigation bar this frame, between where its animation
     * started and where it ends. The glass over the transcript blurs the band
     * the whole way passes under it once ([GlassTravel]). Read where it draws.
     */
    val travel: GlassTravel get() = motion
}

/**
 * The window's keyboard for the [KeyboardLift]s on it (one per Compose
 * window, shared): held by the screens that ride it while they are started.
 *
 * Held, it sits on the Compose view's parent: an insets listener reads the
 * keyboard's height from what is applied to the window, and on Android 11+
 * a `WindowInsetsAnimation.Callback` with `DISPATCH_MODE_STOP` follows the
 * IME's animation frame by frame, as AdjustPanLayoutHelper's does, and
 * keeps the animation from the Compose view below it. Compose's
 * `WindowInsets` then take the keyboard's end state as it starts and hold
 * it, instead of being dispatched every frame (the `insets_animation` and
 * the measure each frame cost before; research/telegram-chat.md). Nothing in
 * a screen that rides the keyboard reads them.
 */
internal class KeyboardMotion private constructor(private val host: View?) : GlassTravel {
    private var restState by mutableIntStateOf(0)
    private var nowState by mutableIntStateOf(0)
    private var fromState by mutableIntStateOf(0)
    private var toState by mutableIntStateOf(0)
    private var reserveState by mutableIntStateOf(0)

    val rest: Int get() = restState
    val reserve: Int get() = reserveState
    override val now: Int get() = nowState
    override val from: Int get() = fromState
    override val to: Int get() = toState
    override val lift: Int get() = (nowState - restState).coerceAtLeast(0)

    /** The keyboard's height in what was last applied to the window: where it is going, or is. */
    private var applied = 0
    private var animating = false
    private var fallback: ValueAnimator? = null
    private var users = 0

    init {
        // Made in composition: written, not sent.
        settle(host?.let(::current) ?: 0, send = false)
    }

    fun acquire() {
        if (users++ == 0) install()
    }

    fun release() {
        if (--users == 0) uninstall()
    }

    private fun install() {
        val host = host ?: return
        applied = current(host)
        settle(applied)
        host.setOnApplyWindowInsetsListener { view, insets ->
            // A turn of the phone comes with new insets: the other orientation's keyboard is reserved.
            reserveState = tallest[orientation()]
            applied(above(WindowInsetsCompat.toWindowInsetsCompat(insets, view)))
            view.onApplyWindowInsets(insets)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) host.setWindowInsetsAnimationCallback(Follow())
    }

    private fun uninstall() {
        val host = host ?: return
        host.setOnApplyWindowInsetsListener(null)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) host.setWindowInsetsAnimationCallback(null)
        settle(applied)
    }

    /**
     * The window's insets have the keyboard [height] high. Mid-animation that
     * is where it ends: the layout takes the lower of its two ends. Otherwise
     * it is there now, or, before Android 11, Telegram's animation takes it
     * there.
     */
    private fun applied(height: Int) {
        applied = height
        when {
            animating && fallback == null -> {
                toState = height
                restState = min(fromState, height)
                send()
            }
            height == toState && (animating || height == nowState) -> Unit
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> settle(height)
            else -> animate(height)
        }
    }

    private fun begin() {
        fallback?.cancel()
        fallback = null
        animating = true
        fromState = nowState
        toState = nowState
    }

    /** AdjustPanLayoutHelper's pre-draw path: 250 ms on its curve from where the keyboard is to [height]. */
    private fun animate(height: Int) {
        begin()
        toState = height
        restState = min(fromState, height)
        val start = fromState
        val animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = KeyboardSpec.DURATION_MS
            interpolator = KeyboardSpec.interpolator
            addUpdateListener { move((start + (height - start) * it.animatedFraction).roundToInt()) }
            addListener(object : AnimatorListenerAdapter() {
                private var cancelled = false
                override fun onAnimationCancel(animation: Animator) {
                    cancelled = true
                }
                override fun onAnimationEnd(animation: Animator) {
                    if (cancelled || fallback !== animation) return
                    settle(applied)
                }
            })
        }
        fallback = animator
        send()
        animator.start()
    }

    private fun move(height: Int) {
        if (height == nowState) return
        nowState = height
        send()
    }

    private fun settle(height: Int, send: Boolean = true) {
        fallback = null
        animating = false
        val orientation = orientation()
        tallest[orientation] = maxOf(tallest[orientation], height)
        reserveState = tallest[orientation]
        restState = height
        nowState = height
        fromState = height
        toState = height
        if (send) send()
    }

    private fun orientation(): Int = if (host?.resources?.configuration?.orientation == Configuration.ORIENTATION_LANDSCAPE) 1 else 0

    /** Observers learn of the writes now, so this frame's layout and draw see them, as Compose's own insets do. */
    private fun send() = Snapshot.sendApplyNotifications()

    @RequiresApi(Build.VERSION_CODES.R)
    private inner class Follow : WindowInsetsAnimation.Callback(DISPATCH_MODE_STOP) {
        override fun onPrepare(animation: WindowInsetsAnimation) {
            if (animation.ime) begin()
        }

        override fun onProgress(insets: WindowInsets, running: MutableList<WindowInsetsAnimation>): WindowInsets {
            if (animating && running.any { it.ime }) move(above(WindowInsetsCompat.toWindowInsetsCompat(insets, host)))
            return insets
        }

        override fun onEnd(animation: WindowInsetsAnimation) {
            if (animation.ime && animating) settle(applied)
        }
    }

    companion object {
        /** The tallest resting keyboard seen, upright and on its side, for the whole process: a new window starts with it. */
        private val tallest = IntArray(2)

        /**
         * The motion of [view]'s window, kept on its parent (the Compose view's own insets callbacks
         * are Compose's) as a tag, so it goes with the window.
         */
        fun of(view: View): KeyboardMotion {
            val host = view.parent as? View ?: return KeyboardMotion(null)
            return host.getTag(R.id.keyboard_motion) as? KeyboardMotion ?: KeyboardMotion(host).also { host.setTag(R.id.keyboard_motion, it) }
        }

        private val WindowInsetsAnimation.ime: Boolean
            @RequiresApi(Build.VERSION_CODES.R) get() = typeMask and WindowInsets.Type.ime() != 0

        private fun current(view: View): Int = ViewCompat.getRootWindowInsets(view)?.let(::above) ?: 0

        /** The keyboard's height over the navigation bar. */
        private fun above(insets: WindowInsetsCompat): Int =
            (insets.getInsets(WindowInsetsCompat.Type.ime()).bottom - insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom).coerceAtLeast(0)
    }
}

/** Telegram's keyboard motion (AdjustPanLayoutHelper's `keyboardDuration` and `keyboardInterpolator`, ChatListItemAnimator's). */
object KeyboardSpec {
    const val DURATION_MS = 250L
    val interpolator = PathInterpolator(0.199f, 0.011f, 0.279f, 0.910f)
}

/** The window's [KeyboardLift], held while this screen is started. */
@Composable
fun rememberKeyboardLift(): KeyboardLift {
    val view = LocalView.current
    val motion = remember(view) { KeyboardMotion.of(view) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(motion, lifecycle) {
        var held = false
        fun hold(now: Boolean) {
            if (now == held) return
            held = now
            if (now) motion.acquire() else motion.release()
        }
        // Started, not composed: a screen kept under another doesn't hold the window's keyboard from it.
        val observer = LifecycleEventObserver { _, _ -> hold(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            hold(false)
        }
    }
    return remember(motion) { KeyboardLift(motion) }
}

/**
 * Drawn [KeyboardLift.lift] higher ([share] of it: half for what sits
 * centred between the bar and the dock), as AdjustPanLayoutHelper's
 * `onPanTranslationUpdate` sets a View's translation: a frame of the
 * keyboard draws this node again (a translation and its layer), and
 * nothing is composed, measured or placed for it. Its own layer inside, so
 * the content isn't recorded again, and one outside, so the parent isn't.
 */
fun Modifier.riding(keyboard: KeyboardLift, share: Float = 1f): Modifier =
    graphicsLayer()
        .drawWithContent { translate(0f, -(keyboard.lift * share).toInt().toFloat()) { this@drawWithContent.drawContent() } }
        .graphicsLayer()

/**
 * Placed above the keyboard: [KeyboardLift.rest] higher, read where it is
 * placed, so the keyboard settling moves it and lays nothing out, and drawn
 * [KeyboardLift.lift] higher on top ([riding]), for what doesn't need the
 * room above the keyboard to measure (the dock's fade, the jump button).
 */
fun Modifier.aboveKeyboard(keyboard: KeyboardLift): Modifier =
    offset { IntOffset(0, -keyboard.rest) }.riding(keyboard)

/**
 * Where the keyboard at its tallest ([KeyboardLift.reserve]) would leave
 * this, up or not: in a column laid out above the keyboard
 * ([keyboardPadding]) and drawn with it ([riding]), the room this fills
 * ends that far over the keyboard's foot at every frame, so what is centred
 * in it never moves as the keyboard comes and goes. Only a keyboard taller
 * than any before moves it, on by half what it adds, frame by frame, as
 * [riding] at half moves what is centred; it then holds there.
 */
fun Modifier.reservingKeyboard(keyboard: KeyboardLift): Modifier =
    layout { measurable, constraints ->
        // The column ends [rest] over the keyboard's foot; the room ends at the reserve.
        val room = (keyboard.reserve - keyboard.rest).coerceAtLeast(0)
        val placeable = measurable.measure(constraints.offset(vertical = -room))
        layout(placeable.width, constraints.constrainHeight(placeable.height + room)) { placeable.place(0, 0) }
    }
        .graphicsLayer()
        .drawWithContent {
            // The column is drawn [lift] higher; undone, less half of what the keyboard goes past the reserve.
            val reserve = keyboard.reserve
            val past = (maxOf(reserve, keyboard.now) - maxOf(reserve, keyboard.rest)) / 2
            translate(0f, (keyboard.lift - past).toFloat()) { this@drawWithContent.drawContent() }
        }
        .graphicsLayer()

/**
 * [bottom] and the keyboard's [KeyboardLift.rest] of room kept under this,
 * read where it is laid out: the keyboard settling measures it again and
 * composes nothing.
 */
fun Modifier.keyboardPadding(keyboard: KeyboardLift, bottom: Dp = 0.dp): Modifier = layout { measurable, constraints ->
    val room = bottom.roundToPx() + keyboard.rest
    val placeable = measurable.measure(constraints.offset(vertical = -room))
    layout(placeable.width, constraints.constrainHeight(placeable.height + room)) { placeable.place(0, 0) }
}

/**
 * The padding of a list placed [aboveKeyboard] at its whole height: the
 * keyboard's [KeyboardLift.rest] goes over its top, which is then that far
 * above the screen, so its oldest end still rests under the bar. The list
 * keeps its height and its rows where the keyboard comes and goes: none
 * is composed or placed again as it settles, and those it uncovers are
 * already there. Read as the list lays out.
 */
@Stable
class KeyboardPadding(private val top: Dp, private val bottom: Dp, private val keyboard: KeyboardLift, private val density: Density) : PaddingValues {
    override fun calculateTopPadding(): Dp = top + with(density) { keyboard.rest.toDp() }
    override fun calculateBottomPadding(): Dp = bottom
    override fun calculateLeftPadding(layoutDirection: LayoutDirection): Dp = 0.dp
    override fun calculateRightPadding(layoutDirection: LayoutDirection): Dp = 0.dp
}
