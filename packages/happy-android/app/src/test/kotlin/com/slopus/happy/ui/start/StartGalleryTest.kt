package com.slopus.happy.ui.start

import android.provider.Settings
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The first screen's slides: what they are, how they page, and when they move by themselves. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class StartGalleryTest {
    @get:Rule
    val rule = createComposeRule()

    private val resolver get() = ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver

    @After
    fun animationsBack() {
        Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    }

    private fun show() {
        rule.setHappyContent {
            StartScreen(connecting = false, customServerLabel = null, onStart = {}, onEnterLink = {}, onRestore = {}, onServer = {})
        }
    }

    private fun selected(index: Int) = rule.node(StartGalleryTags.dot(index)).assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))

    /** Desktop's deck less "Secure and compliant": four slides, the logo first. */
    @Test
    fun theSlidesAreDesktopsFour() {
        assertEquals(4, StartSlides.size)
        assertEquals(StartSlide.Art.Logo, StartSlides[0].art)
        assertEquals(listOf("👾", "🦙", "🪄"), StartSlides.drop(1).map { (it.art as StartSlide.Art.Emoji).text })
        show()
        rule.onNodeWithText("Any\u00A0team. Any\u00A0model. One\u00A0app.").assertExists()
        rule.onNodeWithText("Secure and compliant").assertDoesNotExist()
        selected(0)
    }

    /** A swipe brings the next slide; its title is where the first one's was, and the dots stay put. */
    @Test
    fun aSwipePagesAndNothingMoves() {
        rule.mainClock.autoAdvance = true
        show()
        val title = rule.node(StartGalleryTags.title(0)).bounds
        val dots = rule.node(StartGalleryTags.DOTS).bounds
        rule.node(StartGalleryTags.PAGER).performTouchInput { swipeLeft() }
        rule.waitForIdle()
        rule.onNodeWithText("Natively multiplayer").assertExists()
        selected(1)
        assertDp("the title's top stays", title.top, rule.node(StartGalleryTags.title(1)).bounds.top)
        assertEquals(dots, rule.node(StartGalleryTags.DOTS).bounds)
    }

    /** A dot picks its slide; a far one too. */
    @Test
    fun aDotPicksItsSlide() {
        show()
        rule.node(StartGalleryTags.dot(3)).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Yours\u00A0to\u00A0run. Yours\u00A0to\u00A0change.").assertExists()
        selected(3)
    }

    /** Left alone it moves on after eight seconds, not before, and wraps from the last to the first. */
    @Test
    fun itMovesOnByItselfAndWraps() {
        show()
        rule.mainClock.autoAdvance = false
        rule.mainClock.advanceTimeBy(7_500)
        selected(0)
        rule.mainClock.advanceTimeBy(1_500)
        rule.mainClock.advanceTimeBy(1_000)
        selected(1)
        rule.node(StartGalleryTags.dot(3)).performClick()
        rule.mainClock.advanceTimeBy(1_000)
        selected(3)
        rule.mainClock.advanceTimeBy(8_000)
        rule.mainClock.advanceTimeBy(1_000)
        selected(0)
    }

    /** With animations removed nothing moves by itself; the dots still work. */
    @Test
    fun removedAnimationsHoldTheSlide() {
        Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        show()
        rule.mainClock.autoAdvance = false
        rule.mainClock.advanceTimeBy(30_000)
        selected(0)
        rule.node(StartGalleryTags.dot(2)).performClick()
        rule.mainClock.advanceTimeBy(1_000)
        selected(2)
    }
}

/** On a tablet the art grows to 128 and the words keep to a 440 column. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w1280dp-h800dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class StartGalleryTabletTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun tabletLayout() {
        rule.setHappyContent {
            StartScreen(connecting = false, customServerLabel = null, onStart = {}, onEnterLink = {}, onRestore = {}, onServer = {})
        }
        val art = rule.node(StartGalleryTags.art(0)).bounds
        assertBox("art", art, ((1280 - 128) / 2f).dp, art.top, 128.dp, 128.dp)
        val title = rule.node(StartGalleryTags.title(0)).bounds
        assertBox("title", title, ((1280 - 440) / 2f).dp, art.bottom + 24.dp, 440.dp, title.height)
        val start = rule.node(StartTags.CONNECT).bounds
        assertDp("start centred", 640.dp, (start.left + start.right) / 2)
        assertDp("start 48 above the bottom", (800 - 48).dp, start.bottom)
    }
}
