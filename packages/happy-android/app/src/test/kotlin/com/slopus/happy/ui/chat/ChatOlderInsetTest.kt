package com.slopus.happy.ui.chat

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * SessionView's `chatListTopContentInset` and OlderEnd's default: beyond
 * the oldest row's 32 slot, nothing on a phone in portrait (the 52 + 12
 * inset ends where the 64 header does), 12 in landscape, and on a tablet
 * the 64 header, the status bar and 32.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatOlderInsetTest {
    @get:Rule
    val rule = createComposeRule()

    private val info = ChatSessionInfo.from(
        SessionRecord("s", 0, 0, 1, true, 0, """{"path":"/repo","host":"devbox","summary":{"text":"Chat","updatedAt":1}}""", 1, null, 1, "", null),
    )

    private fun show() = rule.setHappyContent {
        ProvideWindowLayout {
            ChatScreen(
                state = ChatState(ChatSnapshot(listOf(ChatReduction.buildRow(ChatMessage.AgentText("a", 1, "Reply"), true)!!), loaded = true), info, sessionLoaded = true, online = true),
                draft = "",
                bubbleColor = "gray",
                actions = ChatScreenActions(),
            )
        }
    }

    @Test
    @Config(qualifiers = "w411dp-h891dp-xxhdpi")
    fun phonePortraitHasNoSpacer() {
        show()
        rule.onAllNodesWithTag(ChatListTags.OLDER_INSET, useUnmergedTree = true).assertCountEquals(0)
        assertDp("the slot is 32", 32, rule.node(ChatListTags.OLDER_END).bounds.let { it.bottom - it.top })
    }

    @Test
    @Config(qualifiers = "w740dp-h360dp-xxhdpi")
    fun phoneLandscapeKeeps12() {
        show()
        assertDp("12 beyond the slot", 12, rule.node(ChatListTags.OLDER_INSET).bounds.let { it.bottom - it.top })
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun tabletLeavesTheHeaderTheStatusBarAnd32() {
        show()
        val inset = rule.node(ChatListTags.OLDER_INSET).bounds
        // Robolectric draws no status bar, so it is the 64 header and 32.
        assertDp("64 + 32", 96, inset.bottom - inset.top)
        assertDp("the slot under the spacer", inset.bottom, rule.node(ChatListTags.OLDER_END).bounds.top)
    }
}
