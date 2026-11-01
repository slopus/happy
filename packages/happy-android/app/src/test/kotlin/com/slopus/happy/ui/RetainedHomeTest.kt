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
import androidx.compose.ui.Modifier
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
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
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

/** Home keeps its composition/items while NavHost owns the unchanged slide and scrim. */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class RetainedHomeTest {
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
        home: @Composable () -> Unit = {},
    ) {
        val content: @Composable () -> Unit = {
            nav = rememberNavController()
            events = checkNotNull(LocalNavigationEventDispatcherOwner.current).navigationEventDispatcher
            val motion = rememberNavMotion()
            motion.dims.placement = placement
            CompositionLocalProvider(LocalLayoutDirection provides direction, LocalPageDims provides motion.dims) {
                RetainedHome(nav, modifier = Modifier.backdrop(nav), home = {
                    homeLifecycle = LocalLifecycleOwner.current.lifecycle
                    DisposableEffect(Unit) {
                        created++
                        onDispose { disposed++ }
                    }
                    Box(Modifier.fillMaxSize().background(Color.Red).onGloballyPositioned { coordinates = it }) {
                        home()
                    }
                }) { position ->
                    NavHost(
                        navController = nav,
                        startDestination = HomeRoute,
                        modifier = Modifier.traceNavPlacement(motion.dims),
                        enterTransition = motion.enter,
                        exitTransition = motion.exit,
                        popEnterTransition = motion.popEnter,
                        popExitTransition = motion.popExit,
                        predictivePopEnterTransition = motion.predictivePopEnter,
                        predictivePopExitTransition = motion.predictivePopExit,
                    ) {
                        page<HomeRoute> { position.Anchor() }
                        page<SettingsRoute> { Box(Modifier.fillMaxSize().background(Color.Blue).testTag("details")) }
                    }
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
        show(direction)
        val width = rule.onRoot().fetchSemanticsNode().size.width.toFloat()
        val sign = if (direction == LayoutDirection.Ltr) 1f else -1f
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { nav.navigate(SettingsRoute()) }
        fun checkFrame() {
            rule.waitForIdle()
            val top = rule.node("details").fetchSemanticsNode().positionInRoot.x
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