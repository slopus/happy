package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.ResumeCommandBlock
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.hasRole
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * SessionView.tsx / AgentContentView's floating dock: on a phone in
 * portrait the transcript runs under the dock with a scrim behind it, and
 * the dock's details fade while reading older messages. Elsewhere the
 * dock sits below the transcript.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatDockLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val info = ChatSessionInfo.from(
        SessionRecord("s", 0, 0, 1, true, 0, """{"path":"/repo","host":"devbox","summary":{"text":"Chat","updatedAt":1}}""", 1, null, 1, "", null),
    )

    private fun rows(count: Int) = (count downTo 1).map { ChatReduction.buildRow(ChatMessage.AgentText("a$it", it.toLong(), "Reply number $it"), true)!! }

    private val hint = InactiveHint(canResume = false, resuming = false, resumeCommand = ResumeCommandBlock(listOf("happy claude --resume abc"), "happy claude --resume abc"))

    private fun show(rowCount: Int = 1, withHint: Boolean = true) = rule.setHappyContent {
        ProvideWindowLayout {
            ChatScreen(
                state = ChatState(ChatSnapshot(rows(rowCount), loaded = true), info, sessionLoaded = true, online = true),
                draft = "",
                bubbleColor = "gray",
                actions = ChatScreenActions(),
                inactiveHint = if (withHint) hint else null,
                goalBar = { Box(Modifier.testTag(GOAL).fillMaxWidth().height(30.dp)) },
                activityBar = { Box(Modifier.testTag(ACTIVITY).fillMaxWidth().height(20.dp)) },
            )
        }
    }

    // Faded-out details are placed far off screen and leave the accessibility tree; showing, they sit inside it.
    private fun shown(tag: String) = rule.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes()
        .any { with(rule.density) { it.boundsInRoot.left.toDp() } > (-1000).dp }

    @Test
    @Config(qualifiers = PHONE)
    fun theTranscriptRunsUnderTheFloatingDock() {
        show()
        val screen = rule.node(ChatScreenTags.SCREEN).bounds
        val list = rule.node(ChatListTags.LIST).bounds
        val dock = rule.node(ChatScreenTags.DOCK).bounds
        val scrim = rule.node(ChatScreenTags.SCRIM).bounds
        assertDp("the list reaches the bottom", screen.bottom, list.bottom)
        assertDp("the dock sits at the bottom", screen.bottom, dock.bottom)
        // Top to bottom: hint, goal bar, (no banner), activity bar, composer.
        val hintBox = rule.node(SessionNoticeTags.INACTIVE).bounds
        val goal = rule.node(GOAL).bounds
        val activity = rule.node(ACTIVITY).bounds
        val composer = rule.node(ComposerTags.COMPOSER).bounds
        assertDp("the hint leads", dock.top, hintBox.top)
        assertDp("goal under the hint", hintBox.bottom, goal.top)
        assertDp("activity under the goal", goal.bottom, activity.top)
        assertDp("composer under the activity bar", activity.bottom, composer.top)
        assertDp("goal bar in the input width", 8, goal.left)
        assertDp("activity bar full width", 0, activity.left)
        // The scrim: 28 above the dock down to the bottom.
        assertDp("scrim top", dock.top - 28.dp, scrim.top)
        assertDp("scrim bottom", screen.bottom, scrim.bottom)
        // The newest row clears the dock: the footer ends 8 above it.
        assertDp("newest clears the dock", dock.top - 8.dp, rule.node(ChatListTags.FOOTER).bounds.bottom)
    }

    @Test
    @Config(qualifiers = PHONE)
    fun readingOlderMessagesFadesTheDetails() {
        show(rowCount = 60)
        listOf(SessionNoticeTags.INACTIVE, GOAL, ACTIVITY, ComposerTags.STATUS_ROW).forEach { assertTrue("$it shows", shown(it)) }
        rule.node(ChatListTags.LIST).performTouchInput { swipeDown(startY = top + 200f, endY = bottom - 200f) }
        rule.waitForIdle()
        listOf(SessionNoticeTags.INACTIVE, GOAL, ACTIVITY, ComposerTags.STATUS_ROW).forEach { assertTrue("$it fades", !shown(it)) }
        // The composer card itself stays.
        assertTrue(rule.node(ComposerTags.PANEL).bounds.left >= 0.dp)
        // The faded rows keep their room: the card doesn't move.
        // TalkBack: the faded rows are gone from the tree, the scroll button is named.
        rule.onAllNodesWithTag(GOAL).assertCountEquals(0)
        rule.node(ChatListTags.SCROLL_BUTTON).assert(hasContentDescription("Scroll to bottom") and hasRole(Role.Button))
        rule.assertActionsLabelled()
        val card = rule.node(ComposerTags.PANEL).bounds
        val button = rule.node(ChatListTags.SCROLL_BUTTON).bounds
        assertDp("scroll button 16 above the card", card.top - 16.dp, button.bottom)
    }

    @Test
    @Config(qualifiers = PHONE)
    fun backAtTheNewestTheDetailsReturn() {
        show(rowCount = 60)
        rule.node(ChatListTags.LIST).performTouchInput { swipeDown(startY = top + 200f, endY = bottom - 200f) }
        rule.waitForIdle()
        assertTrue(!shown(GOAL))
        rule.node(ChatListTags.SCROLL_BUTTON).performTouchInput { down(center); up() }
        rule.waitForIdle()
        assertTrue(shown(GOAL))
        assertTrue(shown(ComposerTags.STATUS_ROW))
    }

    @Test
    @Config(qualifiers = PHONE)
    fun anEmptyChatCentresAboveTheDock() {
        show(rowCount = 0, withHint = false)
        val dock = rule.node(ChatScreenTags.DOCK).bounds
        val empty = rule.node(ChatScreenTags.EMPTY).bounds
        assertTrue("the empty state stays above the dock", empty.bottom <= dock.top)
    }

    @Test
    @Config(qualifiers = "w740dp-h360dp-xxhdpi")
    fun landscapeKeepsTheDockBelowTheTranscript() {
        show(rowCount = 60, withHint = false)
        rule.onAllNodesWithTag(ChatScreenTags.SCRIM, useUnmergedTree = true).assertCountEquals(0)
        val list = rule.node(ChatListTags.LIST).bounds
        val dock = rule.node(ChatScreenTags.DOCK).bounds
        assertDp("the list ends at the dock", dock.top, list.bottom)
        rule.node(ChatListTags.LIST).performTouchInput { swipeDown() }
        rule.waitForIdle()
        assertTrue("nothing fades", shown(GOAL))
    }

    // SessionView `contentRunsUnderHeader`: the header tints surfaceHigh over older rows on a portrait phone only.
    @Test
    @Config(qualifiers = PHONE)
    fun aPortraitHeaderTintsOverOlderRows() {
        show(rowCount = 60, withHint = false)
        assertEquals(Color(0xFFF8F8F8), headerColor())
    }

    @Test
    @Config(qualifiers = "w740dp-h360dp-xxhdpi")
    fun aLandscapeHeaderStaysPlainOverOlderRows() {
        show(rowCount = 60, withHint = false)
        rule.node(ChatListTags.LIST).performTouchInput { swipeDown() }
        rule.waitForIdle()
        assertEquals(Color.White, headerColor())
    }

    private fun headerColor(): Color {
        val pixels = rule.node(HeaderTags.BAR).captureToImage().toPixelMap()
        return pixels[pixels.width / 2, 1]
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun aTabletKeepsTheDockBelowTheTranscript() {
        show()
        rule.onAllNodesWithTag(ChatScreenTags.SCRIM, useUnmergedTree = true).assertCountEquals(0)
        assertDp("the list ends at the dock", rule.node(ChatScreenTags.DOCK).bounds.top, rule.node(ChatListTags.LIST).bounds.bottom)
    }

    private companion object {
        const val GOAL = "test.goal"
        const val ACTIVITY = "test.activity"
    }
}
