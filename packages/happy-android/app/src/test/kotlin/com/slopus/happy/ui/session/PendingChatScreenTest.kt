package com.slopus.happy.ui.session

import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.AgentGoal
import com.slopus.happy.model.PENDING_CHAT_PREFIX
import com.slopus.happy.model.PendingChat
import com.slopus.happy.model.RigActivityIndicator
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.ChatPendingSlot
import com.slopus.happy.ui.chat.ChatScreen
import com.slopus.happy.ui.chat.ChatScreenActions
import com.slopus.happy.ui.chat.ChatScreenSlots
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.Rule
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Home's slots on the session screen (SessionView.tsx, Chat audit item 13):
 * - A chat still being started reads "New chat" in the header, shows
 *   PendingChatPlaceholder where the transcript goes (never "deleted"),
 *   and keeps the composer, configured from the chat it was opened beside.
 * - In a checkout, the tab strip sits under the header, which names the
 *   checkout and counts its tabs.
 * - The goal bar sits over the composer, the activity bar right on top of it.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PendingChatScreenTest {
    @get:Rule
    val rule = createComposeRule()

    private val anchor = ChatSessionInfo.from(SessionRecord("a", 0, 0, 1, true, 0, """{"path":"/p","host":"h"}""", 1, null, 1, "", null))
    private val chat = PendingChat(PENDING_CHAT_PREFIX + "1", "a", knownSessionIds = listOf("a"), createdAt = 0)

    @Test
    fun aChatBeingStartedIsANewChatWithAComposer() {
        rule.mainClock.autoAdvance = false
        rule.setHappyContent {
            ChatScreen(
                ChatState(ChatSnapshot(loaded = true), session = null, sessionLoaded = true),
                draft = "",
                bubbleColor = "gray",
                actions = ChatScreenActions(),
                slots = ChatScreenSlots(pending = ChatPendingSlot(anchor) { PendingChatPlaceholder(chat, "/p") }),
            )
        }
        rule.mainClock.advanceTimeBy(200)
        rule.node(HeaderTags.TITLE).assertTextEquals("New chat")
        rule.node(SessionBarTags.PENDING).assertIsDisplayed()
        rule.node(ChatScreenTags.DELETED).assertDoesNotExist()
        rule.node(ComposerTags.INPUT).assertIsDisplayed()
    }

    @Test
    fun theCheckoutsStripAndBarsTakeTheirPlaces() {
        rule.mainClock.autoAdvance = false
        rule.setHappyContent {
            ChatScreen(
                ChatState(ChatSnapshot(loaded = true), session = anchor, sessionLoaded = true, online = true),
                draft = "",
                bubbleColor = "gray",
                actions = ChatScreenActions(),
                slots = ChatScreenSlots(
                    headerAccessory = { Text("strip", Modifier.testTag("strip")) },
                    headerTitle = "feature-x",
                    headerSubtitle = "3 tabs",
                ),
                goalBar = { AgentGoalBar(AgentGoal("claude", "c", "Ship it"), onAction = null, inFlight = null) },
                activityBar = { RigActivityBar(listOf(RigActivityIndicator("subagents", 1))) },
            )
        }
        rule.mainClock.advanceTimeBy(200)
        rule.node(HeaderTags.TITLE).assertTextEquals("feature-x")
        rule.node(HeaderTags.SUBTITLE).assertTextEquals("3 tabs")
        val header = rule.node(HeaderTags.BAR).bounds
        assertTrue("strip under the header", rule.node("strip").bounds.top >= header.bottom)
        val goal = rule.node(SessionBarTags.GOAL).bounds
        val activity = rule.node(SessionBarTags.ACTIVITY).bounds
        val composer = rule.node(ComposerTags.INPUT).bounds
        assertTrue("goal over the activity", goal.bottom <= activity.top)
        assertTrue("activity over the composer", activity.bottom <= composer.top)
        rule.onNodeWithText("Ship it").assertIsDisplayed()
    }
}
