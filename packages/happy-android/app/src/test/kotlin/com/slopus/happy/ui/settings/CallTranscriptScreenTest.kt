package com.slopus.happy.ui.settings

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.call.CallConnection
import com.slopus.happy.call.CallEvents
import com.slopus.happy.call.CallGrant
import com.slopus.happy.call.CallStart
import com.slopus.happy.call.CallToolCall
import com.slopus.happy.call.CallToolResult
import com.slopus.happy.call.CallTranscript
import com.slopus.happy.call.MemoryTranscriptStore
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Developer mode's Last voice call transcript: its row after Version, and its page. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = PHONE)
class CallTranscriptScreenTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun theRowIsDevelopersOnly() {
        var developer by mutableStateOf(false)
        var opened = 0
        rule.setHappyContent {
            SettingsScreen(SettingsFixtures.profile, AboutInfo("1", developer = developer), aboutActions = AboutActions(onCallTranscript = { opened++ }))
        }
        rule.node(SettingsTags.VERSION).performScrollTo()
        rule.onNodeWithText("Last voice call transcript").assertDoesNotExist()
        developer = true
        rule.node(SettingsTags.CALL_TRANSCRIPT).performScrollTo().performClick()
        assertEquals(1, opened)
    }

    @Test
    fun beforeAnyCallItSaysSo() {
        rule.setHappyContent { CallTranscriptScreen(CallTranscript(MemoryTranscriptStore()), onBack = {}) }
        // Read off the main thread.
        rule.waitUntil(5_000) { rule.onAllNodes(hasTestTag(CallTranscriptTags.EMPTY), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.node(CallTranscriptTags.EMPTY).assertIsDisplayed()
    }

    @Test
    fun theLastCallShowsWithItsKinds() {
        val transcript = CallTranscriptFixture.transcript()
        rule.setHappyContent { CallTranscriptScreen(transcript, onBack = {}) }
        rule.waitUntil(5_000) { rule.onAllNodes(hasTestTag(CallTranscriptTags.LIST), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.node(CallTranscriptTags.LIST).assertIsDisplayed()
        rule.onNodeWithText("Duration", substring = true).assertIsDisplayed()
        // A lazy list: what is off screen isn't there until scrolled to.
        for (text in listOf("How is the cache task doing?", """{"ref":"s3"}""", "the app ended it")) {
            rule.node(CallTranscriptTags.LIST).performScrollToNode(hasText(text))
            rule.onNodeWithText(text).assertIsDisplayed()
        }
    }
}

/** A short made-up call, recorded through the real [CallTranscript]; nothing connects. */
object CallTranscriptFixture {
    /** The prompt's first lines: a real call sends all of [com.slopus.happy.call.CallPrompt.SYSTEM], screens of it. */
    private const val PROMPT = "You are Happy, a voice companion for the person's coding agents on their computer. Speak briefly and plainly: one or two sentences unless asked for more. …"

    fun transcript(): CallTranscript = CallTranscript(MemoryTranscriptStore()).also { transcript ->
        runBlocking {
            val events = CallEvents(activity = { _, _, _ -> }, disconnected = {}, hungUp = {}, tool = {
                CallToolResult("""{"ok":true,"ref":"s3","title":"Ship the cache","status":"idle","lastMessage":"Benchmarks are in: 38% fewer reads."}""")
            })
            var given: CallEvents? = null
            val context = "Time: 14:02, Tuesday 17 November. focusRevision 4\n\nOn screen: Ship the cache (s3)\n\nConversations:\n- s1 Release notes\n- s3 Ship the cache\n  - s31 Measure the hit rate"
            val connection = transcript.record { _, _, it -> given = it; Nothing() }(CallGrant("fixture"), CallStart(context, prompt = PROMPT), events)
            val said = given!!
            said.said("Hi! What would you like to check?", 1)
            said.heard("How is the cache task doing?")
            said.tool(CallToolCall("t1", "readConversation", buildJsonObject { put("ref", JsonPrimitive("s3")) }))
            said.said("Ship the cache is idle; its last message says the benchmarks show 38% fewer reads.", 2)
            connection.update("""{"event":"assistant_text","title":"Release notes","ref":"s1","text":"Drafted the notes.","finishedTurn":true}""")
            connection.update("""{"event":"unfollowed","title":"Fixture task 12","ref":"s12","reason":"no longer among the ten last visited"}""")
            said.heard("Thanks, that's all.")
            said.said("Talk soon!", 3)
            connection.end()
        }
    }

    private class Nothing : CallConnection {
        override suspend fun end() {}
        override suspend fun setMuted(muted: Boolean) {}
        override fun update(context: String) {}
        override fun cue(facts: String) {}
    }
}
