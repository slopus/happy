package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.Problem
import com.slopus.happy.conversation.SideAnswer
import com.slopus.happy.conversation.SideExchange
import com.slopus.happy.conversation.SideThread
import com.slopus.happy.conversation.SlashCommand
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.autocomplete.AutocompleteTags
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * The `/btw` side panel over a Claude Code chat on a phone, in each state it
 * draws, written only when HAPPY_SHOTS_DIR is set: answering; answered in
 * Markdown with its copy button (light and dark); a follow-up waiting its
 * turn; a notice; a failure; a long thread at its cap; a bare `/btw`'s
 * usage line; and the "/" list offering `/btw`.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SideQuestionShots {
    @get:Rule val rule = createComposeRule()
    private val dir = System.getenv("HAPPY_SHOTS_DIR")?.let(::File)

    private fun show(thread: SideThread?, dark: Boolean = false) {
        assumeTrue(dir != null)
        rule.setHappyContent(dark) {
            ProvideWindowLayout {
                ConversationScreen(
                    SideQuestionFixtures.conversation(commands = listOf(SlashCommand("compact", false, "Summarize older messages to free context space.", SlashCommand.COMPACTION))),
                    ConversationScreenActions(onSend = { _, _ -> true }, sideQuestions = SideQuestionActions(served = { true })),
                    sideThread = thread,
                )
            }
        }
        rule.waitForIdle()
    }

    private fun shot(name: String) {
        dir!!.mkdirs()
        val page = rule.onAllNodes(isRoot())[0].captureToImage().asAndroidBitmap()
        File(dir, "$name.png").outputStream().use { page.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun thread(vararg exchanges: SideExchange) = SideThread(exchanges.toList())

    @Test fun answering() {
        show(thread(SideExchange("Which file handles the retries?", SideAnswer.Asking)))
        shot("side-question-answering-light")
    }

    @Test fun answeredLight() {
        show(thread(SideQuestionFixtures.answered()))
        shot("side-question-answered-light")
    }

    @Test fun answeredDark() {
        show(thread(SideQuestionFixtures.answered()), dark = true)
        shot("side-question-answered-dark")
    }

    @Test fun queuedFollowUp() {
        show(SideQuestionFixtures.queued())
        shot("side-question-queued-light")
    }

    @Test fun notice() {
        show(thread(SideExchange("What are you working on?", SideAnswer.Notice(Problem.SideQuestionUnready))))
        shot("side-question-notice-light")
    }

    @Test fun failure() {
        show(thread(SideQuestionFixtures.answered(), SideExchange("And after how many tries?", SideAnswer.Failed(Problem.Said("Rate limited.")))))
        shot("side-question-failure-light")
    }

    @Test fun longThread() {
        show(SideQuestionFixtures.long())
        shot("side-question-long-light")
    }

    @Test fun usageLine() {
        show(null)
        rule.node(ConversationComposerTags.INPUT).performTextInput("/btw")
        rule.node(ConversationComposerTags.PRIMARY).performClick()
        rule.waitForIdle()
        shot("side-question-usage-light")
    }

    @Test fun commandList() {
        show(null)
        rule.node(ConversationComposerTags.INPUT).performTextInput("/")
        rule.waitUntil(5_000) { rule.onAllNodesWithTag(AutocompleteTags.ROW, useUnmergedTree = true).fetchSemanticsNodes().size == 2 }
        rule.waitForIdle()
        shot("side-question-command-list-light")
    }
}
