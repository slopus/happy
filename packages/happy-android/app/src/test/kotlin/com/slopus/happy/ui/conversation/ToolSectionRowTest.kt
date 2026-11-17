package com.slopus.happy.ui.conversation

import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.Presentation
import com.slopus.happy.conversation.Question
import com.slopus.happy.conversation.AskPhase
import com.slopus.happy.conversation.ToolUse
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.MessageCallbacks
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
 * A tool section's line ([ToolSectionRow], desktop's `AgentToolSection`):
 * [ToolLine]'s 32 whether it shows a running call, an ended run's summary
 * or a run of one call, so nothing around it moves as it changes. Narrow,
 * the summary's kinds give way and its duration stays whole. An answered
 * question's line ([AnsweredLine]) is the same 32.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ToolSectionRowTest {
    @get:Rule
    val rule = createComposeRule()

    private val actions = ConversationRowActions(MessageCallbacks(), onRetryFailure = {}, loadMedia = { ByteArray(0) })
    private val read = ToolUse("Read", "completed", Presentation.Exploration(listOf(Presentation.Exploration.Operation("read", "LoginTest.kt", null, null, null, null))), id = "t1")
    private val shell = ToolUse("Bash", "running", Presentation.Command("./gradlew test", null), id = "t2")

    @Test fun theLineIsOneHeightLiveEndedAndAlone() {
        var row by mutableStateOf(ConversationRow.Section("m1:0", listOf(read, shell), live = true, durationMs = null))
        rule.setHappyContent { ToolSectionRow(row, actions) }
        fun height() = rule.node(ToolSectionTags.SECTION).bounds.let { it.bottom - it.top }
        assertDp("live", 32.dp, height())
        row = row.copy(calls = listOf(read, shell.copy(status = "completed")), live = false, durationMs = 192_000)
        rule.waitForIdle()
        assertDp("summed up", 32.dp, height())
        assertEquals("Explore · Bash · 3m\u00a012s", rule.node(ToolSectionTags.SUMMARY).fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.ContentDescription].single())
        row = ConversationRow.Section("m2:0", listOf(shell), live = false, durationMs = 5_000)
        rule.waitForIdle()
        assertDp("one call", 32.dp, height())
    }

    @Test fun aNarrowSummaryKeepsItsDuration() {
        val kinds = (1..6).map { ToolUse("tool_number_$it", "completed", id = "t$it") }
        rule.setHappyContent { ToolSectionRow(ConversationRow.Section("m1:0", kinds, live = false, durationMs = 75_000), actions, Modifier.width(180.dp)) }
        val duration = rule.node(ToolSectionTags.DURATION).bounds
        val summary = rule.node(ToolSectionTags.SUMMARY).bounds
        assertTrue("duration $duration inside summary $summary", duration.right <= summary.right - 16.dp + 0.5.dp)
        assertTrue("duration $duration whole", duration.right - duration.left > 40.dp)
    }

    @Test fun anAnsweredQuestionIsOneLine() {
        val question = Question("q1", "answered", null, listOf(Question.Prompt("ci", "CI retries", "Retry?", false, listOf(Question.Option("No", null)), null)), null, false, mapOf("ci" to listOf("No")))
        rule.setHappyContent { AnsweredLine(ConversationRow.Ask("ask:q1", question, AskPhase.Answered, line = true)) }
        rule.node(ToolSectionTags.ANSWERED).bounds.let { assertDp("answered", 32.dp, it.bottom - it.top) }
    }
}
