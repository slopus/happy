package com.slopus.happy.ui.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.hasRole
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** useGroupedMessages / ChatList.tsx work groups as the chat draws them, behind the `groupToolCalls` setting. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatWorkGroupsTest {
    @get:Rule
    val rule = createComposeRule()

    private val info = ChatSessionInfo.from(
        SessionRecord("s", 0, 0, 1, true, 0, """{"path":"/repo","host":"devbox","summary":{"text":"Chat","updatedAt":1}}""", 1, null, 1, "", null),
    )

    // Newest first: the answer, the work 62 s before it, the prompt.
    private val rows = listOf(
        ChatReduction.buildRow(ChatMessage.AgentText("a1", 63_000, "All done"), true)!!,
        ChatReduction.buildRow(
            ChatMessage.ToolCallMessage(
                "t1", 1_000,
                ToolCall(name = "Read", state = ToolState.Completed, input = Json.parseToJsonElement("""{"file_path":"/repo/a.kt"}"""), createdAt = 1_000),
            ),
            true,
        )!!,
        ChatReduction.buildRow(ChatMessage.UserText("u1", "l1", 0, "Do it"), true)!!,
    )

    private var thinking by mutableStateOf(false)
    private var foreground by mutableStateOf(true)

    private fun show(group: Boolean = true) = rule.setHappyContent {
        ChatScreen(
            state = ChatState(ChatSnapshot(rows, loaded = true), info, sessionLoaded = true, online = true, thinking = thinking),
            draft = "",
            bubbleColor = "gray",
            actions = ChatScreenActions(),
            groupToolCalls = group,
            foreground = foreground,
        )
    }

    // Read draws as a compact activity row or a card, depending on the tool's presentation.
    private fun tools(count: Int) = rule.onAllNodes(hasTestTag(ToolTags.CARD) or hasTestTag(ToolTags.COMPACT), useUnmergedTree = true).assertCountEquals(count)

    private fun headers(count: Int) = rule.onAllNodesWithTag(AgentWorkGroupHeaderTags.HEADER, useUnmergedTree = true).assertCountEquals(count)

    @Test
    fun offEverythingIsFlat() {
        show(group = false)
        tools(1)
        headers(0)
    }

    // A finished turn's work folds under "Worked 1m2s"; a tap lays it out with "Hide" under it, and Hide folds it again.
    @Test
    fun aFinishedTurnFoldsAndOpens() {
        show()
        tools(0)
        rule.onNodeWithText("Worked 1m2s", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("All done", useUnmergedTree = true).assertExists()
        // TalkBack: a button that reads its label and offers to expand.
        rule.onNode(hasText("Worked 1m2s") and hasRole(Role.Button) and SemanticsMatcher.keyIsDefined(SemanticsActions.Expand)).assertExists()
        rule.assertActionsLabelled()
        rule.onNodeWithText("Worked 1m2s", useUnmergedTree = true).performClick()
        rule.waitForIdle()
        tools(1)
        headers(2)
        rule.onNode(hasText("Hide") and hasRole(Role.Button) and SemanticsMatcher.keyIsDefined(SemanticsActions.Collapse)).assertExists()
        rule.onNodeWithText("Hide", useUnmergedTree = true).performClick()
        rule.waitForIdle()
        tools(0)
        headers(1)
    }

    // The running turn draws flat; once it finishes it stays open (watched live) until the app goes to the background.
    @Test
    fun aWatchedTurnStaysOpenUntilBackgrounded() {
        thinking = true
        show()
        tools(1)
        headers(0)
        thinking = false
        rule.waitForIdle()
        tools(1)
        headers(2)
        foreground = false
        rule.waitForIdle()
        tools(0)
        headers(1)
    }
}
