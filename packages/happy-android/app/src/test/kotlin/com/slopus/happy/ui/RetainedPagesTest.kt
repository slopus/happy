package com.slopus.happy.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.runtime.snapshots.SnapshotStateObserver
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.slopus.happy.ui.settings.AppearanceRoute
import com.slopus.happy.ui.components.StartedEffect
import com.slopus.happy.ui.components.PageBackHandler
import kotlinx.coroutines.awaitCancellation
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import androidx.navigationevent.NavigationEvent
import androidx.navigationevent.NavigationEventDispatcher
import androidx.navigationevent.NavigationEventInput
import androidx.navigationevent.compose.LocalNavigationEventDispatcherOwner
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Every back-stack page retains its items while NavHost owns lifecycle, slide and scrim. */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class RetainedPagesTest {
    @get:Rule val rule = createComposeRule()
    private lateinit var nav: NavHostController
    private lateinit var events: NavigationEventDispatcher
    private lateinit var coordinates: LayoutCoordinates
    private var created = 0
    private var disposed = 0
    private var homeLifecycle: Lifecycle? = null

    private fun show(
        direction: LayoutDirection = LayoutDirection.Ltr,
        restoration: StateRestorationTester? = null,
        placement: NavPlacementTrace? = null,
        retention: RetainedPagesState? = null,
        settings: @Composable () -> Unit = {},
        home: @Composable () -> Unit = {},
    ) {
        val content: @Composable () -> Unit = {
            nav = rememberNavController()
            events = checkNotNull(LocalNavigationEventDispatcherOwner.current).navigationEventDispatcher
            val motion = rememberNavMotion()
            motion.dims.placement = placement
            CompositionLocalProvider(LocalLayoutDirection provides direction, LocalPageDims provides motion.dims) {
                val retained = retention ?: remember { RetainedPagesState() }
                RetainedNavHost(nav, HomeRoute, motion, modifier = Modifier.backdrop(nav), retention = retained) {
                  page<HomeRoute> {
                    homeLifecycle = LocalLifecycleOwner.current.lifecycle
                    DisposableEffect(Unit) {
                        created++
                        onDispose { disposed++ }
                    }
                    Box(Modifier.fillMaxSize().background(Color.Red).onGloballyPositioned { coordinates = it }) {
                        home()
                    }
                  }
                  page<SettingsRoute> { Box(Modifier.fillMaxSize().background(Color.Blue).testTag("details")) { settings() } }
                  page<AppearanceRoute> { Box(Modifier.fillMaxSize().background(Color.Green).testTag("third")) }
                }
            }
        }
        if (restoration == null) rule.setContent(content) else restoration.setContent(content)
        rule.waitForIdle()
    }

    private fun settle() {
        rule.mainClock.advanceTimeBy(1_000)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
    }

    private fun push() {
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { nav.navigate(SettingsRoute()) }
        settle()
    }

    @Test
    fun movingPixelsDoNotInvalidatePresenceOrAnUnchangedScrim() {
        val page = RetainedPagePosition(1)
        page.visualOverride = PageVisual(Offset.Zero, 0f)
        Snapshot.sendApplyNotifications()
        var presenceInvalidations = 0
        var dimInvalidations = 0
        var offsetInvalidations = 0
        val observer = SnapshotStateObserver { it() }
        observer.start()
        try {
            observer.observeReads("presence", { presenceInvalidations++ }) { assertTrue(page.present) }
            observer.observeReads("dim", { dimInvalidations++ }) { assertEquals(0f, page.dim(), 0f) }
            observer.observeReads("offset", { offsetInvalidations++ }) { assertEquals(Offset.Zero, page.offset) }
            repeat(30) { frame ->
                page.visualOverride = PageVisual(Offset((frame + 1) * 10f, 0f), 0f)
                Snapshot.sendApplyNotifications()
            }
            assertEquals("presence gates composition and measurement", 0, presenceInvalidations)
            assertEquals("translation must not re-record an unchanged page", 0, dimInvalidations)
            assertTrue("the layer still sees pixel updates", offsetInvalidations > 0)
            page.visualOverride = PageVisual(page.offset, NavMotion.DIM)
            Snapshot.sendApplyNotifications()
            assertEquals(1, dimInvalidations)
            page.visualOverride = null
            Snapshot.sendApplyNotifications()
            assertEquals(1, presenceInvalidations)
        } finally {
            observer.stop()
            observer.clear()
        }
    }

    @Test
    fun homeAndItsLazyItemsSurviveWithoutBeingRebuiltOrRemeasured() {
        lateinit var list: LazyListState
        var itemCreates = 0
        var itemDisposes = 0
        var itemMeasures = 0
        var itemCompositions = 0
        show {
            list = rememberLazyListState()
            LazyColumn(state = list) {
                items((0 until 80).toList(), key = { it }) { item ->
                    SideEffect { itemCompositions++ }
                    DisposableEffect(item) {
                        itemCreates++
                        onDispose { itemDisposes++ }
                    }
                    Text("row $item", Modifier.height(64.dp).layout { measurable, constraints ->
                        itemMeasures++
                        val placeable = measurable.measure(constraints)
                        layout(placeable.width, placeable.height) { placeable.place(0, 0) }
                    })
                }
            }
        }
        rule.runOnUiThread { runBlocking { list.scrollToItem(20, 17) } }
        rule.waitForIdle()
        val initialList = list
        val initialCreates = itemCreates
        val initialDisposes = itemDisposes
        val initialMeasures = itemMeasures
        val initialCompositions = itemCompositions
        push()
        rule.onNodeWithText("row 20").assertDoesNotExist()
        rule.runOnUiThread {
            assertEquals(Lifecycle.State.CREATED, homeLifecycle?.currentState)
            assertEquals(1, created)
            assertEquals(0, disposed)
            nav.popBackStack()
        }
        settle()
        assertSame(initialList, list)
        assertEquals(20, list.firstVisibleItemIndex)
        assertEquals(17, list.firstVisibleItemScrollOffset)
        assertEquals(initialCreates, itemCreates)
        assertEquals(initialDisposes, itemDisposes)
        assertEquals(initialMeasures, itemMeasures)
        assertEquals(initialCompositions, itemCompositions)
        assertEquals(Lifecycle.State.RESUMED, homeLifecycle?.currentState)
    }

    @Test fun pushAndPopFollowTheExistingAnchorWithoutAHole() = checkMotion(LayoutDirection.Ltr)
    @Test fun rightToLeftUsesTheSameAnchorAndParallax() = checkMotion(LayoutDirection.Rtl)

    @Test
    fun aCoveredSettingsPageKeepsItsExactListWithoutNewItemsOrMeasurements() {
        lateinit var list: LazyListState
        var itemCreates = 0
        var itemMeasures = 0
        var itemCompositions = 0
        var life: Lifecycle? = null
        show(settings = {
            life = LocalLifecycleOwner.current.lifecycle
            list = rememberLazyListState()
            LazyColumn(state = list) {
                items((0 until 80).toList(), key = { it }) { item ->
                    remember { itemCreates++ }
                    SideEffect { itemCompositions++ }
                    Text("settings row $item", Modifier.height(64.dp).layout { measurable, constraints ->
                        itemMeasures++
                        val child = measurable.measure(constraints)
                        layout(child.width, child.height) { child.place(0, 0) }
                    })
                }
            }
        })
        push()
        rule.runOnUiThread { runBlocking { list.scrollToItem(20, 17) } }
        rule.waitForIdle()
        val before = Triple(itemCreates, itemMeasures, itemCompositions)
        val original = list
        rule.runOnUiThread { nav.navigate(AppearanceRoute) }
        settle()
        assertEquals(Lifecycle.State.CREATED, life!!.currentState)
        rule.onNodeWithText("settings row 20").assertDoesNotExist()
        rule.runOnUiThread { nav.popBackStack() }
        settle()
        assertSame(original, list)
        assertEquals(20, list.firstVisibleItemIndex)
        assertEquals(17, list.firstVisibleItemScrollOffset)
        assertEquals(before, Triple(itemCreates, itemMeasures, itemCompositions))
    }

    @Test
    fun noStackCapAndBackgroundingIsNotMemoryPressure() {
        val retained = RetainedPagesState()
        val ids = (0 until 20).map { "entry-$it" }
        retained.reconcile(ids.toSet(), ids.last())
        ids.forEach { retained.position(it).resident = true }
        assertTrue(retained.trimMemory(android.content.ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN).isEmpty())
        assertTrue(ids.all { retained.position(it).resident })
        assertEquals(ids.dropLast(1), retained.trimMemory(android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW))
        assertTrue(retained.position(ids.last()).resident)
    }

    @Test
    fun pageObservationStopsWhileCoveredAndRestartsWithoutRecreatingThePage() {
        var homeStarts = 0
        var homeStops = 0
        var settingsStarts = 0
        var settingsStops = 0
        show(settings = {
            StartedEffect(Unit) {
                settingsStarts++
                try { awaitCancellation() } finally { settingsStops++ }
            }
        }) {
            StartedEffect(Unit) {
                homeStarts++
                try { awaitCancellation() } finally { homeStops++ }
            }
        }
        assertEquals(1, homeStarts)
        push()
        assertEquals(1, homeStops)
        assertEquals(1, settingsStarts)
        rule.runOnUiThread { nav.navigate(AppearanceRoute) }
        settle()
        assertEquals(1, settingsStops)
        rule.runOnUiThread { nav.popBackStack() }
        settle()
        assertEquals(2, settingsStarts)
        assertEquals(1, homeStarts)
        rule.runOnUiThread { nav.popBackStack() }
        settle()
        assertEquals(2, homeStarts)
        assertEquals(2, settingsStops)
        assertEquals(1, created)
        assertEquals(0, disposed)
    }

    @Test
    fun memoryPressureEvictsDeepestCoveredViewsAndRestoresTheirSavedScroll() {
        val retained = RetainedPagesState()
        lateinit var homeList: LazyListState
        lateinit var settingsList: LazyListState
        var settingsCreates = 0
        var settingsDisposes = 0
        show(retention = retained, settings = {
            DisposableEffect(Unit) { settingsCreates++; onDispose { settingsDisposes++ } }
            settingsList = rememberLazyListState()
            LazyColumn(state = settingsList) { items(80) { Text("settings $it", Modifier.height(64.dp)) } }
        }) {
            homeList = rememberLazyListState()
            LazyColumn(state = homeList) { items(80) { Text("home $it", Modifier.height(64.dp)) } }
        }
        val homeId = nav.currentBackStackEntry!!.id
        rule.runOnUiThread { runBlocking { homeList.scrollToItem(20, 17) } }
        push()
        val settingsId = nav.currentBackStackEntry!!.id
        rule.runOnUiThread { runBlocking { settingsList.scrollToItem(30, 19) } }
        rule.runOnUiThread { nav.navigate(AppearanceRoute) }
        settle()
        rule.runOnUiThread { assertEquals(listOf(homeId, settingsId), retained.trimCovered()) }
        rule.waitForIdle()
        assertEquals(1, disposed)
        assertEquals(1, settingsDisposes)
        rule.runOnUiThread { nav.popBackStack() }
        settle()
        assertEquals(2, settingsCreates)
        assertEquals(30, settingsList.firstVisibleItemIndex)
        assertEquals(19, settingsList.firstVisibleItemScrollOffset)
        rule.runOnUiThread { nav.popBackStack() }
        settle()
        assertEquals(2, created)
        assertEquals(20, homeList.firstVisibleItemIndex)
        assertEquals(17, homeList.firstVisibleItemScrollOffset)
    }

    @Test
    fun backIsEnabledBeforeTheFirstPushedCompositionAndDoubleTapsPopOneEntryEach() {
        show()
        val homeId = nav.currentBackStackEntry!!.id
        val input = BackInput()
        rule.runOnUiThread { events.addInput(input) }
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread {
            nav.navigate(SettingsRoute())
            input.complete()
            assertEquals(homeId, nav.currentBackStackEntry!!.id)
            nav.navigate(SettingsRoute())
            val first = nav.currentBackStackEntry!!.id
            nav.navigate(SettingsRoute())
            input.complete()
            assertEquals(first, nav.currentBackStackEntry!!.id)
            input.complete()
            assertEquals(homeId, nav.currentBackStackEntry!!.id)
        }
        settle()
        assertEquals(1, created)
        assertEquals(0, disposed)
    }

    @Test
    fun pageOwnedBackHandlerKeepsPriorityOverNavigation() {
        var open by mutableStateOf(true)
        show(settings = { PageBackHandler(open) { open = false } })
        push()
        val settingsId = nav.currentBackStackEntry!!.id
        val input = BackInput()
        rule.runOnUiThread { events.addInput(input); input.complete() }
        settle()
        assertFalse(open)
        assertEquals(settingsId, nav.currentBackStackEntry!!.id)
        rule.runOnUiThread { input.complete() }
        settle()
        assertEquals(Lifecycle.State.RESUMED, homeLifecycle?.currentState)
    }

    @Test
    fun backInterruptsPushWithoutAPositionOrDimJump() {
        val retained = RetainedPagesState()
        show(retention = retained)
        val width = rule.onRoot().fetchSemanticsNode().size.width
        val homeId = nav.currentBackStackEntry!!.id
        val maximumFrame = (0..1000).maxOf { sample ->
            val time = sample / 1000f
            NavMotion.easing.transform((time + 16f / NavMotion.DURATION_MILLIS).coerceAtMost(1f)) - NavMotion.easing.transform(time)
        }
        for (fraction in listOf(.1f, .5f, .9f)) {
            rule.mainClock.autoAdvance = false
            rule.runOnUiThread { nav.navigate(SettingsRoute()) }
            rule.mainClock.advanceTimeBy((NavMotion.DURATION_MILLIS * fraction).toLong())
            rule.waitForIdle()
            val topId = nav.currentBackStackEntry!!.id
            val top = retained.position(topId)
            val underneath = retained.position(homeId)
            var beforeTop = top.offset.x
            var beforeUnder = underneath.offset.x
            var beforeDim = underneath.dim()
            val initialTop = beforeTop
            val remaining = (width - beforeTop) / width
            rule.runOnUiThread { nav.popBackStack() }
            repeat(3) {
                rule.mainClock.advanceTimeByFrame()
                rule.waitForIdle()
                assertTrue("incoming jump at $fraction: $beforeTop -> ${top.offset.x}", kotlin.math.abs(top.offset.x - beforeTop) <= width * maximumFrame + 2f)
                assertTrue("underneath jump at $fraction", kotlin.math.abs(underneath.offset.x - beforeUnder) <= width * NavMotion.PARALLAX * maximumFrame + 2f)
                assertTrue("scrim jump at $fraction: $beforeDim -> ${underneath.dim()}", kotlin.math.abs(underneath.dim() - beforeDim) <= NavMotion.DIM * maximumFrame + .002f)
                beforeTop = top.offset.x
                beforeUnder = underneath.offset.x
                beforeDim = underneath.dim()
            }
            val duration = remaining * NavMotion.DURATION_MILLIS
            if (duration > 140) {
                val half = (duration / 2).toLong()
                rule.mainClock.advanceTimeBy((half - 48).coerceAtLeast(0))
                rule.waitForIdle()
                val progress = (top.offset.x - initialTop) / (width - initialTop)
                val low = NavMotion.easing.transform(((half - 48) / duration).coerceAtLeast(0f)) - .02f
                val high = NavMotion.easing.transform((half + 16) / duration) + .02f
                assertTrue("interrupted Back keeps the chosen curve at $fraction: $progress in $low..$high", progress in low..high)
            }
            rule.mainClock.advanceTimeBy((remaining * NavMotion.DURATION_MILLIS).toLong())
            rule.waitForIdle()
            assertEquals("remaining reverse time scales with distance at $fraction", width.toFloat(), top.offset.x, 1.1f)
            settle()
            assertEquals(homeId, nav.currentBackStackEntry!!.id)
            assertEquals(1, created)
            assertEquals(0, disposed)
        }
    }

    @Test
    fun pushDuringPopPreservesExistingPositionsAndRapidRetargetsSettle() {
        val retained = RetainedPagesState()
        show(retention = retained)
        val homeId = nav.currentBackStackEntry!!.id
        val width = rule.onRoot().fetchSemanticsNode().size.width
        for (fraction in listOf(.1f, .5f, .9f)) {
            push()
            val leavingId = nav.currentBackStackEntry!!.id
            rule.mainClock.autoAdvance = false
            rule.runOnUiThread { nav.popBackStack() }
            rule.mainClock.advanceTimeBy((450 * fraction).toLong())
            rule.waitForIdle()
            val homeBefore = retained.position(homeId).offset.x
            val leavingBefore = retained.position(leavingId).offset.x
            rule.runOnUiThread { nav.navigate(AppearanceRoute) }
            rule.mainClock.advanceTimeByFrame()
            rule.waitForIdle()
            assertEquals("home continuity at $fraction", homeBefore, retained.position(homeId).offset.x, width * .16f)
            assertEquals("outgoing continuity at $fraction", leavingBefore, retained.position(leavingId).offset.x, width * .16f)
            repeat(4) {
                rule.mainClock.advanceTimeByFrame()
                rule.waitForIdle()
                val pixels = rule.onRoot().captureToImage().toPixelMap()
                for (x in 0 until pixels.width step 13) {
                    val pixel = pixels[x, pixels.height / 2]
                    assertTrue("no blank frame at $fraction, x=$x", maxOf(pixel.red, pixel.green, pixel.blue) >= .79f)
                }
            }
            rule.runOnUiThread { nav.popBackStack(); nav.navigate(SettingsRoute()); nav.popBackStack() }
            settle()
            assertEquals(homeId, nav.currentBackStackEntry!!.id)
            assertEquals(1, created)
            assertEquals(0, disposed)
            assertEquals("final home at $fraction (anchor=${retained.position(homeId).anchor?.positionInRoot()})", 0f, retained.position(homeId).offset.x, .1f)
        }
    }

    @Test
    fun restingBackUsesOnlyTheNavHostAnimationAndZeroProgressCancelSettlesLifecycle() {
        val retained = RetainedPagesState()
        show(retention = retained)
        val homeId = nav.currentBackStackEntry!!.id
        push()
        val top = nav.currentBackStackEntry!!
        val input = BackInput()
        rule.runOnUiThread { events.addInput(input) }
        for (commit in listOf(false, true)) {
            rule.mainClock.autoAdvance = false
            rule.runOnUiThread { input.start(); input.progress(0f) }
            repeat(3) { rule.mainClock.advanceTimeByFrame() }
            rule.waitForIdle()
            assertTrue("gesture start places the covered page even at zero progress", retained.position(homeId).present)
            rule.runOnUiThread { if (commit) input.complete() else input.cancel() }
            repeat(4) {
                rule.mainClock.advanceTimeByFrame()
                rule.waitForIdle()
                if (commit) {
                    assertEquals("ordinary Back must not run a second animation", null, retained.position(top.id).visualOverride)
                    assertEquals(null, retained.position(homeId).visualOverride)
                }
            }
            settle()
            if (!commit) {
                assertEquals(top.id, nav.currentBackStackEntry!!.id)
                assertEquals(Lifecycle.State.RESUMED, top.lifecycle.currentState)
                assertEquals(Lifecycle.State.CREATED, homeLifecycle?.currentState)
            } else assertEquals(homeId, nav.currentBackStackEntry!!.id)
        }
    }

    @Test
    fun predictiveBackCanStartDuringPushAndCancelOrCommit() {
        val retained = RetainedPagesState()
        show(retention = retained)
        val homeId = nav.currentBackStackEntry!!.id
        val input = BackInput()
        rule.runOnUiThread { events.addInput(input) }
        for (commit in listOf(false, true)) {
            rule.mainClock.autoAdvance = false
            rule.runOnUiThread { nav.navigate(SettingsRoute()) }
            rule.mainClock.advanceTimeBy(50)
            rule.waitForIdle()
            val topId = nav.currentBackStackEntry!!.id
            val before = retained.position(topId).offset.x
            rule.runOnUiThread { input.start() }
            rule.mainClock.advanceTimeByFrame()
            rule.waitForIdle()
            assertEquals("gesture starts at current position", before, retained.position(topId).offset.x, rule.onRoot().fetchSemanticsNode().size.width * .16f)
            val gestureStart = retained.position(topId).offset.x
            rule.runOnUiThread { input.progress(0f) }
            repeat(3) { rule.mainClock.advanceTimeByFrame() }
            rule.waitForIdle()
            assertEquals("holding the finger still must preserve the interrupted position", gestureStart, retained.position(topId).offset.x, 2f)
            rule.runOnUiThread { input.progress(.4f) }
            repeat(3) { rule.mainClock.advanceTimeByFrame() }
            rule.runOnUiThread { if (commit) input.complete() else input.cancel() }
            settle()
            assertEquals(if (commit) homeId else topId, nav.currentBackStackEntry!!.id)
            if (!commit) { rule.runOnUiThread { nav.popBackStack() }; settle() }
            assertEquals(1, created)
            assertEquals(0, disposed)
        }
    }

    @Test
    fun placementMarkersReportBothIncomingPagesOncePerNavigation() {
        val reports = mutableListOf<String>()
        show(placement = NavPlacementTrace { reports.add(it) })
        assertEquals(0, reports.size)
        push()
        assertEquals(1, reports.size)
        rule.runOnUiThread { nav.popBackStack() }
        settle()
        assertEquals(2, reports.size)
        assertTrue(reports[0] != reports[1])
        push()
        rule.runOnUiThread { nav.popBackStack() }
        settle()
        assertEquals(4, reports.size)
        assertEquals(reports[1], reports[3])
    }

    @Test
    fun savedScrollRestoresWhenTheHostIsRecreatedWhileHomeIsCovered() {
        val restoration = StateRestorationTester(rule)
        lateinit var list: LazyListState
        show(restoration = restoration) {
            list = rememberLazyListState()
            LazyColumn(state = list) {
                items((0 until 80).toList(), key = { it }) { Text("saved row $it", Modifier.height(64.dp)) }
            }
        }
        rule.runOnUiThread { runBlocking { list.scrollToItem(20, 17) } }
        rule.waitForIdle()
        push()
        restoration.emulateSavedInstanceStateRestore()
        rule.waitForIdle()
        rule.onNodeWithText("saved row 20").assertDoesNotExist()
        rule.runOnUiThread { nav.popBackStack() }
        settle()
        assertEquals(20, list.firstVisibleItemIndex)
        assertEquals(17, list.firstVisibleItemScrollOffset)
    }

    private fun checkMotion(direction: LayoutDirection) {
        val retained = RetainedPagesState()
        show(direction, retention = retained)
        val width = rule.onRoot().fetchSemanticsNode().size.width.toFloat()
        val sign = if (direction == LayoutDirection.Ltr) 1f else -1f
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { nav.navigate(SettingsRoute()) }
        val topId = nav.currentBackStackEntry!!.id
        fun checkFrame() {
            rule.waitForIdle()
            val top = retained.position(topId).offset.x
            val expected = -(width - top * sign) * NavMotion.PARALLAX * sign
            assertEquals("home uses the NavHost's own slide, with no frame behind", expected, coordinates.positionInRoot().x, 1.1f)
            val pixels = rule.onRoot().captureToImage().toPixelMap()
            for (x in 0 until pixels.width step 13) {
                val pixel = pixels[x, pixels.height / 2]
                assertTrue("no exposed backdrop at $x", pixel.red + pixel.blue > .7f)
            }
        }
        repeat(8) { rule.mainClock.advanceTimeBy(48); checkFrame() }
        settle()
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { nav.popBackStack() }
        repeat(8) { rule.mainClock.advanceTimeBy(48); checkFrame() }
        settle()
        assertEquals(1, created)
        assertEquals(0, disposed)
        assertEquals(0f, coordinates.positionInRoot().x, .1f)
    }

    @Test
    fun changingAccountWhileCoveredReplacesOnlyTheAccountContent() {
        var account by mutableStateOf("first")
        var accountCreates = 0
        show {
            key(account) {
                remember { accountCreates++ }
                Text(account)
            }
        }
        push()
        rule.runOnUiThread { account = "second" }
        rule.waitForIdle()
        assertEquals(2, accountCreates)
        rule.runOnUiThread { nav.popBackStack() }
        settle()
        rule.onNodeWithText("first").assertDoesNotExist()
        rule.onNodeWithText("second").assertExists()
        assertEquals(2, accountCreates)
        assertEquals(1, created)
    }

    @Test
    fun aCoveredHomeCannotKeepTextInputFocus() {
        val requester = FocusRequester()
        var focused = false
        show {
            BasicTextField("", {}, Modifier.focusRequester(requester).onFocusChanged { focused = it.isFocused })
        }
        rule.runOnUiThread { requester.requestFocus() }
        rule.waitForIdle()
        assertTrue(focused)
        push()
        assertFalse("hidden home's input is not focused", focused)
    }

    private class BackInput : NavigationEventInput() {
        fun start() = dispatchOnBackStarted(NavigationEvent(swipeEdge = NavigationEvent.EDGE_LEFT))
        fun progress(value: Float) = dispatchOnBackProgressed(NavigationEvent(swipeEdge = NavigationEvent.EDGE_LEFT, progress = value))
        fun complete() = dispatchOnBackCompleted()
        fun cancel() = dispatchOnBackCancelled()
    }

    @Test
    fun predictiveCancelAndCommitKeepTheSameHome() {
        show()
        push()
        val input = BackInput()
        rule.runOnUiThread { events.addInput(input) }
        fun drag() {
            rule.mainClock.autoAdvance = false
            rule.runOnUiThread { input.start() }
            rule.mainClock.advanceTimeByFrame()
            rule.runOnUiThread { input.progress(.5f) }
            repeat(3) { rule.mainClock.advanceTimeByFrame() }
            rule.waitForIdle()
            val width = rule.onRoot().fetchSemanticsNode().size.width
            assertEquals(-width * NavMotion.PARALLAX * .5f, coordinates.positionInRoot().x, 1.1f)
        }
        drag()
        rule.runOnUiThread { input.cancel() }
        settle()
        assertEquals(Lifecycle.State.CREATED, homeLifecycle?.currentState)
        drag()
        rule.runOnUiThread { input.complete() }
        settle()
        assertEquals(1, created)
        assertEquals(0, disposed)
        assertEquals(0f, coordinates.positionInRoot().x, .1f)
    }
}