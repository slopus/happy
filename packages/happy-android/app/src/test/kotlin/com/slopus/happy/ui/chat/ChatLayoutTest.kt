package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.AgentEvent
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.MessageMeta
import com.slopus.happy.chat.SessionAuthor
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.SessionState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.hasRole
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val gray = userMessageBubblePalette("gray", dark = false)

    private fun userRow(text: String, pending: Boolean = false, meta: String? = null, author: SessionAuthor? = null, createdAt: Long = 0) =
        ChatReduction.buildRow(
            ChatMessage.UserText(
                "u", "l", createdAt, text,
                meta = meta?.let { MessageMeta(Json.parseToJsonElement(it) as JsonObject) },
                pending = pending,
                author = author,
            ),
            isClaudeFlavor = false,
        ) as ChatRow.User

    private fun session(
        metadata: String = """{"path":"/home/me/app","host":"devbox","homeDir":"/home/me","os":"linux","summary":{"text":"Fix the login","updatedAt":1}}""",
        agentState: String? = null,
        createdAt: Long = 0,
    ) = ChatSessionInfo.from(SessionRecord("s", 0, createdAt, 1, true, 0, metadata, 1, agentState, 1, "", null))

    // MessageView.tsx: 16 side padding and 6 on top; the bubble padded 12/4
    // with 4 below; the text block's own 8 above and 10 below; the 14-high
    // status line 2 under the bubble's margin.
    @Test
    fun userBubble() {
        rule.setHappyContent { UserMessage(userRow("Hello"), gray, MessageCallbacks()) }
        val row = rule.node(MessageTags.USER).bounds
        val bubble = rule.node(MessageTags.USER_BUBBLE).bounds
        val text = rule.node(MarkdownTags.TEXT).bounds
        assertDp("bubble ends 16 in", (PHONE_WIDTH - 16).dp, bubble.right)
        assertDp("bubble top", 6, bubble.top - row.top)
        assertDp("text 12 in", 12, text.left - bubble.left)
        assertDp("text 4 + 8 down", 12, text.top - bubble.top)
        assertDp("one line bubble", 4 + 8 + 25 + 10 + 4, bubble.bottom - bubble.top)
        val status = rule.node(MessageTags.USER_STATUS).bounds
        assertDp("status ends 16 in", (PHONE_WIDTH - 16).dp, status.right)
        assertDp("status 4 + 2 under the bubble", 6, status.top - bubble.bottom)
        assertDp("status line", 14, status.bottom - status.top)
        assertDp("row ends 4 under status", 4, row.bottom - status.bottom)
    }

    // A send queued behind a busy turn says so at once; idle sends say nothing for 2 s.
    @Test
    fun pendingStatus() {
        rule.setHappyContent {
            Column {
                UserMessage(userRow("queued", pending = true, meta = """{"queuedWhileBusy":true}"""), gray, MessageCallbacks())
            }
        }
        rule.onNodeWithText("Sends after this turn").assertExists()
    }

    @Test
    fun idlePendingSendIsQuietDuringGrace() {
        rule.setHappyContent {
            // A minute ahead: the grace is read off the wall clock, and a slow first composition must not outlast it.
            UserMessage(userRow("fresh", pending = true, createdAt = System.currentTimeMillis() + 60_000), gray, MessageCallbacks())
        }
        rule.onAllNodesWithText("Sending…").assertCountEquals(0)
    }

    // Another participant: left side, the name above in 14/20, 12 in.
    @Test
    fun otherParticipant() {
        rule.setHappyContent {
            UserMessage(userRow("hi", author = SessionAuthor("x", "Sam", owner = false)), gray, MessageCallbacks())
        }
        val author = rule.node(MessageTags.USER_AUTHOR).bounds
        val bubble = rule.node(MessageTags.USER_BUBBLE).bounds
        assertDp("author box at 16 (its own padding puts the text 12 further in)", 16, author.left)
        assertDp("author line", 20, author.bottom - author.top)
        assertDp("bubble at the left", 16, bubble.left)
        assertDp("bubble 4 under the name", 4, bubble.top - author.bottom)
    }

    // A slash command: a chip "/name", padded 10/2, 4 below.
    @Test
    fun commandChip() {
        val row = ChatReduction.buildRow(
            ChatMessage.UserText("u", null, 0, "<command-name>/compact</command-name><command-message>compact</command-message>"),
            isClaudeFlavor = true,
        )!!
        rule.setHappyContent { MessageView(row, gray, MessageCallbacks()) }
        rule.onNodeWithText("/compact").assertExists()
        rule.onAllNodesWithTag(MessageTags.USER_BUBBLE, useUnmergedTree = true).assertCountEquals(0)
        val chip = rule.node(MessageTags.COMMAND_CHIP).bounds
        assertDp("chip ends 16 in", (PHONE_WIDTH - 16).dp, chip.right)
    }

    // Agent text: 16 margins, 10 above and below; a 20-high copy button at the text's left edge.
    @Test
    fun agentText() {
        val row = ChatReduction.buildRow(ChatMessage.AgentText("a", 0, "Done."), isClaudeFlavor = true)!!
        rule.setHappyContent { MessageView(row, gray, MessageCallbacks()) }
        val container = rule.node(MessageTags.AGENT).bounds
        val text = rule.node(MarkdownTags.TEXT).bounds
        val copy = rule.node(MessageTags.AGENT_COPY).bounds
        assertDp("10 margin above", 10, container.top)
        assertBox("text", text, 16.dp, container.top + 8.dp, text.right - text.left, 25.dp)
        assertBox("copy", copy, 16.dp, text.bottom + 10.dp, 16.dp, 20.dp)
        assertDp("copy button ends the block", 0, container.bottom - copy.bottom)
    }

    @Test
    fun eventsAreCentred() {
        rule.setHappyContent {
            Column(Modifier.fillMaxWidth()) {
                MessageView(ChatRow.Event(ChatMessage.Event("e", 0, AgentEvent.Switch("local"))), gray, MessageCallbacks())
            }
        }
        rule.onNodeWithText("Switched to local mode").assertExists()
        val event = rule.node(MessageTags.EVENT).bounds
        assertDp("8 side margins", PHONE_WIDTH - 16, event.right - event.left)
    }

    // ToolView's activity row: 8 margins, 2 above, 28 tall at least, padded 8/3; the 20 icon box first.
    @Test
    fun toolRow() {
        val tool = ToolCall(name = "Bash", title = "ls -la", state = ToolState.Running, input = null, createdAt = 0)
        rule.setHappyContent { MessageView(ChatRow.Tool(ChatMessage.ToolCallMessage("t", 0, tool)), gray, MessageCallbacks()) }
        rule.onNodeWithText("ls -la").assertExists()
        val row = rule.node(ToolTags.COMPACT).bounds
        assertBox("row", row, 8.dp, 2.dp, (PHONE_WIDTH - 16).dp, 28.dp)
    }

    // ChatFooter: 4 above; the warning 32 in from both sides and 4 lower.
    @Test
    fun footerWarning() {
        rule.setHappyContent { ChatFooter(controlledByUser = true) }
        val footer = rule.node(ChatListTags.FOOTER).bounds
        val warning = rule.node(ChatListTags.CONTROLLED_WARNING).bounds
        assertDp("warning left", 32, warning.left)
        assertDp("warning right", (PHONE_WIDTH - 32).dp, warning.right)
        assertDp("warning top", 8, warning.top - footer.top)
        assertDp("2 below", 2, footer.bottom - warning.bottom)
    }

    @Test
    fun footerWithoutWarning() {
        rule.setHappyContent { ChatFooter(controlledByUser = false) }
        val footer = rule.node(ChatListTags.FOOTER).bounds
        assertDp("just its padding", 6, footer.bottom - footer.top)
    }

    // AgentInput: 8 around; the status row (≥20, 4 below); the card 10 in,
    // 8 above and below; the 44 input box, then the 42 action row with the
    // 42 primary button at its end.
    @Test
    fun composerGeometry() {
        rule.setHappyContent {
            ChatComposer(
                text = "",
                onTextChange = {},
                status = ComposerStatus("online", SessionStatusColors.online, pulsing = false),
                primary = PrimaryAction.Idle,
                onPrimary = {},
            )
        }
        val composer = rule.node(ComposerTags.COMPOSER).bounds
        val status = rule.node(ComposerTags.STATUS_ROW).bounds
        val panel = rule.node(ComposerTags.PANEL).bounds
        val input = rule.node(ComposerTags.INPUT_CONTAINER).bounds
        val actions = rule.node(ComposerTags.ACTION_ROW).bounds
        val primary = rule.node(ComposerTags.PRIMARY).bounds
        assertDp("status row 8 down", 8, status.top - composer.top)
        assertDp("status row height", 20, status.bottom - status.top)
        assertBox("panel", panel, 8.dp, status.bottom, (PHONE_WIDTH - 16).dp, (8 + 44 + 42 + 8).dp)
        assertBox("input", input, 18.dp, panel.top + 8.dp, (PHONE_WIDTH - 36).dp, 44.dp)
        assertBox("action row", actions, 18.dp, input.bottom, (PHONE_WIDTH - 36).dp, 42.dp)
        assertBox("primary", primary, (PHONE_WIDTH - 18 - 42).dp, actions.top, 42.dp, 42.dp)
        assertDp("8 below", 8, composer.bottom - panel.bottom)
        rule.onNodeWithText("Type a message ...").assertExists()
    }

    @Test
    fun composerSendsTypedText() {
        var sent = ""
        rule.setHappyContent {
            var text by remember { mutableStateOf("") }
            ChatComposer(
                text = text,
                onTextChange = { text = it },
                status = null,
                primary = resolvePrimaryAction(text.isNotBlank(), showAbort = false, canAbort = true, blocked = false),
                onPrimary = { sent = text },
            )
        }
        rule.node(ComposerTags.INPUT).performTextInput("ship it")
        rule.node(ComposerTags.PRIMARY).performClick()
        assertEquals("ship it", sent)
    }

    @Test
    fun primaryActionPrecedence() {
        assertEquals(PrimaryAction.Stop, resolvePrimaryAction(hasContent = false, showAbort = true, canAbort = true, blocked = true))
        assertEquals(PrimaryAction.Blocked, resolvePrimaryAction(hasContent = true, showAbort = true, canAbort = true, blocked = true))
        assertEquals(PrimaryAction.Send, resolvePrimaryAction(hasContent = true, showAbort = true, canAbort = true, blocked = false))
        assertEquals(PrimaryAction.Idle, resolvePrimaryAction(hasContent = false, showAbort = true, canAbort = false, blocked = false))
        assertTrue(showsAbort(SessionState.InputRequired))
    }

    // SessionView: header, list, composer; title from the summary.
    @Test
    fun screenWithMessages() {
        val rows = listOf(
            ChatReduction.buildRow(ChatMessage.AgentText("a", 2, "Reply"), true)!!,
            userRow("Question"),
        )
        rule.setHappyContent {
            ChatScreen(
                state = ChatState(ChatSnapshot(rows, loaded = true), session(), sessionLoaded = true, online = true),
                draft = "",
                bubbleColor = "gray",
                actions = ChatScreenActions(),
            )
        }
        rule.onNodeWithText("Fix the login").assertExists()
        rule.onNodeWithText("online").assertExists()
        val bar = rule.node(HeaderTags.BAR).bounds
        val avatar = rule.node(ChatScreenTags.AVATAR).bounds
        assertDp("avatar 28", 28, avatar.right - avatar.left)
        assertDp("avatar centred in the bar", (bar.top + bar.bottom) / 2, (avatar.top + avatar.bottom) / 2)
        // Inverted: the newest row sits lowest, 8 above the composer.
        val agent = rule.node(MessageTags.AGENT).bounds
        val user = rule.node(MessageTags.USER).bounds
        assertTrue(agent.top >= user.bottom)
        val composer = rule.node(ComposerTags.COMPOSER).bounds
        val footer = rule.node(ChatListTags.FOOTER).bounds
        assertDp("8 under the footer", 8, composer.top - footer.bottom)
    }

    /**
     * TalkBack over a chat: the header's back and avatar are named buttons
     * (the avatar, unnamed in happy-app, after the Details it opens); the
     * agent's copy action is "Copy", the primary button "Send" (AgentInput's
     * labels); the input reads its draft. Nothing actionable goes unnamed.
     */
    @Test
    fun chatReadsForTalkBack() {
        val rows = listOf(
            ChatReduction.buildRow(ChatMessage.AgentText("a", 2, "Reply"), true)!!,
            userRow("Question"),
        )
        rule.setHappyContent {
            ChatScreen(
                state = ChatState(ChatSnapshot(rows, loaded = true), session(), sessionLoaded = true, online = true),
                draft = "Draft",
                bubbleColor = "gray",
                actions = ChatScreenActions(),
            )
        }
        rule.onNode(hasContentDescription("Back") and hasRole(Role.Button)).assertExists()
        rule.node(ChatScreenTags.AVATAR).assert(hasContentDescription("Details") and hasRole(Role.Button))
        rule.onNode(hasContentDescription("Send") and hasRole(Role.Button)).assertExists()
        rule.onNode(hasSetTextAction()).assert(hasText("Draft"))
        rule.assertActionsLabelled()
    }

    @Test
    fun deletedSession() {
        rule.setHappyContent {
            ChatScreen(ChatState(sessionLoaded = true), draft = "", bubbleColor = "gray", actions = ChatScreenActions())
        }
        rule.onAllNodesWithText("Session has been deleted").assertCountEquals(2)
        rule.onAllNodesWithTag(ComposerTags.COMPOSER, useUnmergedTree = true).assertCountEquals(0)
        val icon = rule.node(ChatScreenTags.DELETED_ICON).bounds
        val title = rule.node(ChatScreenTags.DELETED_TITLE).bounds
        assertDp("icon 48", 48, icon.right - icon.left)
        assertDp("title 16 under the icon", 16, title.top - icon.bottom)
        assertDp("icon centred", (PHONE_WIDTH / 2f).dp, (icon.left + icon.right) / 2)
    }

    // EmptyMessages: OS icon 72 with 12 below, host, path (~ relative) with 40 below, "No messages yet", "Created …".
    @Test
    fun emptyMessages() {
        val now = 10 * 60_000L
        rule.setHappyContent {
            ChatScreen(
                ChatState(ChatSnapshot(loaded = true), session(createdAt = 0), sessionLoaded = true, online = false),
                draft = "",
                bubbleColor = "gray",
                actions = ChatScreenActions(),
                now = now,
            )
        }
        rule.onNodeWithText("devbox").assertExists()
        rule.onNodeWithText("~/app").assertExists()
        rule.onNodeWithText("No messages yet").assertExists()
        rule.onNodeWithText("Created 10 minutes ago").assertExists()
        val icon = rule.node(ChatScreenTags.EMPTY_ICON).bounds
        val host = rule.node(ChatScreenTags.EMPTY_HOST).bounds
        val path = rule.node(ChatScreenTags.EMPTY_PATH).bounds
        val status = rule.node(ChatScreenTags.EMPTY_STATUS).bounds
        assertDp("icon 72", 72, icon.bottom - icon.top)
        assertDp("12 under the icon", 12, host.top - icon.bottom)
        assertDp("40 under the path", 40, status.top - path.bottom)
    }

    // MarkdownView code block: radius 8 card with 16 padding, the copy button 8 from the top right.
    @Test
    fun codeBlock() {
        rule.setHappyContent { MarkdownView(parseMarkdown("```kotlin\nval x = 1\n```"), Modifier.fillMaxWidth()) }
        val block = rule.node(MarkdownTags.CODE_BLOCK).bounds
        val copy = rule.node(MarkdownTags.CODE_COPY).bounds
        assertDp("copy 8 from the right", 8, block.right - copy.right)
        assertDp("copy 8 into the card", 8, copy.top - block.top)
        assertDp("8 above the card", 8, block.top)
        rule.onNodeWithText("kotlin").assertExists()
    }

    @Test
    fun listsAndRules() {
        rule.setHappyContent { MarkdownView(parseMarkdown("- one\n- two\n\n---"), Modifier.fillMaxWidth()) }
        rule.onAllNodesWithText("•").assertCountEquals(2)
        val rule1 = rule.node(MarkdownTags.RULE).bounds
        assertDp("rule 1 high", 1, rule1.bottom - rule1.top)
    }

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithText(text: String) =
        onAllNodes(androidx.compose.ui.test.hasText(text), useUnmergedTree = true)
}
