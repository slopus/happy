package com.slopus.happy.ui.start

import android.provider.Settings
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onNodeWithContentDescription
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
import com.slopus.happy.R
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.security.MessageDigest

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
        assertEquals(
            listOf(R.raw.state_alien_monster, R.raw.state_llama, R.raw.state_wand),
            StartSlides.drop(1).map { (it.art as StartSlide.Art.Scene).raw },
        )
        show()
        rule.onNodeWithText("Any\u00A0model. Your\u00A0team. One\u00A0app.").assertExists()
        rule.onNodeWithText("Secure and compliant").assertDoesNotExist()
        selected(0)
    }

    /** happy-desktop assets/animations/PROVENANCE.md's alien-monster and llama, and the 📺 sticker Kirill supplied: the same bytes, unmodified. */
    @Test
    fun theScenesAreTheirExactBytes() {
        val resources = ApplicationProvider.getApplicationContext<android.content.Context>().resources
        for ((raw, hash) in listOf(
            R.raw.state_alien_monster to "e0875ef4ae4aa214",
            R.raw.state_llama to "ff16ee4b8a19a782",
            R.raw.state_tv to "3aad5efeefedef3f",
        )) {
            val bytes = resources.openRawResource(raw).use { it.readBytes() }
            val actual = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            assertEquals(resources.getResourceEntryName(raw), hash, actual.take(16))
        }
    }

    /** A slide's scene can be played again with a tap, and is a fixed square while it loads and plays. */
    @Test
    fun aScenePlaysAgainOnATap() {
        show()
        rule.node(StartGalleryTags.dot(1)).performClick()
        rule.waitForIdle()
        val art = rule.node(StartGalleryTags.art(1)).bounds
        assertDp("art square", 96, art.width)
        rule.mainClock.advanceTimeBy(1_500)
        assertEquals(art, rule.node(StartGalleryTags.art(1)).bounds)
        rule.onNodeWithContentDescription("Play again").assertHasClickAction()
    }

    /** A swipe brings the next slide; its title is where the first one's was, and the dots stay put. */
    @Test
    fun aSwipePagesAndNothingMoves() {
        rule.mainClock.autoAdvance = true
        show()
        val art = rule.node(StartGalleryTags.art(0)).bounds
        val title = rule.node(StartGalleryTags.title(0)).bounds
        val body = rule.node(StartGalleryTags.body(0)).bounds
        val dots = rule.node(StartGalleryTags.DOTS).bounds
        rule.node(StartGalleryTags.PAGER).performTouchInput { swipeLeft() }
        rule.waitForIdle()
        rule.onNodeWithText("Natively multiplayer").assertExists()
        selected(1)
        assertEquals(art, rule.node(StartGalleryTags.art(1)).bounds)
        assertDp("the title's top stays", title.top, rule.node(StartGalleryTags.title(1)).bounds.top)
        // A one-line title after a two-line one: the line under it stays where it was.
        val next = rule.node(StartGalleryTags.title(1)).bounds
        assertTrue("one title line here, two before", next.height < title.height)
        assertDp("the line's top stays", body.top, rule.node(StartGalleryTags.body(1)).bounds.top)
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
        // The wrap's crossfade comes all the way back: the first title is drawn.
        assertTrue("the first title is seen after the wrap", inked(StartGalleryTags.title(0)))
    }

    /** Whether any of the node's pixels is as dark as the light palette's text. */
    private fun inked(tag: String): Boolean {
        val pixels = rule.node(tag).captureToImage().toPixelMap()
        return (0 until pixels.width).any { x -> (0 until pixels.height).any { y -> pixels[x, y].luminance() < 0.2f } }
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
