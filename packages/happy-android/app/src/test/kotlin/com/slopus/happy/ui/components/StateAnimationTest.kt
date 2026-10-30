package com.slopus.happy.ui.components

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.security.MessageDigest

/** Desktop's state pictures: the exact files, a fixed box, and a page that keeps its text and action. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class StateAnimationTest {
    @get:Rule val rule = createComposeRule()

    /** happy-desktop assets/animations/PROVENANCE.md's hashes: the same bytes, unmodified. */
    @Test
    fun theFilesAreDesktopsExactBytes() {
        val expected = mapOf(
            StateArt.Waiting to "6a9c7b648681ae9d",
            StateArt.Make to "8de70508fe1ebdeb",
            StateArt.Ready to "eeabc392ba20328c",
            StateArt.Done to "b14e504ce3467a6b",
        )
        val resources = RuntimeEnvironment.getApplication().resources
        for ((art, hash) in expected) {
            val bytes = resources.openRawResource(art.raw).use { it.readBytes() }
            val actual = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            assertEquals(art.name, hash, actual.take(16))
        }
    }

    @Test
    fun theBoxIsFixedWhileItLoadsAndPlays() {
        rule.setHappyContent { StateAnimation(StateArt.Waiting, size = 96.dp) }
        val box = rule.node(StateAnimationTags.ANIMATION).bounds
        assertDp("width", 96, box.right - box.left)
        assertDp("height", 96, box.bottom - box.top)
        rule.mainClock.advanceTimeBy(1_500)
        assertEquals(box, rule.node(StateAnimationTags.ANIMATION).bounds)
    }

    @Test
    fun aPageKeepsItsTextAndAction() {
        var tapped = 0
        rule.setHappyContent { StatePage(title = "No conversations yet", body = "Start one.", art = StateArt.Make, action = "New chat" to { tapped++ }) }
        rule.onNodeWithText("No conversations yet").assertExists()
        rule.onNodeWithText("Start one.").assertExists()
        rule.onNodeWithText("New chat").performClick()
        assertEquals(1, tapped)
    }
}
