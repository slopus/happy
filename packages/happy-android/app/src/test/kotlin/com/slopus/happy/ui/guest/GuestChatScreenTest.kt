package com.slopus.happy.ui.guest

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.guest.GuestChatState
import com.slopus.happy.guest.GuestLine
import com.slopus.happy.guest.GuestSender
import com.slopus.happy.guest.GuestStatus
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The guest chat's one screen, as iOS's GuestChatViewController lays it out. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class GuestChatScreenTest {
    @get:Rule val rule = createComposeRule()

    private val joins = mutableListOf<String>()
    private var sends = 0
    private var leaves = 0

    private fun show(initial: GuestChatState) {
        rule.setHappyContent {
            var state by remember { mutableStateOf(initial) }
            GuestChatScreen(
                state = state,
                onBack = {},
                onJoin = { joins += it },
                onDraft = { state = state.copy(draft = it) },
                onSend = { sends++ },
                onRetry = {},
                onReport = {},
                onLeave = { leaves++ },
            )
        }
    }

    @Test
    fun aNewGuestIsAskedOnlyTheirNameAndToldWhoSeesTheChat() {
        show(GuestChatState(status = GuestStatus.EnterName, naming = true))
        rule.onNodeWithText("Join a Happy bot").assertExists()
        rule.onNodeWithText("Enter your name to start chatting.").assertExists()
        rule.onNodeWithText("Everyone who joins this link can see this chat, including earlier messages. Names are chosen by members and aren’t verified.").assertExists()
        val name = rule.node(GuestChatTags.NAME).bounds
        val join = rule.node(GuestChatTags.JOIN).bounds
        assertDp("the name field 20 from the side", 20, name.left)
        assertTrue(join.top >= name.bottom + 11.dp)
        rule.node(GuestChatTags.NAME).performTextInput("Ada")
        rule.node(GuestChatTags.JOIN).performClick()
        assertEquals(listOf("Ada"), joins)
        // Nothing to report or leave before joining.
        rule.onAllNodesWithTag(GuestChatTags.MORE, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun aJoinedGuestSeesTheChatAsPlainTextAndWritesAsThemselves() {
        show(
            GuestChatState(
                botName = "Helper",
                status = GuestStatus.Live,
                joined = true,
                displayName = "Ada",
                lines = listOf(
                    GuestLine("1", GuestSender.Bot("Helper"), "Hello **Ada**"),
                    GuestLine("2", GuestSender.You, "Hi"),
                    GuestLine("3", GuestSender.Member(null), "Hey"),
                ),
            ),
        )
        rule.onNodeWithText("Hello **Ada**").assertExists()
        rule.onNodeWithText("You").assertExists()
        rule.onNodeWithText("Member").assertExists()
        rule.onNodeWithText("Guest conversation · Invitation access only").assertExists()
        rule.onNodeWithText("Message as Ada").assertExists()
        val transcript = rule.node(GuestChatTags.TRANSCRIPT).bounds
        val message = rule.node(GuestChatTags.MESSAGE).bounds
        assertTrue(message.top >= transcript.bottom + 11.dp)
        rule.node(GuestChatTags.MESSAGE).performTextInput("Hello")
        rule.node(GuestChatTags.SEND).performClick()
        assertEquals(1, sends)
        rule.node(GuestChatTags.MORE).performClick()
        rule.onNodeWithText("Leave conversation").performClick()
        assertEquals(1, leaves)
    }

    @Test
    fun readOnlyHidesTheComposer() {
        show(GuestChatState(botName = "Helper", status = GuestStatus.ReadOnly, joined = true, readOnly = true))
        rule.onNodeWithText("Read only · You can view this conversation.").assertExists()
        rule.onAllNodesWithTag(GuestChatTags.MESSAGE, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(GuestChatTags.SEND, useUnmergedTree = true).assertCountEquals(0)
    }
}
