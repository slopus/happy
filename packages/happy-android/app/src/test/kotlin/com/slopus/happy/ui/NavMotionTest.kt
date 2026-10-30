package com.slopus.happy.ui

import android.provider.Settings
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.navigationevent.NavigationEvent
import androidx.navigationevent.NavigationEventDispatcher
import androidx.navigationevent.NavigationEventInput
import androidx.navigationevent.compose.LocalNavigationEventDispatcherOwner
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
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
 * Telegram's ordinary motion (NavMotion): 150 ms, 48 dp of foreground
 * travel and concurrent alpha; the underlying page stays in place.
 * System completion and predictive gestures use that same reverse path,
 * including cancellation and RTL from the other edge. The tablet sidebar
 * stays fixed and reduced motion is instant.
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

    private fun halfway() = rule.mainClock.advanceTimeBy(NavMotion.DURATION_MILLIS / 2L)

    private fun settle() {
        rule.mainClock.advanceTimeBy(NavMotion.DURATION_MILLIS * 2L)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
    }

    private fun left(tag: String): Dp = rule.node(tag).bounds.left

    private fun assertTravelling(what: String, offset: Dp, towardsEnd: Boolean) {
        val max = 48.dp + TOLERANCE
        if (towardsEnd) {
            assertTrue("$what travels from the end side: $offset", offset > 1.dp)
        } else {
            assertTrue("$what travels from the start side: $offset", offset < (-1).dp)
        }
        assertTrue("$what stays within Telegram's 48 dp travel: $offset", offset.value in -max.value..max.value)
    }

    @Test
    fun aPushSlidesTheNewScreenOverTheStationaryOldPage() {
        show()
        val startAtRest = left(StartTags.CONTENT)
        pushServer()
        halfway()
        val incoming = left(ServerTags.FORM)
        val outgoing = left(StartTags.CONTENT) - startAtRest
        settle()
        assertTravelling("the new screen", incoming - left(ServerTags.FORM), towardsEnd = true)
        assertEquals("the old page stays in place beneath the foreground", 0.dp, outgoing)
        rule.node(StartTags.CONTENT).assertDoesNotExist()
    }

    @Test
    fun theUnderlyingPageStaysOpaqueThroughTheEntirePushAndPop() {
        lateinit var nav: NavHostController
        rule.setContent {
            nav = rememberNavController()
            val motion = rememberNavMotion()
            Box(Modifier.fillMaxSize().background(Color.Green)) {
                NavHost(
                    navController = nav,
                    startDestination = "first",
                    enterTransition = motion.enter,
                    exitTransition = motion.exit,
                    popEnterTransition = motion.popEnter,
                    popExitTransition = motion.popExit,
                ) {
                    composable("first") { Box(Modifier.fillMaxSize().background(Color.Red)) }
                    composable("second") { Box(Modifier.fillMaxSize().background(Color.Blue)) }
                }
            }
        }
        fun opaque(at: String) {
            rule.waitForIdle()
            val pixels = rule.onRoot().captureToImage().toPixelMap()
            assertEquals("no window background shows through either page at $at", 0f, pixels[pixels.width / 2, pixels.height / 2].green, 0.01f)
        }
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { nav.navigate("second") }
        rule.mainClock.advanceTimeByFrame()
        repeat(4) { rule.mainClock.advanceTimeBy(32); opaque("push frame $it") }
        settle()
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { nav.popBackStack() }
        rule.mainClock.advanceTimeByFrame()
        repeat(4) { rule.mainClock.advanceTimeBy(32); opaque("pop frame $it") }
        settle()
    }

    @Test
    fun backIsTheMirror() {
        show()
        val startAtRest = left(StartTags.CONTENT)
        pushServer()
        settle()
        val serverAtRest = left(ServerTags.FORM)

        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Back").performClick()
        rule.mainClock.advanceTimeByFrame()
        halfway()
        val incoming = left(StartTags.CONTENT) - startAtRest
        val outgoing = left(ServerTags.FORM) - serverAtRest
        settle()
        assertEquals("Back reveals a destination already in place", 0.dp, incoming)
        assertTravelling("the screen Back leaves", outgoing, towardsEnd = true)
        assertEquals(startAtRest, left(StartTags.CONTENT))
    }

    @Test
    fun aSystemBackWithoutGestureProgressUsesTheSameReverseSlide() {
        show()
        val startAtRest = left(StartTags.CONTENT)
        pushServer()
        settle()
        val serverAtRest = left(ServerTags.FORM)
        val input = backInput()
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { input.complete() }
        rule.mainClock.advanceTimeByFrame()
        halfway()
        val incoming = left(StartTags.CONTENT) - startAtRest
        val outgoing = left(ServerTags.FORM) - serverAtRest
        settle()
        assertEquals("system Back reveals a destination already in place", 0.dp, incoming)
        assertTravelling("system Back leaves", outgoing, towardsEnd = true)
        rule.node(ServerTags.FORM).assertDoesNotExist()
    }

    @Test
    fun predictiveBackScrubsTheReverseSlideAndCanCancelThenComplete() =
        predictiveBack(LayoutDirection.Ltr, NavigationEvent.EDGE_LEFT)

    @Test
    fun rightToLeftPredictiveBackFromTheOtherEdgeMirrorsTheSameMotion() =
        predictiveBack(LayoutDirection.Rtl, NavigationEvent.EDGE_RIGHT)

    private fun predictiveBack(direction: LayoutDirection, edge: Int) {
        show(direction)
        val startAtRest = left(StartTags.CONTENT)
        pushServer()
        settle()
        val serverAtRest = left(ServerTags.FORM)
        val serverBounds = rule.node(ServerTags.FORM).bounds
        val input = backInput()
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { input.start(edge) }
        rule.mainClock.advanceTimeByFrame()
        rule.waitForIdle()
        rule.runOnUiThread { input.progress(0.5f, edge) }
        repeat(3) { rule.mainClock.advanceTimeByFrame() }
        rule.waitForIdle()
        val sign = if (direction == LayoutDirection.Ltr) 1 else -1
        assertEquals("gesture reveals the stationary destination", startAtRest, left(StartTags.CONTENT))
        // Halfway through decelerate(1.5): 48 * (1 - .5^3) = 42 dp.
        assertDp("Telegram foreground at half gesture progress", 42.dp, (left(ServerTags.FORM) - serverAtRest) * sign)
        val during = rule.node(ServerTags.FORM).bounds
        assertEquals("the gesture never scales the outgoing page", serverBounds.right - serverBounds.left, during.right - during.left)
        rule.runOnUiThread { input.cancel() }
        settle()
        assertEquals("cancel restores the outgoing page", serverAtRest, left(ServerTags.FORM))
        rule.node(StartTags.CONTENT).assertDoesNotExist()

        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { input.start(edge) }
        rule.mainClock.advanceTimeByFrame()
        rule.waitForIdle()
        rule.runOnUiThread { input.progress(0.5f, edge) }
        repeat(3) { rule.mainClock.advanceTimeByFrame() }
        rule.waitForIdle()
        rule.runOnUiThread { input.complete() }
        settle()
        rule.node(ServerTags.FORM).assertDoesNotExist()
        assertEquals("complete returns to the previous page", startAtRest, left(StartTags.CONTENT))
    }

    @Test
    fun rightToLeftMirrorsThePush() {
        show(LayoutDirection.Rtl)
        pushServer()
        halfway()
        val incoming = left(ServerTags.FORM)
        settle()
        // The end side is the left in a right-to-left layout.
        assertTravelling("the new screen", -(incoming - left(ServerTags.FORM)), towardsEnd = true)
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
        halfway()
        assertEquals("the sidebar doesn't move with the detail", sidebar, rule.node(TabletSidebarTags.SIDEBAR).bounds)
        val chat = left(ChatScreenTags.SCREEN)
        settle()
        assertTravelling("the chat", chat - left(ChatScreenTags.SCREEN), towardsEnd = true)
        assertEquals(sidebar, rule.node(TabletSidebarTags.SIDEBAR).bounds)
        graph.account.value?.let { runBlocking { it.stop() } }
    }
}
