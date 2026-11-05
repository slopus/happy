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
import com.slopus.happy.ui.browser.BrowserAppMode
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
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

    private fun show(direction: LayoutDirection = LayoutDirection.Ltr) {
        rule.setHappyContent {
            CompositionLocalProvider(LocalLayoutDirection provides direction) {
                AppFrame(safeTop = 24.dp, safeStart = 12.dp, onClose = { closed++ }) {
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
        show(LayoutDirection.Rtl)
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

    @Test fun thePageKeepsClearOfTheButtonOnTop() {
        assertDp("top inset", 72.dp, ArtifactAppPageSpec.topInset(24.dp))
        assertEquals("""{"top":72.0,"right":0.0,"bottom":0.0,"left":31.5}""", BrowserAppMode.insetsJson(72f, 0f, 0f, 31.5f))
        val script = BrowserAppMode.SCRIPT
        assertTrue(script.contains("data-happy-page-mode', 'app'"))
        assertTrue(script.contains("overflow: hidden !important; overscroll-behavior: none !important"))
        assertTrue(script.contains("--happy-app-inset-top"))
    }
}
