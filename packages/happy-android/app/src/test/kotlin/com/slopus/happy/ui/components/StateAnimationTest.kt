package com.slopus.happy.ui.components

import android.provider.Settings
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.captureToImage
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
import com.slopus.happy.ui.chat.NewWorkArt
import com.slopus.happy.ui.chat.NewWorkTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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

    /** happy-desktop assets/animations/PROVENANCE.md's hashes (and the ticket's and magic wand's as given): the same bytes, unmodified. */
    @Test
    fun theFilesAreDesktopsExactBytes() {
        val expected = mapOf(
            StateArt.Make to "8de70508fe1ebdeb",
            StateArt.Ready to "eeabc392ba20328c",
            StateArt.Done to "b14e504ce3467a6b",
            StateArt.Owl to "95402270d116a310",
            StateArt.Tickets to "8715ac66cadbd7cb",
            StateArt.Action to "6d23637e2b8e7d83",
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
     * The magic wand rests on its first frame, the still wand: its spell
     * (the light, sparkles, dust and bursts) comes in after it and is gone
     * again before its last, which is the same still wand, so a tap plays
     * the whole spell from rest. The rest keep their last.
     */
    @Test
    fun theMagicWandRestsOnItsStillFirstFrame() {
        assertEquals(listOf(StateArt.Action), StateArt.entries.filter { it.restsOnFirstFrame })
        val json = RuntimeEnvironment.getApplication().resources.openRawResource(StateArt.Action.raw).use { org.json.JSONObject(it.reader().readText()) }
        val first = json.getDouble("ip")
        val last = json.getDouble("op") - 1
        val layers = json.getJSONArray("layers")
        val spell = (0 until layers.length()).map { layers.getJSONObject(it) }
            .filter { it.getString("nm").substringBefore(' ') in setOf("light", "sparcles", "boom", "Particle") || it.getString("nm").startsWith("dust") }
        assertEquals("every part of the spell", 33, spell.size)
        for (layer in spell) {
            val name = layer.getString("nm")
            assertTrue("$name not yet in at $first", layer.getDouble("ip") > first)
            assertTrue("$name gone by $last", layer.getDouble("op") <= last)
        }
        val wand = (0 until layers.length()).map { layers.getJSONObject(it) }.first { it.getString("nm") == "wand" }
        assertTrue("the wand is there throughout", wand.getDouble("ip") <= first && wand.getDouble("op") > last)
    }

    /**
     * New work's pictures are read in the composition that first shows
     * them, cold, and drawn in that first frame: no blank frame while
     * Lottie reads the file on another thread. The other kind's is read
     * with it, so switching is as quick.
     */
    @Test
    fun newWorksPicturesAreThereInTheirFirstFrame() {
        StateCompositions.forget()
        rule.mainClock.autoAdvance = false
        rule.setHappyContent { NewWorkArt(StateArt.Action) }
        assertNotNull("the magic wand read as it is composed", StateCompositions.peek(StateArt.Action.raw))
        assertNotNull("and the robot under it", StateCompositions.peek(StateArt.Ready.raw))
        val pixels = rule.node(NewWorkTags.art(StateArt.Action)).captureToImage().toPixelMap()
        val ground = pixels[0, 0]
        val drawn = (0 until pixels.width step 4).sumOf { x -> (0 until pixels.height step 4).count { y -> pixels[x, y] != ground } }
        assertTrue("the wand is drawn: $drawn", drawn > 100)
    }

    /**
     * A picture not read yet is read without a Lottie task: one still in
     * flight when its screen goes holds every screen that waited on it, and
     * with them their activities, for as long as the process lives.
     */
    @Test
    fun aPictureNotReadYetLeavesNoLottieTaskBehind() {
        StateCompositions.forget()
        LottieCompositionFactory.clearCache(RuntimeEnvironment.getApplication())
        val tasks = LottieCompositionFactory::class.java.getDeclaredField("taskCache").apply { isAccessible = true }.get(null) as Map<*, *>
        rule.setHappyContent { StateAnimation(StateArt.Make, size = 96.dp) }
        assertTrue("no task while it is read: ${tasks.keys}", tasks.isEmpty())
        rule.waitUntil(5_000) { StateCompositions.peek(StateArt.Make.raw) != null }
        assertTrue("nor after: ${tasks.keys}", tasks.isEmpty())
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
