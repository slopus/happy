package com.slopus.happy.ui.conversation

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.pipelines.PipelineRunNotice
import com.slopus.happy.pipelines.PipelineRunState
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

/** What an agent sent itself: a quiet line that opens to its words, or a pipeline run's result as a card that opens the run. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class SelfNoteRowTest {
    @get:Rule val rule = createComposeRule()

    private val failed = PipelineRunNotice("r1", "p1", "Deploy production", 3, PipelineRunState.Failed, "build: exception")

    private fun show(vararg rows: ConversationRow, onOpen: ((PipelineRunNotice) -> Unit)? = null) = rule.setHappyContent {
        val actions = ConversationRowActions(legacy = MessageCallbacks(), onRetryFailure = {}, loadMedia = { ByteArray(0) }, onOpenPipelineRun = onOpen)
        Column { rows.forEach { ConversationRowView(it, userMessageBubblePalette(null, false), actions) } }
    }

    @Test fun aSelfMessageIsALineThatOpensToItsWords() {
        show(
            ConversationRow.SelfNote("s1", "m1", null, "Continue working toward your goal: ship main.", null),
            ConversationRow.SelfNote("s2", "m2", "Pipeline Nightly backup failed", "Pipeline Nightly backup run r9 ended: failed.", null),
        )
        rule.onNodeWithText("Message to itself").assertExists()
        rule.onNodeWithText("Continue working toward your goal: ship main.").assertDoesNotExist()
        rule.onNodeWithText("Message to itself").performClick()
        rule.onNodeWithText("Continue working toward your goal: ship main.").assertExists()
        rule.onNodeWithText("Message to itself").performClick()
        rule.onNodeWithText("Continue working toward your goal: ship main.").assertDoesNotExist()
        // Its explanation is the label: the sentence itself is never read for more.
        rule.onNodeWithText("Pipeline Nightly backup failed").assertExists()
        rule.onNodeWithText("Pipeline Nightly backup run r9 ended: failed.").assertDoesNotExist()
    }

    @Test fun aRunsResultSaysHowItEndedAndOpensTheRun() {
        val opened = ArrayList<String>()
        show(
            ConversationRow.SelfNote("s1", "m1", "Pipeline Deploy production failed", "…", failed),
            ConversationRow.SelfNote("s2", "m2", "Pipeline Incoming email succeeded", "…", PipelineRunNotice("r2", "p2", "Incoming email", 12, PipelineRunState.Succeeded, null)),
            onOpen = { opened += it.runId },
        )
        rule.onNodeWithText("Deploy production").assertExists()
        rule.onNodeWithText("v3 · Failed").assertExists()
        rule.onNodeWithText("build: exception").assertExists()
        rule.onNodeWithText("v12 · Succeeded").assertExists()
        rule.onNodeWithText("Pipeline Deploy production failed").assertDoesNotExist()
        rule.onNodeWithText("Incoming email").performClick()
        rule.onNodeWithText("Deploy production").performClick()
        assertEquals(listOf("r2", "r1"), opened)
    }

    @Test fun aRunsResultIsAnArtifactCardsSize() {
        show(ConversationRow.SelfNote("s1", "m1", null, "", failed.copy(summary = null)), onOpen = {})
        val card = rule.node(SelfNoteTags.PIPELINE).bounds
        assertDp("12, the name 18 over how it ended 18, 12", 12 + 18 + 18 + 12, card.bottom - card.top)
        assertDp("16 in from the column", 16, card.left)
    }

    @Test fun withNothingToOpenItIsOnlyRead() {
        show(ConversationRow.SelfNote("s1", "m1", null, "", failed))
        rule.onNodeWithTag(SelfNoteTags.PIPELINE).assert(hasClickAction().not())
        rule.onNodeWithTag(SelfNoteTags.PIPELINE_SUMMARY, useUnmergedTree = true).assertTextEquals("build: exception")
    }
}
