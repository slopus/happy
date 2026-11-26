package com.slopus.happy.ui.conversation

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** A message that couldn't be shown: one muted italic line in its place, with Report bug. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class UndisplayableRowTest {
    @get:Rule val rule = createComposeRule()

    private val row = ConversationRow.Undisplayable("bad1:undisplayable", "bad1", "/content/0/presentation/answers: expected an object, got null")

    private fun show(onReport: ((ConversationRow.Undisplayable) -> Unit)?) = rule.setHappyContent {
        val actions = ConversationRowActions(MessageCallbacks(), onRetryFailure = {}, loadMedia = { ByteArray(0) }, onReportUndisplayable = onReport)
        ConversationRowView(row, userMessageBubblePalette(null, false), actions)
    }

    @Test fun aPlaceholderSaysSoAndReportsItsMessage() {
        val reported = ArrayList<ConversationRow.Undisplayable>()
        show { reported += it }
        rule.onNodeWithText("Hey, this message failed to display.").assertExists()
        // The reason goes in the report, never on screen.
        rule.onNodeWithText(row.problem, substring = true).assertDoesNotExist()
        rule.node(ConversationRowTags.UNDISPLAYABLE_REPORT).performClick()
        assertEquals(listOf(row), reported)
    }

    @Test fun aPlaceholderIsOneLineWithItsButton() {
        show {}
        val box = rule.node(ConversationRowTags.UNDISPLAYABLE).bounds
        assertDp("6, Report bug's 4 + 18 + 4, 6", 6 + 26 + 6, box.bottom - box.top)
        val button = rule.node(ConversationRowTags.UNDISPLAYABLE_REPORT).bounds
        val line = rule.onNodeWithText("Hey, this message failed to display.").bounds
        assertDp("the line 16 in", 16, line.left - box.left)
        assertDp("the button 8 after it", 8, button.left - line.right)
        assertDp("one 18 line", 18, line.bottom - line.top)
    }

    @Test fun withoutAReporterItIsTheLineAlone() {
        show(null)
        rule.onNodeWithText("Hey, this message failed to display.").assertExists()
        rule.node(ConversationRowTags.UNDISPLAYABLE_REPORT).assertDoesNotExist()
    }
}
