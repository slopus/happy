package com.slopus.happy.ui.chat

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The chat's rows skip what didn't change, over a 5000-message session: a
 * new or changed message composes only its own row; presence, the clock,
 * agent state and the dock's fade compose none; a row composes once as it
 * scrolls in.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatRecompositionTest {
    @get:Rule
    val rule = createComposeRule()

    private val compositions = HashMap<String, Int>()

    // One instance: a new lambda would be a new local value and recompose every row by itself.
    private val observer: (String) -> Unit = { key -> compositions[key] = (compositions[key] ?: 0) + 1 }

    private fun session(agentState: String? = null) = ChatSessionInfo.from(
        SessionRecord("s", 0, 0, 1, true, 0, """{"path":"/repo","host":"devbox","summary":{"text":"Chat","updatedAt":1}}""", 1, agentState, 1, "", null),
    )

    private fun text(i: Int) = ChatReduction.buildRow(ChatMessage.AgentText("a$i", i.toLong(), "Reply **$i** with `code`"), true)!!

    private fun tool(i: Int, state: ToolState) = ChatReduction.buildRow(
        ChatMessage.ToolCallMessage(
            "t$i", i.toLong(),
            ToolCall(name = "Edit", state = state, input = Json.parseToJsonElement("""{"file_path":"/repo/a.kt","old_string":"a","new_string":"b"}"""), createdAt = i.toLong()),
        ),
        true,
    )!!

    // Newest first, as the reducer hands them over: a tool call on top of 4999 replies.
    private val history: List<ChatRow> = listOf(tool(5000, ToolState.Running)) + (4999 downTo 1).map(::text)

    private var state by mutableStateOf(ChatState(ChatSnapshot(history, loaded = true), session(), sessionLoaded = true, online = true))
    private var now by mutableLongStateOf(1_000L)

    // Held, as ChatRoute holds its actions: new actions are new callbacks for every row.
    private val actions = ChatScreenActions()

    private fun show() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalChatRowObserver provides observer) {
                ProvideWindowLayout {
                    ChatScreen(state, draft = "", bubbleColor = "gray", actions = actions, now = now)
                }
            }
        }
        rule.waitForIdle()
    }

    private fun counts(): Map<String, Int> {
        rule.waitForIdle()
        return HashMap(compositions)
    }

    private fun assertNoRowComposed(before: Map<String, Int>, what: String) = assertEquals(what, before, counts())

    @Test
    fun aNewMessageComposesOnlyItsRow() {
        show()
        val before = counts()
        assertTrue("only what fits composed: ${before.size}", before.size in 3..40)
        assertTrue(before.values.all { it == 1 })
        state = state.copy(snapshot = state.snapshot.copy(rows = listOf(text(5001)) + state.snapshot.rows))
        val after = counts()
        assertEquals(1, after["a5001"])
        assertEquals(before, after - "a5001")
    }

    @Test
    fun aChangedMessageComposesOnlyItsRow() {
        show()
        val before = counts()
        state = state.copy(snapshot = state.snapshot.copy(rows = listOf(tool(5000, ToolState.Completed)) + state.snapshot.rows.drop(1)))
        val after = counts()
        assertEquals((before["t5000"] ?: 0) + 1, after["t5000"])
        assertEquals((before["tool:t5000"] ?: 0) + 1, after["tool:t5000"])
        assertEquals(before - "t5000" - "tool:t5000", after - "t5000" - "tool:t5000")
    }

    @Test
    fun presenceTheClockAndAgentStateComposeNoRow() {
        show()
        val before = counts()
        state = state.copy(thinking = true)
        assertNoRowComposed(before, "thinking")
        state = state.copy(online = false, thinking = false)
        assertNoRowComposed(before, "offline")
        now += 60_000
        assertNoRowComposed(before, "the clock")
        state = state.copy(session = session("""{"controlledByUser":false,"requests":{"r1":{"tool":"Bash","arguments":{},"createdAt":1}}}"""))
        assertNoRowComposed(before, "agent state")
    }

    // Reading back far enough to fade the dock's details: rows on screen throughout don't recompose.
    // (Rows the list had composed just past the edge may be composed again as they scroll in.)
    @Test
    fun scrollingAndTheDockFadeRecomposeNoRowOnScreen() {
        show()
        val shown = counts().keys.filter { key -> key.startsWith("a") && onScreen(key) }
        assertTrue("rows on screen: $shown", shown.size >= 5)
        rule.node(ChatListTags.LIST).performTouchInput { swipeDown(startY = top + 300f, endY = top + 700f) }
        val after = counts()
        assertTrue("the details faded", rule.node(ChatListTags.SCROLL_BUTTON).isDisplayedSafe())
        val stayed = shown.filter(::onScreen)
        assertTrue("rows stayed on screen: $stayed", stayed.size >= 3)
        stayed.forEach { assertEquals("$it composed once", 1, after[it]) }
        assertTrue(after.values.all { it <= 2 })
    }

    // Markdown is parsed once per message by the reducer (ChatFeedTest pins row identity);
    // a code block scrolled away and back isn't tokenized again either.
    @Test
    fun aCodeBlockScrolledAwayAndBackIsTokenizedOnce() {
        HighlightCache.clear()
        val code = ChatReduction.buildRow(ChatMessage.AgentText("code", 6000, "Look:\n\n```kotlin\nval x = listOf(1, 2)\n```"), true)!!
        state = state.copy(snapshot = state.snapshot.copy(rows = listOf(code) + history))
        show()
        rule.node(MarkdownTags.CODE_BLOCK).assertExists()
        assertEquals(1, HighlightCache.misses)
        rule.node(ChatListTags.LIST).performTouchInput { swipeDown(startY = top + 100f, endY = bottom - 100f) }
        rule.node(ChatListTags.LIST).performTouchInput { swipeDown(startY = top + 100f, endY = bottom - 100f) }
        rule.waitForIdle()
        rule.onAllNodesWithTag(MarkdownTags.CODE_BLOCK, useUnmergedTree = true).assertCountEquals(0)
        rule.node(ChatListTags.SCROLL_BUTTON).performClick()
        rule.waitForIdle()
        rule.node(MarkdownTags.CODE_BLOCK).assertExists()
        assertEquals(1, HighlightCache.misses)
    }

    private fun onScreen(key: String): Boolean {
        val list = rule.node(ChatListTags.LIST).bounds
        val nodes = rule.onAllNodesWithText("Reply ${key.removePrefix("a")} with", substring = true, useUnmergedTree = true).fetchSemanticsNodes()
        return nodes.any { node ->
            val r = node.boundsInRoot
            with(rule.density) { r.top.toDp() >= list.top && r.bottom.toDp() <= list.bottom }
        }
    }

    private fun androidx.compose.ui.test.SemanticsNodeInteraction.isDisplayedSafe() =
        runCatching { assertExists() }.isSuccess
}
