package com.slopus.happy.ui.components

import android.provider.Settings
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.airbnb.lottie.LottieCompositionFactory
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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

    /** happy-desktop assets/animations/PROVENANCE.md's hashes (and the ticket's and clapper board's as given): the same bytes, unmodified. */
    @Test
    fun theFilesAreDesktopsExactBytes() {
        val expected = mapOf(
            StateArt.Make to "8de70508fe1ebdeb",
            StateArt.Ready to "eeabc392ba20328c",
            StateArt.Done to "b14e504ce3467a6b",
            StateArt.Owl to "95402270d116a310",
            StateArt.Tickets to "8715ac66cadbd7cb",
            StateArt.Action to "321f9dfe9e03985a",
        )
        val resources = RuntimeEnvironment.getApplication().resources
        for ((art, hash) in expected) {
            val bytes = resources.openRawResource(art.raw).use { it.readBytes() }
            val actual = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            assertEquals(art.name, hash, actual.take(16))
        }
    }

    // The ticket starts at its in-point, frame 60, and ends on 240 (Lottie stops 0.01 short): progress 0 is its first pose.
    @Test
    fun theTicketPlaysFromItsInPoint() {
        val composition = LottieCompositionFactory.fromRawResSync(RuntimeEnvironment.getApplication(), StateArt.Tickets.raw).value!!
        assertEquals(60f, composition.startFrame)
        assertEquals(240f, composition.endFrame, 0.01f)
        assertEquals(60f, composition.frameRate)
        assertEquals(3_000f, composition.duration, 1f)
    }

    /**
     * The clapper board rests on its first frame, the plain board: no letter
     * of "Action!" has popped in there, and every one is gone again before
     * its last frame, so the last isn't worth holding. The rest keep their last.
     */
    @Test
    fun theClapperBoardRestsOnItsPlainFirstFrame() {
        assertEquals(listOf(StateArt.Action), StateArt.entries.filter { it.restsOnFirstFrame })
        val json = RuntimeEnvironment.getApplication().resources.openRawResource(StateArt.Action.raw).use { org.json.JSONObject(it.reader().readText()) }
        val first = json.getDouble("ip")
        val last = json.getDouble("op") - 1
        val layers = json.getJSONArray("layers")
        val letters = (0 until layers.length()).map { layers.getJSONObject(it) }
            .filter { it.getString("nm").substringBefore(' ') in setOf("A", "C", "T", "I", "O", "N", "!", "do") }
        assertEquals("both strokes of every letter", 24, letters.size)
        for (letter in letters) {
            val name = letter.getString("nm")
            val pop = letter.getJSONObject("ks").getJSONObject("s").getJSONArray("k").getJSONObject(0)
            assertTrue("$name not yet in at $first", pop.getDouble("t") > first && pop.getJSONArray("s").getDouble(0) == 0.0)
            assertTrue("$name gone by $last", letter.getDouble("op") <= last)
        }
    }

    @Test
    fun theBoxIsFixedWhileItLoadsAndPlays() {
        rule.setHappyContent { StateAnimation(StateArt.Make, size = 96.dp) }
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

    // Motion on: the replay tap is a button TalkBack names, so the page has no unlabelled action.
    @Test
    fun theReplayTapIsANamedButton() {
        rule.setHappyContent { StatePage(title = "Link Your Computer", body = "Install Happy.", art = StateArt.Make) }
        rule.node(StateAnimationTags.ANIMATION)
            .assertContentDescriptionEquals("Play again")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
            .assert(SemanticsMatcher.keyIsDefined(SemanticsActions.OnClick))
        rule.assertActionsLabelled()
    }

    // Motion off: nothing to replay, so no action, no role and no label, and no focus stop.
    @Test
    fun withReducedMotionThePictureIsNotAControl() {
        Settings.Global.putFloat(RuntimeEnvironment.getApplication().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        rule.setHappyContent { StatePage(title = "Link Your Computer", body = "Install Happy.", art = StateArt.Make) }
        rule.node(StateAnimationTags.ANIMATION)
            .assert(SemanticsMatcher.keyNotDefined(SemanticsActions.OnClick))
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Role))
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.ContentDescription))
        rule.assertActionsLabelled()
    }
}
