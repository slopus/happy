package com.slopus.happy.ui

import android.provider.Settings
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.AnimationVector2D
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigationevent.NavigationEvent
import androidx.navigationevent.NavigationEventDispatcher
import androidx.navigationevent.NavigationEventInput
import androidx.navigationevent.compose.LocalNavigationEventDispatcherOwner
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.SecretKeyBackup
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.server.ServerTags
import com.slopus.happy.ui.start.StartTags
import com.slopus.happy.ui.tablet.TabletSidebarTags
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * One UI Settings' page motion (NavMotion): 450 ms on cubic-bezier(0.22,
 * 0.4, 0, 1), the new page across the whole pane over the old one, which
 * moves 26% the other way and dims. Toolbar Back, system Back and a
 * predictive gesture's commit run the same pop; the gesture holds the pages
 * at its progress, linearly, and finishes or cancels on the curve from there.
 * RTL mirrors it, the tablet sidebar stays put, animations off is instant.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NavMotionTest {
    @get:Rule
    val rule = createComposeRule()

    private val server = FakeHappyServer().start()
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private lateinit var graph: AppGraph
    private lateinit var events: NavigationEventDispatcher

    private class BackInput : NavigationEventInput() {
        fun start(edge: Int) = dispatchOnBackStarted(NavigationEvent(swipeEdge = edge))
        fun progress(value: Float, edge: Int) = dispatchOnBackProgressed(NavigationEvent(swipeEdge = edge, progress = value))
        fun complete() = dispatchOnBackCompleted()
        fun cancel() = dispatchOnBackCancelled()
    }

    private fun backInput() = BackInput().also { input -> rule.runOnUiThread { events.addInput(input) } }

    @After
    fun tearDown() {
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        server.close()
    }

    private fun show(direction: LayoutDirection = LayoutDirection.Ltr) {
        graph = AppGraph(context, clientId = "android/test", defaultServerUrl = server.url, secureStoreKeys = SoftwareKeys(), databaseName = null)
        rule.setContent {
            events = checkNotNull(LocalNavigationEventDispatcherOwner.current).navigationEventDispatcher
            CompositionLocalProvider(LocalLayoutDirection provides direction) { HappyApp(graph) }
        }
        rule.waitUntilAtLeastOneExists(hasTestTag(StartTags.CONTENT), 5_000)
    }

    /** Start's ⋮ › Legacy Server, a push; the clock is held from the tap on. */
    private fun pushServer() {
        rule.onNodeWithContentDescription("More").performClick()
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.onNodeWithText("Legacy Server").performClick()
        rule.mainClock.advanceTimeByFrame()
    }

    private fun settle() {
        rule.mainClock.advanceTimeBy(NavMotion.DURATION_MILLIS * 2L)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
    }

    private val width: Dp get() = rule.onRoot().bounds.right - rule.onRoot().bounds.left

    private fun left(tag: String): Dp = rule.node(tag).bounds.left

    private fun shown(tag: String) = rule.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun curve(time: Float) = NavMotion.easing.transform(time.coerceIn(0f, 1f))

    /** The motion's progress 0..1 at [elapsed] ms, allowing up to three frames for the start to land. */
    private fun assertOnCurve(what: String, progress: Float, elapsed: Long, duration: Float = NavMotion.DURATION_MILLIS.toFloat()) {
        val low = curve((elapsed - 48f) / duration) - 0.01f
        val high = curve(elapsed / duration) + 0.01f
        assertTrue("$what at $elapsed ms is on Settings' curve: $progress in $low..$high", progress in low..high)
    }

    /** The page beneath sits at 26% of the pane times what is left of the motion. */
    private fun assertParallax(what: String, beneath: Dp, top: Dp) {
        val expected = -(width - top) * NavMotion.PARALLAX
        assertDp("$what: the page beneath moves 26% of the pane with the page on top", expected, beneath)
    }

    @Test
    fun aPushSlidesTheNewPageAcrossThePaneOverTheOldOne() {
        show()
        val startAtRest = left(StartTags.CONTENT)
        pushServer()
        rule.mainClock.advanceTimeBy(NavMotion.DURATION_MILLIS / 2L)
        val incoming = left(ServerTags.FORM)
        val outgoing = left(StartTags.CONTENT) - startAtRest
        settle()
        val top = incoming - left(ServerTags.FORM)
        assertOnCurve("the new page", 1f - top / width, NavMotion.DURATION_MILLIS / 2L)
        assertParallax("push", outgoing, top)
        rule.node(StartTags.CONTENT).assertDoesNotExist()
    }

    @Test
    fun aLongFirstFrameDoesNotSkipTheStart() {
        val spec = FromFirstFrame(tween<Float>(NavMotion.DURATION_MILLIS, easing = NavMotion.easing)).vectorize(Float.VectorConverter)
        val from = AnimationVector1D(0f)
        val to = AnimationVector1D(1f)
        fun at(ms: Float) = spec.getValueFromNanos((ms * 1_000_000).toLong(), from, to, from).value
        assertEquals(0f, at(0f), 0f)
        // The frame after the page's first, drawn 60 ms later, shows one frame's progress (120 Hz).
        assertEquals(curve(8.333f / NavMotion.DURATION_MILLIS), at(60f), 0.002f)
        assertEquals(curve(108.333f / NavMotion.DURATION_MILLIS), at(160f), 0.002f)
        assertEquals(1f, at(NavMotion.DURATION_MILLIS + 150f), 0f)
    }

    @Test
    fun firstMovementIsReportedOnceWithoutChangingTheAppliedOffsets() {
        var reports = 0
        val animation = tween<IntOffset>(NavMotion.DURATION_MILLIS, easing = NavMotion.easing)
        val converter = IntOffset.VectorConverter
        val traced = FromFirstFrame(animation) { reports++ }.vectorize(converter)
        val plain = FromFirstFrame(animation).vectorize(converter)
        val from = AnimationVector2D(1080f, 0f)
        val to = AnimationVector2D(0f, 0f)
        val velocity = AnimationVector2D(0f, 0f)
        traced.getDurationNanos(from, to, velocity)
        traced.getVelocityFromNanos(60_000_000L, from, to, velocity)
        assertEquals("duration and velocity queries are not applied movement", 0, reports)
        for (ms in listOf(0L, 60L, 160L, 600L)) {
            val actual = converter.convertFromVector(traced.getValueFromNanos(ms * 1_000_000, from, to, velocity))
            val expected = converter.convertFromVector(plain.getValueFromNanos(ms * 1_000_000, from, to, velocity))
            assertEquals("tracing preserves the offset at $ms ms", expected, actual)
            assertEquals("only the first changed pixel emits a marker", if (ms == 0L) 0 else 1, reports)
        }
    }

    @Test
    fun firstMovementWaitsForTheRoundedOffsetToChange() {
        var reports = 0
        val converter = IntOffset.VectorConverter
        val spec = FromFirstFrame(tween<IntOffset>(NavMotion.DURATION_MILLIS, easing = NavMotion.easing)) { reports++ }.vectorize(converter)
        val from = AnimationVector2D(0f, 0f)
        val to = AnimationVector2D(1f, 0f)
        assertEquals(IntOffset.Zero, converter.convertFromVector(spec.getValueFromNanos(60_000_000L, from, to, from)))
        assertEquals("a subpixel sample has not moved the page", 0, reports)
        assertEquals(IntOffset(1, 0), converter.convertFromVector(spec.getValueFromNanos(160_000_000L, from, to, from)))
        assertEquals(1, reports)
    }

    @Test
    fun aPushStartsFromTheFarEdge() {
        show()
        pushServer()
        // The first frame the new page is drawn in, it rests just inside the end edge.
        while (!shown(ServerTags.FORM)) rule.mainClock.advanceTimeByFrame()
        val first = left(ServerTags.FORM)
        settle()
        assertTrue("the new page starts beyond 90% of the pane: ${first - left(ServerTags.FORM)}", first - left(ServerTags.FORM) > width * 0.9f)
    }

    @Test
    fun theDimIsAScrimOverThePageBeneathNeverTheWindow() {
        lateinit var nav: NavHostController
        rule.setContent {
            nav = rememberNavController()
            val motion = rememberNavMotion()
            Box(Modifier.fillMaxSize().background(Color.Green)) { CompositionLocalProvider(LocalPageDims provides motion.dims) {
                NavHost(
                    navController = nav,
                    startDestination = "first",
                    modifier = Modifier.backdrop(nav),
                    enterTransition = motion.enter,
                    exitTransition = motion.exit,
                    popEnterTransition = motion.popEnter,
                    popExitTransition = motion.popExit,
                ) {
                    composable("first") { entry -> DimmedPage(entry) { Box(Modifier.fillMaxSize().background(Color.Red)) } }
                    composable("second") { entry -> DimmedPage(entry) { Box(Modifier.fillMaxSize().background(Color.Blue)) } }
                }
            } }
        }
        fun check(at: String) {
            rule.waitForIdle()
            val pixels = rule.onRoot().captureToImage().toPixelMap()
            val row = pixels.height / 2
            for (x in 0 until pixels.width step 8) {
                assertEquals("no window shows through at $at, x=$x", 0f, pixels[x, row].green, 0.02f)
            }
            // How far the blue page has come gives the motion's progress; the red one dims with it.
            val edge = (0 until pixels.width).firstOrNull { pixels[it, row].blue > 0.5f } ?: pixels.width
            val covered = 1f - edge.toFloat() / pixels.width
            if (edge > 4) {
                assertEquals("the page beneath at $at dims by 20% of the progress", 1f - NavMotion.DIM * covered, pixels[1, row].red, 0.04f)
            }
        }
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { nav.navigate("second") }
        rule.mainClock.advanceTimeByFrame()
        repeat(6) { rule.mainClock.advanceTimeBy(48); check("push frame $it") }
        settle()
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { nav.popBackStack() }
        rule.mainClock.advanceTimeByFrame()
        repeat(6) { rule.mainClock.advanceTimeBy(48); check("pop frame $it") }
        settle()
    }

    @Test
    fun toolbarBackPopsOnTheSameCurve() {
        show()
        val startAtRest = left(StartTags.CONTENT)
        pushServer()
        settle()
        val serverAtRest = left(ServerTags.FORM)

        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Back").performClick()
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeBy(NavMotion.DURATION_MILLIS / 2L)
        val incoming = left(StartTags.CONTENT) - startAtRest
        val outgoing = left(ServerTags.FORM) - serverAtRest
        settle()
        assertOnCurve("the page Back leaves", outgoing / width, NavMotion.DURATION_MILLIS / 2L)
        assertParallax("pop", incoming, outgoing)
        assertEquals(startAtRest, left(StartTags.CONTENT))
    }

    /** Every frame of a pop from [back], from its first moving frame: (page leaving, page returning) offsets. */
    private fun popFrames(back: () -> Unit): List<Pair<Float, Float>> {
        val startAtRest = left(StartTags.CONTENT)
        pushServer()
        settle()
        val serverAtRest = left(ServerTags.FORM)
        rule.mainClock.autoAdvance = false
        back()
        val frames = mutableListOf<Pair<Float, Float>>()
        repeat(40) {
            rule.mainClock.advanceTimeByFrame()
            rule.waitForIdle()
            val leaving = if (shown(ServerTags.FORM)) left(ServerTags.FORM).value - serverAtRest.value else Float.NaN
            val returning = if (shown(StartTags.CONTENT)) left(StartTags.CONTENT).value - startAtRest.value else Float.NaN
            frames += leaving to returning
        }
        settle()
        return frames.dropWhile { it.first == 0f || it.second.isNaN() }.takeWhile { !it.first.isNaN() }
    }

    @Test
    fun toolbarBackAndSystemBackDrawTheSameFrames() {
        show()
        val toolbar = popFrames { rule.onNodeWithContentDescription("Back").performClick() }
        val input = backInput()
        val system = popFrames { rule.runOnUiThread { input.complete() } }
        assertTrue("the pop has frames to compare: $toolbar", toolbar.size > 10)
        assertEquals("toolbar Back and system Back are one animation", toolbar.size, system.size)
        toolbar.zip(system).forEachIndexed { i, (a, b) ->
            assertEquals("frame $i, the page leaving", a.first, b.first, 0.5f)
            assertEquals("frame $i, the page returning", a.second, b.second, 0.5f)
        }
    }

    @Test
    fun predictiveBackHoldsThePagesAtTheGesturesProgressThenCancelsAndCommitsOnTheCurve() =
        predictiveBack(LayoutDirection.Ltr, NavigationEvent.EDGE_LEFT)

    @Test
    fun rightToLeftPredictiveBackFromTheOtherEdgeMirrorsTheSameMotion() =
        predictiveBack(LayoutDirection.Rtl, NavigationEvent.EDGE_RIGHT)

    private fun predictiveBack(direction: LayoutDirection, edge: Int) {
        show(direction)
        val sign = if (direction == LayoutDirection.Ltr) 1 else -1
        val startAtRest = left(StartTags.CONTENT)
        pushServer()
        settle()
        val serverAtRest = left(ServerTags.FORM)
        val serverBounds = rule.node(ServerTags.FORM).bounds
        val input = backInput()
        fun drag(progress: Float) {
            rule.runOnUiThread { input.progress(progress, edge) }
            repeat(3) { rule.mainClock.advanceTimeByFrame() }
            rule.waitForIdle()
        }
        fun top() = (left(ServerTags.FORM) - serverAtRest) * sign
        fun beneath() = (left(StartTags.CONTENT) - startAtRest) * sign

        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { input.start(edge) }
        rule.mainClock.advanceTimeByFrame()
        drag(0f)
        assertDp("at progress 0 the page is where it was", 0.dp, top())
        assertParallax("progress 0", beneath(), top())
        for (progress in listOf(0.5f, 1f, 0.5f)) {
            drag(progress)
            assertDp("at progress $progress the page is that share of the pane across", width * progress, top())
            assertParallax("progress $progress", beneath(), top())
        }
        val during = rule.node(ServerTags.FORM).bounds
        assertEquals("the gesture never scales the page", serverBounds.right - serverBounds.left, during.right - during.left)

        // Cancel: back to rest from half way, on the curve, over half of 450 ms.
        rule.runOnUiThread { input.cancel() }
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeBy(NavMotion.DURATION_MILLIS / 4L)
        val cancelling = top() / width
        settle()
        assertTrue("cancel starts from where the finger left: $cancelling", cancelling < 0.5f)
        assertOnCurve("cancel", 1f - cancelling / 0.5f, NavMotion.DURATION_MILLIS / 4L + 16, NavMotion.DURATION_MILLIS / 2f)
        assertEquals("cancel restores the page", serverAtRest, left(ServerTags.FORM))
        rule.node(StartTags.CONTENT).assertDoesNotExist()

        // Commit: from half way to the end, on the curve.
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { input.start(edge) }
        rule.mainClock.advanceTimeByFrame()
        drag(0.5f)
        rule.runOnUiThread { input.complete() }
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeBy(NavMotion.DURATION_MILLIS / 4L)
        val committing = top() / width
        val returning = beneath()
        val leaving = top()
        settle()
        assertOnCurve("commit", (committing - 0.5f) / 0.5f, NavMotion.DURATION_MILLIS / 4L + 16, NavMotion.DURATION_MILLIS / 2f)
        assertParallax("commit", returning, leaving)
        rule.node(ServerTags.FORM).assertDoesNotExist()
        assertEquals("commit returns to the previous page", startAtRest, left(StartTags.CONTENT))
    }

    @Test
    fun rightToLeftMirrorsThePush() {
        show(LayoutDirection.Rtl)
        pushServer()
        rule.mainClock.advanceTimeBy(NavMotion.DURATION_MILLIS / 2L)
        val incoming = left(ServerTags.FORM)
        settle()
        // The end side is the left in a right-to-left layout.
        val top = -(incoming - left(ServerTags.FORM))
        assertOnCurve("the new page", 1f - top / width, NavMotion.DURATION_MILLIS / 2L)
    }

    @Test
    fun withAnimationsOffTheNewScreenIsInPlaceAtOnce() {
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        show()
        pushServer()
        rule.mainClock.advanceTimeByFrame()
        // Already where it rests: no slide.
        val incoming = left(ServerTags.FORM)
        // Gone within a few frames, with no page travelling across the pane.
        repeat(3) { rule.mainClock.advanceTimeByFrame() }
        rule.node(StartTags.CONTENT).assertDoesNotExist()
        settle()
        assertEquals(left(ServerTags.FORM), incoming)
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun onATabletOnlyTheDetailMovesAndTheSidebarStaysPut() {
        server.addMachine("m1")
        server.addSession(
            "a",
            updatedAt = 200,
            metadata = buildJsonObject {
                put("path", "/repo/a")
                put("host", "devbox")
                put("machineId", "m1")
                put("summary", buildJsonObject { put("text", "Chat a"); put("updatedAt", 1) })
            },
        )
        graph = AppGraph(context, clientId = "android/test", defaultServerUrl = server.url, secureStoreKeys = SoftwareKeys(), databaseName = null)
        runBlocking { graph.auth.restore(SecretKeyBackup.format(encodeBase64(server.secret, Base64Variant.Url))) }
        rule.setContent { HappyApp(graph) }
        rule.waitUntilAtLeastOneExists(hasTestTag(FlatRowTags.ROW), 5_000)
        val sidebar = rule.node(TabletSidebarTags.SIDEBAR).bounds

        rule.mainClock.autoAdvance = false
        rule.node(FlatRowTags.ROW).performClick()
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeBy(NavMotion.DURATION_MILLIS / 2L)
        assertEquals("the sidebar doesn't move with the detail", sidebar, rule.node(TabletSidebarTags.SIDEBAR).bounds)
        val chat = left(ChatScreenTags.SCREEN)
        settle()
        val pane = width - sidebar.right
        val travelled = chat - left(ChatScreenTags.SCREEN)
        assertTrue("the chat comes in from the detail pane's end: $travelled", travelled > 1.dp)
        assertOnCurve("the chat", 1f - travelled / pane, NavMotion.DURATION_MILLIS / 2L)
        assertEquals(sidebar, rule.node(TabletSidebarTags.SIDEBAR).bounds)
        graph.account.value?.let { runBlocking { it.stop() } }
    }
}
