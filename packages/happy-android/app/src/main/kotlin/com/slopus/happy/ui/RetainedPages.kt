package com.slopus.happy.ui

import android.content.ComponentCallbacks2
import android.content.res.Configuration
import androidx.compose.animation.AnimatedContentScope
import androidx.compose.animation.EnterExitState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.zIndex
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavGraph
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.NavigatorProvider
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.ComposeNavigator
import androidx.navigation.compose.NavBackStackEntryInfo
import androidx.navigation.get
import androidx.navigationevent.NavigationEvent
import androidx.navigationevent.NavigationEventHandler
import androidx.navigationevent.NavigationEventTransitionState
import androidx.navigationevent.compose.LocalNavigationEventDispatcherOwner
import kotlin.math.abs
import kotlin.math.roundToInt
import androidx.savedstate.compose.LocalSavedStateRegistryOwner
import com.slopus.happy.ui.components.LocalShimmerClock
import com.slopus.happy.ui.components.LocalPageActive
import com.slopus.happy.ui.components.ShimmerClock

@PublishedApi
internal class RetainedGraphBuilder(provider: NavigatorProvider, start: Any) :
    NavGraphBuilder(provider, start, null, emptyMap()) {
    val pages = mutableMapOf<Int, @Composable (NavBackStackEntry) -> Unit>()
}

/**
 * Every visited back-stack page keeps its composition and list state. NavHost
 * still owns navigation, lifecycles and all six transitions; its lightweight
 * destination anchors carry the positions. Each retained page draws its own
 * scrim at that position, below the next page, never above the entire stack.
 * Covered pages are neither measured, placed, drawn, focusable nor accessible.
 * Only pop (after the exit finishes) or real memory pressure disposes a page.
 */
@Composable
internal fun RetainedNavHost(
    nav: NavHostController,
    start: Any,
    motion: NavMotion,
    modifier: Modifier = Modifier,
    retention: RetainedPagesState = remember(nav) { RetainedPagesState() },
    builder: NavGraphBuilder.() -> Unit,
) {
    val definition = remember(nav, start, builder) {
        RetainedGraphBuilder(nav.navigatorProvider, start).apply(builder).let { it.build() to it.pages }
    }
    val entries by nav.currentBackStack.collectAsState()
    val visible by nav.visibleEntries.collectAsState()
    val stack = entries.filter { it.destination !is NavGraph }
    val activeId = stack.lastOrNull()?.id
    // Popped pages remain alive until NavHost finishes their exit transition.
    val alive = (stack + visible).distinctBy { it.id }.filter { it.lifecycle.currentState != Lifecycle.State.DESTROYED }
    val saved = rememberSaveableStateHolder()
    val savedEntries = remember { mutableSetOf<String>() }
    val context = LocalContext.current.applicationContext
    val dispatcher = LocalNavigationEventDispatcherOwner.current?.navigationEventDispatcher
    val gesture = dispatcher?.transitionState?.collectAsState()?.value as? NavigationEventTransitionState.InProgress
    val direction = if (LocalLayoutDirection.current == LayoutDirection.Ltr) 1 else -1
    SideEffect {
        if (gesture == null) retention.endGestureInput()
    }
    LaunchedEffect(gesture != null, activeId) {
        if (gesture == null) retention.finishGesture(activeId)
    }
    SideEffect {
        val liveIds = (nav.currentBackStack.value + nav.visibleEntries.value).map { it.id }.toSet()
        // An entry can be popped after memory pressure already disposed its view.
        // Its saveable state must not wait for a second onDispose that never runs.
        (savedEntries - liveIds).forEach { saved.removeState(it) }
        savedEntries.retainAll(liveIds)
        savedEntries.addAll(liveIds)
        retention.reconcile(
            liveIds,
            nav.currentBackStack.value.lastOrNull { it.destination !is NavGraph }?.id,
        )
        motion.dims.initialPlacement = retention::initialPlacement
    }
    DisposableEffect(context, retention) {
        val callback = object : ComponentCallbacks2 {
            override fun onConfigurationChanged(newConfig: Configuration) = Unit
            override fun onLowMemory() { retention.trimCovered() }
            override fun onTrimMemory(level: Int) { retention.trimMemory(level) }
        }
        context.registerComponentCallbacks(callback)
        onDispose { context.unregisterComponentCallbacks(callback) }
    }

    Box(modifier.fillMaxSize().clipToBounds().onGloballyPositioned(retention::container)) {
        CompositionLocalProvider(LocalRetainedPages provides retention, LocalPageDims provides motion.dims) {
            NavHost(
                navController = nav,
                graph = definition.first,
                modifier = Modifier.fillMaxSize().traceNavPlacement(motion.dims),
                enterTransition = motion.enter,
                exitTransition = motion.exit,
                popEnterTransition = motion.popEnter,
                popExitTransition = motion.popExit,
                predictivePopEnterTransition = motion.predictivePopEnter,
                predictivePopExitTransition = motion.predictivePopExit,
            )
        }
        RetainedBackHandler(nav, retention, direction, motion !== NavMotion.None)
        for (entry in alive) {
          val content = definition.second[entry.destination.id] ?: continue
          key(entry.id) {
            val position = retention.position(entry.id)
            val active = entry.id == activeId
            if (active || position.present || position.resident) {
                SideEffect { position.resident = true }
                val clock = remember { ShimmerClock() }
                LaunchedEffect(entry, clock) {
                    entry.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { clock.run() }
                }
                DisposableEffect(entry.id) {
                    onDispose {
                        // Eviction/recreation saves the view state; a real pop discards it.
                        if (nav.currentBackStack.value.none { it.id == entry.id }) saved.removeState(entry.id)
                    }
                }
                CompositionLocalProvider(
                    LocalLifecycleOwner provides entry,
                    LocalViewModelStoreOwner provides entry,
                    LocalSavedStateRegistryOwner provides entry,
                    LocalShimmerClock provides clock,
                    LocalPageActive provides active,
                ) {
                    saved.SaveableStateProvider(entry.id) {
                        RetainedPage(position, active) { content(entry) }
                    }
                }
            }
          }
        }
    }
}

/** Back is enabled synchronously with the stack mutation, before a heavy new
 * page's first composition. NavHost updates its own handler in a SideEffect;
 * a quick Back in that gap otherwise reaches the activity's root fallback.
 * Page-local handlers are composed after this one and retain priority.
 */
@Composable
private fun RetainedBackHandler(nav: NavHostController, retention: RetainedPagesState, direction: Int, animate: Boolean) {
    val dispatcher = LocalNavigationEventDispatcherOwner.current?.navigationEventDispatcher ?: return
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val handler = remember(nav, retention, direction, animate) {
        object : NavigationEventHandler<NavBackStackEntryInfo>(NavBackStackEntryInfo(), isBackEnabled = false) {
            override fun onBackStarted(event: NavigationEvent) {
                if (!animate) return
                val entries = nav.currentBackStack.value.filter { it.destination !is NavGraph }.takeLast(2)
                if (entries.size != 2) return
                val navigator = nav.navigatorProvider[ComposeNavigator::class]
                entries.forEach(navigator::prepareForTransition)
                retention.completeGesture = {
                    if (nav.currentBackStackEntry == entries.last()) entries.forEach(navigator::onTransitionComplete)
                }
                retention.seekGesture(entries.map { it.id }, event.progress, direction)
            }
            override fun onBackProgressed(event: NavigationEvent) {
                if (!animate) return
                retention.seekGesture(nav.currentBackStack.value.filter { it.destination !is NavGraph }.map { it.id }, event.progress, direction)
            }
            override fun onBackCompleted() {
                retention.beforePop()
                nav.popBackStack()
            }
        }
    }
    DisposableEffect(nav, dispatcher, lifecycle, handler) {
        var history = nav.currentBackStack.value.filter { it.destination !is NavGraph }
        fun update() {
            val current = nav.currentBackStackEntry
            if (current != null && history.lastOrNull()?.id != current.id) {
                val previous = history.lastOrNull()
                val returning = history.indexOfFirst { it.id == current.id }
                if (returning >= 0) {
                    if (animate && previous != null) retention.reversePush(previous.id, current.id, direction)
                    history = history.take(returning + 1)
                } else history = history.filter { it.lifecycle.currentState != Lifecycle.State.DESTROYED } + current
            }
            handler.isBackEnabled = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) && nav.previousBackStackEntry != null
            handler.setInfo(NavBackStackEntryInfo(nav.currentBackStackEntry), listOfNotNull(nav.previousBackStackEntry?.let(::NavBackStackEntryInfo)))
        }
        val destination = androidx.navigation.NavController.OnDestinationChangedListener { _, _, _ -> update() }
        val observer = LifecycleEventObserver { _, _ -> update() }
        dispatcher.addHandler(handler)
        nav.addOnDestinationChangedListener(destination)
        lifecycle.addObserver(observer)
        update()
        onDispose {
            handler.remove()
            nav.removeOnDestinationChangedListener(destination)
            lifecycle.removeObserver(observer)
        }
    }
}

@Composable
private fun RetainedPage(position: RetainedPagePosition, active: Boolean, content: @Composable () -> Unit) {
    Layout(
        content = { Box(Modifier.fillMaxSize(), propagateMinConstraints = true) { content() } },
        modifier = Modifier.fillMaxSize().zIndex(position.order.toFloat())
            .graphicsLayer {
                translationX = if (position.present) position.offset.x else -size.width
                translationY = position.offset.y
            }
            .drawWithContent {
                if (position.present) {
                    drawContent()
                    val dim = position.dim()
                    if (dim > 0f) drawRect(Color.Black, alpha = dim)
                }
            }
            .focusProperties { canFocus = active }
            .then(if (active && position.present) Modifier else Modifier.clearAndSetSemantics { hideFromAccessibility() })
            .pointerInput(active) {
                if (!active) awaitPointerEventScope {
                    while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
                }
            },
    ) { children, constraints ->
        if (position.present) {
            val child = children.single().measure(constraints)
            layout(child.width, child.height) { child.place(0, 0) }
        } else {
            // A dirty descendant cannot force work while covered. On reveal,
            // unchanged constraints reuse its cached measurement and lazy items.
            layout(constraints.maxWidth, constraints.maxHeight) {}
        }
    }
}

@Stable
internal class RetainedPagesState {
    private val positions = linkedMapOf<String, RetainedPagePosition>()
    private var nextOrder = 1
    private var activeId: String? = null
    private var parent: LayoutCoordinates? = null
    private var gestureStarted = false
    private var gesture: RetainedGesture? = null
    var completeGesture: (() -> Unit)? = null

    private data class RetainedGesture(
        val topId: String,
        val belowId: String,
        val width: Float,
        val top: PageVisual,
        val below: PageVisual,
    )

    fun position(id: String): RetainedPagePosition = positions.getOrPut(id) { RetainedPagePosition(nextOrder++) }

    fun reconcile(alive: Set<String>, active: String?) {
        activeId = active
        positions.keys.retainAll(alive)
    }

    fun container(coordinates: LayoutCoordinates) {
        parent = coordinates
        positions.values.forEach { it.update(coordinates) }
    }

    fun placed(id: String, coordinates: LayoutCoordinates) {
        position(id).apply {
            anchor = coordinates
            parent?.let(::update)
        }
    }

    /** Seed before child measurement, so its first frame does not miss the anchor's first frame. */
    fun initialPlacement(id: String, x: Int) {
        position(id).let { page ->
            if (!page.present) {
                page.offset = Offset(x.toFloat(), 0f)
                page.present = true
            }
        }
    }

    /** A gesture always begins at the pixels on screen, even mid-push. */
    fun seekGesture(stack: List<String>, progress: Float, direction: Int) {
        if (!gestureStarted) {
            val topId = stack.lastOrNull() ?: return
            val belowId = stack.dropLast(1).lastOrNull() ?: return
            val top = position(topId)
            val below = position(belowId)
            val width = (parent?.size?.width ?: 0) * direction.toFloat()
            if (width == 0f) return
            gestureStarted = true
            gesture = RetainedGesture(topId, belowId, width, PageVisual(top.offset, top.dim()), PageVisual(below.offset, below.dim()))
        }
        val gesture = gesture ?: return
        val amount = progress.coerceIn(0f, 1f)
        position(gesture.topId).apply {
            overrideRunning = true
            visualOverride = PageVisual(Offset(gesture.top.offset.x + (gesture.width - gesture.top.offset.x) * amount, 0f), 0f)
        }
        position(gesture.belowId).apply {
            overrideRunning = true
            visualOverride = PageVisual(gesture.below.offset * (1f - amount), gesture.below.dim * (1f - amount))
        }
    }

    fun endGestureInput() { gestureStarted = false }

    fun beforePop() {
        completeGesture = null // NavHost completes the real pop's lifecycle.
        val gesture = gesture ?: return
        val top = position(gesture.topId)
        // A key Back also sends a zero-progress start. Keep both pages placed
        // during that start, but do not run a second animation for a full pop
        // from rest. Real drags and interrupted pushes still need the handoff.
        if (abs(gesture.top.offset.x) < 1f && abs(top.offset.x) < 1f) {
            this.gesture = null
            gestureStarted = false
            for (page in listOf(top, position(gesture.belowId))) {
                page.overrideRunning = false
                page.visualOverride = null
            }
        }
    }

    /** Toolbar/system Back while a push is still moving uses the same
     * current-pixel handoff, rather than reversing an old tween's clock.
     */
    fun reversePush(topId: String, belowId: String, direction: Int) {
        if (gesture != null || abs(position(topId).offset.x) < 1f) return
        seekGesture(listOf(belowId, topId), 0f, direction)
    }

    suspend fun finishGesture(active: String?) {
        val gesture = gesture ?: run {
            // A gesture cancelled before moving still prepared both entries.
            completeGesture?.invoke()
            completeGesture = null
            return
        }
        val top = position(gesture.topId)
        val below = position(gesture.belowId)
        val fromTop = top.offset.x
        val fromBelow = below.offset.x
        val fromDim = below.dim()
        val cancel = active == gesture.topId
        val coveredAgain = active != gesture.topId && active != gesture.belowId
        val toTop = if (cancel) 0f else gesture.width
        val toBelow = if (cancel || coveredAgain) -gesture.width * NavMotion.PARALLAX else 0f
        val toDim = if (cancel || coveredAgain) NavMotion.DIM else 0f
        val duration = (abs((toTop - fromTop) / gesture.width) * NavMotion.DURATION_MILLIS).roundToInt().coerceAtLeast(1)
        animate(0f, 1f, animationSpec = tween(duration, easing = NavMotion.easing)) { amount, _ ->
            top.visualOverride = PageVisual(Offset(fromTop + (toTop - fromTop) * amount, 0f), 0f)
            below.visualOverride = PageVisual(Offset(fromBelow + (toBelow - fromBelow) * amount, 0f), fromDim + (toDim - fromDim) * amount)
        }
        this.gesture = null
        completeGesture?.invoke()
        completeGesture = null
        for (page in listOf(top, below)) {
            page.overrideRunning = false
            if (page.settled || !page.anchorPresent) page.visualOverride = null
        }
    }

    /** No stack-size cap: under pressure release deepest covered views first. */
    fun trimCovered(): List<String> = positions.entries
        .filter { (id, page) -> id != activeId && !page.present && page.resident }
        .sortedBy { it.value.order }
        .map { (id, page) -> page.resident = false; id }

    @Suppress("DEPRECATION")
    fun trimMemory(level: Int): List<String> =
        // UI_HIDDEN is ordinary backgrounding, not memory pressure.
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW && level != ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) trimCovered() else emptyList()
}

@Stable
internal class RetainedPagePosition(val order: Int) {
    private var anchorOffset by mutableStateOf(Offset.Zero)
    var anchorPresent by mutableStateOf(false)
    // Pixel changes belong to the layer, not the composition/measurement gates.
    // Store the channels separately: neither presence nor a steady scrim needs
    // invalidation (or derived-state recalculation) when only pixels move.
    private var overridden by mutableStateOf(false)
    private var overrideOffset by mutableStateOf(Offset.Zero)
    private var overrideDim by mutableStateOf(0f)
    var visualOverride: PageVisual?
        get() = if (overridden) PageVisual(overrideOffset, overrideDim) else null
        set(value) {
            if (value != null) {
                overrideOffset = value.offset
                overrideDim = value.dim
            }
            overridden = value != null
        }
    var overrideRunning = false
    var offset: Offset
        get() = if (overridden) overrideOffset else anchorOffset
        set(value) { anchorOffset = value }
    var present: Boolean
        get() = overridden || anchorPresent
        set(value) { anchorPresent = value }
    var resident by mutableStateOf(false)
    var anchorDim: () -> Float = { 0f }
    fun dim(): Float = if (overridden) overrideDim else anchorDim()
    var anchor: LayoutCoordinates? = null
    var settled = false

    fun update(parent: LayoutCoordinates) {
        val anchor = anchor ?: return
        if (parent.isAttached && anchor.isAttached) {
            offset = if (settled) Offset.Zero else parent.localPositionOf(anchor)
            present = true
        }
    }
}

internal data class PageVisual(val offset: Offset, val dim: Float)

internal val LocalRetainedPages = staticCompositionLocalOf<RetainedPagesState?> { null }

@Composable
internal fun AnimatedContentScope.RetainedPageAnchor(entry: NavBackStackEntry, retention: RetainedPagesState) {
    val position = retention.position(entry.id)
    val dims = LocalPageDims.current
    val covered = transition.animateFloat(transitionSpec = { dims?.spec(entry) ?: snap() }, label = "dim") {
        if (it == EnterExitState.Visible) 0f else 1f
    }
    val lifecycle by entry.lifecycle.currentStateAsState()
    // A rapid push/pop/push can settle NavHost while its child's currentState
    // still says PostExit and its layout retains the last interrupted offset.
    // RESUMED is NavHost's authoritative completion signal for this entry.
    val settled = lifecycle == Lifecycle.State.RESUMED &&
        transition.targetState == EnterExitState.Visible && !transition.isRunning
    SideEffect {
        position.settled = settled
        if (settled) position.offset = Offset.Zero
        if (settled && !position.overrideRunning) position.visualOverride = null
        position.anchorDim = { if (!position.settled && dims?.spec(entry) != null) covered.value * NavMotion.DIM else 0f }
    }
    DisposableEffect(position) {
        onDispose {
            position.anchor = null
            position.present = false
            if (!position.overrideRunning) position.visualOverride = null
            dims?.placement?.forget(entry.id)
        }
    }
    Box(Modifier.fillMaxSize().onGloballyPositioned {
        retention.placed(entry.id, it)
        dims?.placement?.page(entry.id, it)
    })
}