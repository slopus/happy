package com.slopus.happy.ui.artifacts

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.artifacts.AppClose
import com.slopus.happy.ui.browser.BrowserAppMode
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * An app's frame and close button (task_206's fullscreen-spec.md,
 * Android): a 32 circle 8 in from the safe area's top-start corner, fully
 * there for 3 s, then at 35% until a touch within 64 of it; every touch
 * still reaches the page; "Close" for TalkBack.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class ArtifactAppPageTest {
    @get:Rule val rule = createComposeRule()

    private var closed = 0
    private var touches = 0

    private var told: Pair<BrowserAppMode.Sides, BrowserAppMode.Box?>? = null

    private fun show(direction: LayoutDirection = LayoutDirection.Ltr, close: AppClose = AppClose.TopStart, safe: BrowserAppMode.Sides = BrowserAppMode.Sides(24f, 0f, 0f, 12f)) {
        rule.setHappyContent {
            CompositionLocalProvider(LocalLayoutDirection provides direction) {
                AppFrame(safe, close, onClose = { closed++ }, onLayout = { insets, box -> told = insets to box }) {
                    Box(
                        Modifier
                            .fillMaxSize()
                            .background(Color.White)
                            .pointerInput(Unit) {
                                awaitPointerEventScope {
                                    while (true) {
                                        val event = awaitPointerEvent(PointerEventPass.Main)
                                        if (event.changes.any { it.pressed && !it.previousPressed }) touches++
                                    }
                                }
                            }
                            .testTag("page"),
                    )
                }
            }
        }
    }

    private fun alpha(): Float = rule.node(ArtifactAppPageTags.CLOSE).fetchSemanticsNode().config[ArtifactAppPageTags.CloseAlpha]

    @Test fun theButtonSitsInTheSafeAreasTopStartCorner() {
        show()
        assertBox("close", rule.node(ArtifactAppPageTags.CLOSE).bounds, 20.dp, 32.dp, 32.dp, 32.dp)
        assertBox("page", rule.node("page").bounds, 0.dp, 0.dp, PHONE_WIDTH.dp, 891.dp)
        val config = rule.node(ArtifactAppPageTags.CLOSE).fetchSemanticsNode().config
        assertEquals("Close", config[SemanticsProperties.ContentDescription].single())
    }

    @Test fun rightToLeftItSitsTopRight() {
        show(LayoutDirection.Rtl, safe = BrowserAppMode.Sides(24f, 12f, 0f, 0f))
        val close = rule.node(ArtifactAppPageTags.CLOSE).bounds
        assertDp("right", (PHONE_WIDTH - 20).dp, close.right)
        assertDp("top", 32.dp, close.top)
    }

    @Test fun itFadesAfterThreeSecondsAndATouchNearItBringsItBack() {
        rule.mainClock.autoAdvance = false
        show()
        rule.mainClock.advanceTimeByFrame()
        assertEquals(1f, alpha())
        rule.mainClock.advanceTimeBy(2_900)
        assertEquals(1f, alpha())
        rule.mainClock.advanceTimeBy(200)
        assertEquals(ArtifactAppPageSpec.FADED_ALPHA, alpha())

        // Far from it: it stays faded, and the page has the touch.
        rule.node("page").performTouchInput { down(Offset(300.dp.toPx(), 600.dp.toPx())); up() }
        rule.mainClock.advanceTimeBy(100)
        assertEquals(ArtifactAppPageSpec.FADED_ALPHA, alpha())
        assertEquals(1, touches)

        // Within 64 of it: it wakes, and the page still has the touch.
        rule.node("page").performTouchInput { down(Offset(100.dp.toPx(), 100.dp.toPx())); up() }
        rule.mainClock.advanceTimeBy(100)
        assertEquals(1f, alpha())
        assertEquals(2, touches)
        rule.mainClock.advanceTimeBy(3_100)
        assertEquals(ArtifactAppPageSpec.FADED_ALPHA, alpha())
    }

    @Test fun tappingItCloses() {
        show()
        rule.node(ArtifactAppPageTags.CLOSE).performClick()
        assertEquals(1, closed)
        // The button takes its own tap; the page never sees it.
        assertEquals(0, touches)
    }

    /** The addendum: the 48 goes on the button's edge, and the page is told the button's 48 box; `none` has neither. */
    @Test fun thePageKeepsClearOfTheButtonOnItsEdge() {
        val safe = BrowserAppMode.Sides(24f, 0f, 16f, 12f)
        fun layout(close: AppClose, rtl: Boolean = false) = ArtifactAppPageSpec.layout(close, 411f, 891f, safe, rtl)
        assertEquals(BrowserAppMode.Sides(72f, 0f, 16f, 12f) to BrowserAppMode.Box(12f, 24f, 48f, 48f), layout(AppClose.TopStart))
        assertEquals(BrowserAppMode.Sides(72f, 0f, 16f, 12f) to BrowserAppMode.Box(363f, 24f, 48f, 48f), layout(AppClose.TopEnd))
        assertEquals(BrowserAppMode.Sides(24f, 0f, 64f, 12f) to BrowserAppMode.Box(12f, 827f, 48f, 48f), layout(AppClose.BottomStart))
        assertEquals(BrowserAppMode.Sides(24f, 0f, 64f, 12f) to BrowserAppMode.Box(363f, 827f, 48f, 48f), layout(AppClose.BottomEnd))
        assertEquals(safe to null, layout(AppClose.None))
        // Start and end are logical: right to left, start is the right.
        assertEquals(BrowserAppMode.Box(363f, 24f, 48f, 48f), layout(AppClose.TopStart, rtl = true).second)
        assertEquals(BrowserAppMode.Box(12f, 827f, 48f, 48f), layout(AppClose.BottomEnd, rtl = true).second)
    }

    @Test fun inItsCornerItIsWhereThePageIsTold() {
        show(close = AppClose.BottomEnd, safe = BrowserAppMode.Sides(24f, 0f, 16f, 12f))
        assertBox("close", rule.node(ArtifactAppPageTags.CLOSE).bounds, (PHONE_WIDTH - 40).dp, (891 - 16 - 40).dp, 32.dp, 32.dp)
        assertEquals(BrowserAppMode.Sides(24f, 0f, 64f, 12f) to BrowserAppMode.Box(PHONE_WIDTH - 48f, 891f - 16 - 48, 48f, 48f), told)
    }

    /** `none`: no button, not drawn, tapped or read, until a swipe down from the top shows it top-start for 3 s. */
    @Test fun withNoneASwipeDownFromTheTopShowsItForThreeSeconds() {
        // The clock runs: paused, a move's change waits for the next touch.
        show(close = AppClose.None)
        assertEquals(0f, alpha())
        assertEquals(BrowserAppMode.Sides(24f, 0f, 0f, 12f) to null, told)
        // A swipe down that starts lower is the page's.
        rule.node("page").performTouchInput { down(Offset(200.dp.toPx(), 200.dp.toPx())); moveBy(Offset(0f, 100.dp.toPx())); up() }
        rule.mainClock.advanceTimeBy(100)
        assertEquals(0f, alpha())
        rule.node("page").performTouchInput { down(Offset(200.dp.toPx(), 10.dp.toPx())); moveBy(Offset(0f, 100.dp.toPx())); up() }
        rule.mainClock.advanceTimeBy(100)
        assertEquals(1f, alpha())
        assertBox("close", rule.node(ArtifactAppPageTags.CLOSE).bounds, 20.dp, 32.dp, 32.dp, 32.dp)
        rule.mainClock.advanceTimeBy(3_100)
        assertEquals(0f, alpha())
        // Both swipes went on to the page.
        assertEquals(2, touches)
    }

    /** Only "close", from the page's own origin and main frame, closes it. */
    @Test fun happyAppCloseIsThePagesOwnOnly() {
        val origin = "http://a1.happy-artifact.invalid"
        assertTrue(BrowserAppMode.accepts(origin, origin, mainFrame = true, data = "close"))
        assertTrue(BrowserAppMode.accepts(origin, "$origin/", mainFrame = true, data = "close"))
        assertFalse(BrowserAppMode.accepts(origin, origin, mainFrame = false, data = "close"))
        assertFalse(BrowserAppMode.accepts(origin, "http://a2.happy-artifact.invalid", mainFrame = true, data = "close"))
        assertFalse(BrowserAppMode.accepts(origin, origin, mainFrame = true, data = "open"))
        val script = BrowserAppMode.script(BrowserAppMode.Values("top-end", BrowserAppMode.Sides(72f, 0f, 0f, 31.5f), BrowserAppMode.Box(363f, 24f, 48f, 48f)))
        assertTrue(script.contains("data-happy-page-mode', 'app'"))
        assertTrue(script.contains("data-happy-app-close', 'top-end'"))
        assertTrue(script.contains("overflow: hidden !important; overscroll-behavior: none !important"))
        assertTrue(script.contains("--happy-app-inset-top: 72.0px; --happy-app-inset-right: 0.0px; --happy-app-inset-bottom: 0.0px; --happy-app-inset-left: 31.5px;"))
        assertTrue(script.contains("--happy-app-close-x: 363.0px; --happy-app-close-y: 24.0px; --happy-app-close-width: 48.0px; --happy-app-close-height: 48.0px;"))
        assertTrue(script.contains("--happy-host-page-inset: 0px;"))
        assertTrue(script.contains("happyAppHost.postMessage('close')") || script.contains("bridge.postMessage('close')"))
        val none = BrowserAppMode.script(BrowserAppMode.Values("none", BrowserAppMode.Sides(24f, 0f, 0f, 0f), null))
        assertTrue(none.contains("--happy-app-close-x: 0.0px; --happy-app-close-y: 0.0px; --happy-app-close-width: 0.0px; --happy-app-close-height: 0.0px;"))
    }
}
