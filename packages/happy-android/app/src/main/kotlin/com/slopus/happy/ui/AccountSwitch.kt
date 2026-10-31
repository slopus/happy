package com.slopus.happy.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import com.slopus.happy.AppGraph
import com.slopus.happy.OpenAccount
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * How long one account's screens take to dissolve into the next's: iOS's
 * `AppCoordinator.rootCrossfade`, 0.28 s, on UIKit's default ease-in-out. A
 * dissolve is already the reduced-motion form, so it stays with animations
 * reduced (removed, it is instant).
 */
object RootDissolveSpec {
    const val MILLIS = 280
    val easing = CubicBezierEasing(0.42f, 0f, 0.58f, 1f)
}

/**
 * iOS's `UIView.transition(.transitionCrossDissolve)` over a view (the
 * window's screens, or Settings' scrolling part): a picture of what it
 * shows is laid over it, the change is made under it, and once the new
 * content has drawn its first frame (however long that takes) the picture
 * fades away. Nothing is composed twice, and touches go through to what is
 * underneath.
 */
@Stable
class Dissolve {
    internal var layer: GraphicsLayer? = null
    internal var cover by mutableStateOf<ImageBitmap?>(null)
    internal val alpha = Animatable(1f)

    /** Whether a picture of the old screens is showing, for tests. */
    val dissolving: Boolean get() = cover != null

    /** Makes [change] under a picture of the screens as they are, then dissolves the picture away. */
    suspend fun around(change: suspend () -> Unit) {
        val shot = layer?.takeIf { it.size.width > 0 && it.size.height > 0 }?.let { layer ->
            try {
                layer.toImageBitmap()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null // No picture (no hardware renderer): the change is made at once.
            }
        }
        if (shot == null) return change()
        alpha.snapTo(1f)
        cover = shot
        try {
            change()
            // The new screens draw their first frame, however long, under the picture.
            repeat(2) { withFrameNanos {} }
            alpha.animateTo(0f, tween(RootDissolveSpec.MILLIS, easing = RootDissolveSpec.easing))
        } finally {
            if (cover === shot) cover = null
        }
    }
}

/** [content], recorded so [dissolve] can take its picture, under the picture while one dissolves. */
@Composable
fun DissolveBox(dissolve: Dissolve, content: @Composable () -> Unit) {
    val layer = rememberGraphicsLayer()
    dissolve.layer = layer
    Box(Modifier.fillMaxSize()) {
        Box(
            Modifier.fillMaxSize().drawWithContent {
                layer.record { this@drawWithContent.drawContent() }
                drawLayer(layer)
            },
        ) { content() }
        val cover = dissolve.cover
        if (cover != null) {
            Spacer(Modifier.matchParentSize().drawBehind { drawImage(cover, alpha = dissolve.alpha.value) })
        }
    }
}

/**
 * Switching the open account, as iOS's switcher and Settings do it.
 *
 * From home's account menu the new account's home dissolves in where the
 * old one was ([RootDissolve]). From Settings (its accounts card or a
 * profile its search found) Settings stays on top and keeps its place; the
 * new account's home replaces the old one under it, unseen, so back lands
 * there. Settings changes in place: for an account of the same kind only
 * its values change, with no animation; for the other kind (a Happy
 * account and an agent connection have different pages) the page dissolves
 * into the other one. Signing out of or disconnecting the open account from
 * Settings keeps Settings too, over the next account's home.
 */
@Stable
class AccountSwitcher internal constructor(
    private val graph: AppGraph,
    private val scope: CoroutineScope,
    private val dissolve: Dissolve,
) {
    private var job: Job? = null

    /** Settings' scrolling part, while Settings is composed: what dissolves on a switch between kinds there. */
    internal var settings: Dissolve? = null

    /**
     * Whether the switch under way came from Settings, so HappyApp keeps the
     * back stack (Settings over home) and changes what its screens show,
     * instead of starting the new account's stack.
     */
    internal var keepsSettings = false
        private set

    /** Home's account menu: [id] opens, its home dissolving in over the old one's. */
    fun fromHome(id: String) = start(keep = false) {
        dissolve.around { open(id) }
    }

    /** Settings' accounts card or search: [id] opens under Settings, which stays and changes in place. */
    fun fromSettings(id: String) = start(keep = true) {
        val agent = graph.agentConnections.accounts.value.any { it.id == id }
        val otherKind = agent != (graph.openAccount.value is OpenAccount.Agent)
        if (otherKind) (settings ?: dissolve).around { open(id) } else open(id)
    }

    /** Settings: [remove] signs out of or disconnects the open account; Settings stays over the next one's. */
    fun removingFromSettings(remove: suspend () -> Unit) = start(keep = true) {
        val before = graph.openAccount.value
        (settings ?: dissolve).around {
            remove()
            withTimeoutOrNull(SETTLE_MILLIS) { graph.openAccount.first { it != before } }
        }
    }

    private suspend fun open(id: String) {
        graph.open(id).join()
        // The screens follow once the switch has settled; a switch that fails moves on after a moment.
        withTimeoutOrNull(SETTLE_MILLIS) { graph.openAccount.first { it.id == id } }
    }

    private fun start(keep: Boolean, block: suspend () -> Unit) {
        // One switch at a time: only the last choice is still wanted.
        job?.cancel()
        keepsSettings = keep
        val mine = scope.launch(start = CoroutineStart.LAZY) {
            try {
                block()
                // HappyApp reads keepsSettings while it composes the change.
                repeat(2) { withFrameNanos {} }
            } finally {
                if (job === coroutineContext[Job]) keepsSettings = false
            }
        }
        job = mine
        mine.start()
    }

    private companion object {
        const val SETTLE_MILLIS = 2_000L
    }
}

/** HappyApp's [AccountSwitcher]; null outside it (tests of single screens), where a switch is [AppGraph.open]. */
val LocalAccountSwitcher = staticCompositionLocalOf<AccountSwitcher?> { null }

/** Home's account menu's switch: [AccountSwitcher.fromHome], or [AppGraph.open] outside HappyApp. */
@Composable
fun rememberHomeAccountSwitch(graph: AppGraph): (String) -> Unit {
    val switcher = LocalAccountSwitcher.current
    return remember(graph, switcher) { { id: String -> if (switcher != null) switcher.fromHome(id) else graph.open(id) } }
}

/** Settings' scrolling part's [Dissolve] (AccountSettings); null elsewhere. */
val LocalSettingsDissolve = staticCompositionLocalOf<Dissolve?> { null }

/** Settings' scrolling part, which dissolves into the other kind's page on a switch made there ([AccountSwitcher.fromSettings]). */
@Composable
fun SettingsDissolveBox(content: @Composable () -> Unit) {
    val dissolve = LocalSettingsDissolve.current
    if (dissolve == null) content() else DissolveBox(dissolve, content)
}

/** Gives Settings' scrolling part to the switcher while [content] is composed, and to [content]. */
@Composable
fun ProvideSettingsDissolve(content: @Composable () -> Unit) {
    val dissolve = remember { Dissolve() }
    val switcher = LocalAccountSwitcher.current
    DisposableEffect(switcher, dissolve) {
        switcher?.settings = dissolve
        onDispose { if (switcher?.settings === dissolve) switcher.settings = null }
    }
    CompositionLocalProvider(LocalSettingsDissolve provides dissolve, content = content)
}
