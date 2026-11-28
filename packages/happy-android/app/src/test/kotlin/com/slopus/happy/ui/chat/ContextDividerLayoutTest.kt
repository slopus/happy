package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.AgentEvent
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.Locale

/**
 * The context divider a /clear or /compact leaves (ContextDividerSpec): the
 * column's full width, 16 in from both sides, 8 above and below; a hairline
 * line each side, 8 clear of the 13/18 label in the event grey, all centred.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ContextDividerLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val gray = userMessageBubblePalette("gray", dark = false)
    private val at = 1_700_000_000_000L
    private var hairline = 0.dp
    private var locale = Locale.getDefault()

    private fun show(event: AgentEvent, dark: Boolean = false) {
        rule.setHappyContent(dark = dark) {
            hairline = with(LocalDensity.current) { 1f.toDp() }
            locale = LocalConfiguration.current.locales[0]
            Column(Modifier.fillMaxWidth()) { MessageView(ChatRow.Event(ChatMessage.Event("e", at, event)), gray, MessageCallbacks()) }
        }
    }

    @Test
    fun clearedDrawsTheDivider() {
        show(AgentEvent.Message("Context was reset"))
        val time = formatBoundaryTime(at, locale)
        val divider = rule.node(MessageTags.CONTEXT_DIVIDER).bounds
        assertDp("the row's top", 0, divider.top)
        assertDp("16 side margins", (PHONE_WIDTH - 32).dp, divider.right - divider.left)
        val label = rule.node(MessageTags.CONTEXT_DIVIDER_LABEL).bounds
        assertDp("an 18 line", 18, label.bottom - label.top)
        assertDp("8 above and below the label", (label.bottom - label.top) + 16.dp, divider.bottom - divider.top)
        assertDp("label centred", (PHONE_WIDTH / 2f).dp, (label.left + label.right) / 2)
        assertDp("8 from the row's top", 8, label.top - divider.top)
        // The lines end 8 clear of the label, one pixel high, on its middle.
        val start = rule.node(MessageTags.CONTEXT_DIVIDER_LINE_START).bounds
        val end = rule.node(MessageTags.CONTEXT_DIVIDER_LINE_END).bounds
        assertDp("start line at the row's start", 16, start.left)
        assertDp("8 before the label", 8, label.left - start.right)
        assertDp("8 after the label", 8, end.left - label.right)
        assertDp("end line at the row's end", (PHONE_WIDTH - 16).dp, end.right)
        assertDp("one pixel high", hairline, start.bottom - start.top)
        assertDp("on the label's middle", (label.top + label.bottom) / 2, (start.top + start.bottom) / 2)
        assertTrue("lines share the row", (start.right - start.left) > 0.dp && (end.right - end.left) > 0.dp)
        rule.onNodeWithText("Context cleared · $time", useUnmergedTree = true).assertExists()
        rule.node(MessageTags.CONTEXT_DIVIDER).assert(hasContentDescription("Context cleared at $time"))
    }

    @Test
    fun compactedSaysItsOwnWords() {
        show(AgentEvent.Message("Compaction completed"), dark = true)
        val time = formatBoundaryTime(at, locale)
        rule.onNodeWithText("Context compacted · $time", useUnmergedTree = true).assertExists()
        rule.node(MessageTags.CONTEXT_DIVIDER).assert(hasContentDescription("Context compacted at $time"))
        val divider = rule.node(MessageTags.CONTEXT_DIVIDER).bounds
        assertDp("dark draws the same row", (PHONE_WIDTH - 32).dp, divider.right - divider.left)
    }

    @Test
    fun otherEventsKeepTheirCentredLine() {
        show(AgentEvent.Message("Compaction started"))
        rule.onNodeWithText("Compaction started").assertExists()
        rule.onNodeWithText("Context compacted · ${formatBoundaryTime(at, locale)}").assertDoesNotExist()
    }
}
