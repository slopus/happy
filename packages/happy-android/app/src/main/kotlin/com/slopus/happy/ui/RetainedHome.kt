package com.slopus.happy.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.zIndex
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraph
import androidx.navigation.NavHostController
import androidx.savedstate.compose.LocalSavedStateRegistryOwner
import com.slopus.happy.ui.components.LocalShimmerClock
import com.slopus.happy.ui.components.ShimmerClock

/**
 * Home stays composed behind the navigation stack, at its full pane size.
 * NavHost still owns the transition: [RetainedHomePosition.Anchor] occupies
 * its home destination and carries the existing slide and black scrim. The
 * retained tree follows that anchor's position without another animation or
 * a new measure of its lazy items when Back reveals it.
 *
 * A covered home keeps its entry's lifecycle, saved state and ViewModelStore;
 * it does not become an activity-owned screen. It is offscreen, undrawn and
 * absent from accessibility/hit testing when covered. Its shimmer clock
 * stops with the entry, and existing lifecycle-aware collectors/avatars do
 * too. A real account switch still replaces home's account-keyed content.
 */
@Composable
internal fun RetainedHome(
    nav: NavHostController,
    modifier: Modifier = Modifier,
    home: @Composable () -> Unit,
    navigation: @Composable (RetainedHomePosition) -> Unit,
) {
    val entries by nav.currentBackStack.collectAsState()
    val entry = entries.firstOrNull { it.destination.hasRoute<HomeRoute>() }
    val active = entry != null && entries.lastOrNull { it.destination !is NavGraph } == entry
    val position = remember(nav) { RetainedHomePosition() }
    val saved = rememberSaveableStateHolder()
    DisposableEffect(entry?.id) {
        onDispose {
            if (entry != null && nav.currentBackStack.value.none { it.id == entry.id }) saved.removeState(entry.id)
        }
    }

    Box(modifier.fillMaxSize().clipToBounds().onGloballyPositioned(position::container)) {
        navigation(position)
        if (entry != null) key(entry.id) {
            val clock = remember { ShimmerClock() }
            LaunchedEffect(entry, clock) {
                entry.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { clock.run() }
            }
            CompositionLocalProvider(
                LocalLifecycleOwner provides entry,
                LocalViewModelStoreOwner provides entry,
                LocalSavedStateRegistryOwner provides entry,
                LocalShimmerClock provides clock,
            ) {
                saved.SaveableStateProvider(entry.id) {
                    Box(
                        Modifier.fillMaxSize().zIndex(-1f)
                            .graphicsLayer {
                                translationX = if (position.present || active) position.offset.x else -size.width
                                translationY = position.offset.y
                            }
                            .drawWithContent { if (position.present || active) drawContent() }
                            .focusProperties { canFocus = active }
                            .then(if (active) Modifier else Modifier.clearAndSetSemantics {})
                            .pointerInput(active) {
                                if (!active) awaitPointerEventScope {
                                    while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
                                }
                            },
                        propagateMinConstraints = true,
                    ) { home() }
                }
            }
        }
    }
}

/** The real NavHost slide's coordinates, relative to the retained home's pane. */
@Stable
internal class RetainedHomePosition {
    var offset by mutableStateOf(Offset.Zero)
        private set
    var present by mutableStateOf(false)
        private set
    private var parent: LayoutCoordinates? = null
    private var anchor: LayoutCoordinates? = null

    fun container(coordinates: LayoutCoordinates) {
        parent = coordinates
        update()
    }

    private fun update() {
        val parent = parent ?: return
        val anchor = anchor ?: return
        if (parent.isAttached && anchor.isAttached) {
            offset = parent.localPositionOf(anchor)
            present = true
        }
    }

    @Composable
    fun Anchor() {
        DisposableEffect(this) {
            onDispose {
                anchor = null
                present = false
            }
        }
        Box(Modifier.fillMaxSize().onGloballyPositioned {
            anchor = it
            update()
        })
    }
}