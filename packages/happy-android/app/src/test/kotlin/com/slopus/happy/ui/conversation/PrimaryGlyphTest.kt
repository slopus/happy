package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Problem
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.PrimaryGlyphMotion
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * The Happy Agent composer's primary button (iOS AgentInputPrimaryGlyphMotion,
 * desktop Shaker.tsx): Send and Stop morph over 0.2 s, a failed stop shakes,
 * and the field says "Type a message ...".
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PrimaryGlyphTest {
    @get:Rule val rule = createComposeRule()

    private var state by mutableStateOf(ConversationState(created = true, loaded = true))

    private fun show() = rule.setHappyContent {
        Box(Modifier.fillMaxWidth()) {
            ConversationComposer(state, "", onTextChange = {}, onSend = { _, _ -> false }, onSent = {}, onStop = {}, onModeChange = {})
        }
    }

    private fun glyphs(label: String) = rule.onAllNodesWithContentDescription(label, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun shot(name: String): Bitmap {
        val bitmap = rule.node(ConversationComposerTags.PRIMARY).captureToImage().asAndroidBitmap()
        val dir = File("build/chat-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return bitmap
    }

    /** Pixels the glyph draws at full strength: near white on the dark button. */
    private fun white(bitmap: Bitmap): Int {
        var n = 0
        for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
            val c = bitmap.getPixel(x, y)
            if (android.graphics.Color.red(c) > 230 && android.graphics.Color.green(c) > 230 && android.graphics.Color.blue(c) > 230) n++
        }
        return n
    }

    @Test
    fun theFieldSaysTypeAMessage() {
        show()
        rule.onNodeWithText("Type a message ...").assertExists()
    }

    @Test
    fun sendTurnsIntoStopOverAFifthOfASecond() {
        show()
        rule.waitForIdle()
        assertEquals(1, glyphs("Send"))
        rule.mainClock.autoAdvance = false
        state = state.copy(working = true)
        Snapshot.sendApplyNotifications()
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeBy(PrimaryGlyphMotion.DURATION_MS / 2L)
        // Halfway, both: the arrow going, the square coming, neither whole.
        assertEquals("the new glyph is in", 1, glyphs("Stop"))
        assertEquals("the old one not yet gone", 1, glyphs("Send"))
        val half = shot("primary-morph-half")
        rule.mainClock.advanceTimeBy(PrimaryGlyphMotion.DURATION_MS.toLong())
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        val whole = shot("primary-morph-stop")
        // Neither glyph is whole halfway: less of the button is the glyph's full white.
        assertTrue("half drawn halfway: ${white(half)} vs ${white(whole)}", white(half) < white(whole) * 0.8)
        assertEquals("the arrow is gone", 0, glyphs("Send"))
    }

    @Test
    fun aStopThatFailsShakesTheButton() {
        state = state.copy(working = true)
        show()
        rule.waitForIdle()
        val rest = rule.node(ConversationComposerTags.PRIMARY).bounds
        rule.mainClock.autoAdvance = false
        state = state.copy(stopping = true)
        Snapshot.sendApplyNotifications()
        rule.mainClock.advanceTimeBy(400)
        state = state.copy(stopping = false, alert = Problem.Said("No route to the computer."))
        Snapshot.sendApplyNotifications()
        rule.mainClock.advanceTimeByFrame()
        val seen = (1..8).map {
            rule.mainClock.advanceTimeBy(16)
            rule.node(ConversationComposerTags.PRIMARY).bounds.left
        }
        val moved = rule.node(ConversationComposerTags.PRIMARY).bounds.copy(left = seen.maxBy { kotlin.math.abs((it - rest.left).value) })
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertTrue("shaken sideways: $seen vs $rest", moved.left != rest.left)
        assertEquals("and back", rest, rule.node(ConversationComposerTags.PRIMARY).bounds)
    }
}
