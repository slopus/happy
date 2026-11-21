package com.slopus.happy.ui.conversation

import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.conversation.Problem
import com.slopus.happy.conversation.SideAnswer
import com.slopus.happy.conversation.SideExchange
import com.slopus.happy.conversation.SideThread
import com.slopus.happy.conversation.SlashCommand

/** A Claude Code chat that can ask side questions, and threads in each state the panel draws. */
internal object SideQuestionFixtures {
    val agent = AgentInfo("a1", "w1", null, "Fix the upload retries", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)

    /** A model whose definition answers side questions. */
    val claude = Mode("claude", "claude-code/opus", "high", null, "auto")

    /** One whose definition doesn't. */
    val codex = Mode("codex", "openai/gpt-5.6-sol", "medium", null, "auto")

    val catalog = ModeCatalog(
        listOf(
            ModelChoice("claude", "Claude", "claude", "claude-code/opus", "Opus", listOf("low", "medium", "high"), "high", emptyList()),
            ModelChoice("codex", "Codex", "codex", "openai/gpt-5.6-sol", "GPT-5.6 Sol", listOf("low", "medium", "high"), "medium", emptyList()),
        ),
        claude,
        sideQuestions = setOf("claude-code/opus"),
    )

    val ANSWER = """
        The retry loop lives in `uploader.ts`:

        - `retryUpload` backs off from 1 s to 30 s
        - a 4xx stops it at once

        ```ts
        await retryUpload(file, { attempts: 5 })
        ```
    """.trimIndent()

    /** Threads this many exchanges long run past the panel's cap. */
    const val LONG = 6

    private val transcript = run {
        val builder = ConversationRowBuilder { 1_000_000L }
        listOf(
            Message("m1", "user", 1, listOf(Block.Text("Uploads fail on flaky Wi-Fi. Make them retry."))),
            Message("m2", "agent", 2, listOf(Block.Text("I'll add a retry loop with backoff to the uploader, then cover it with tests."))),
            Message("m3", "user", 3, listOf(Block.Text("Keep 4xx answers out of it."))),
            Message("m4", "agent", 4, listOf(Block.Text("Understood: only network errors and 5xx answers are retried. Writing the tests now."))),
        ).flatMap { builder.rows(it, "a1", null, false) }.asReversed()
    }

    fun conversation(mode: Mode = claude, created: Boolean = true, commands: List<SlashCommand> = emptyList()) =
        if (created) {
            ConversationState(created = true, loaded = true, rows = transcript, agent = agent, mode = mode, catalog = catalog, commands = commands)
        } else {
            ConversationState(loaded = true, mode = mode, catalog = catalog, newWork = com.slopus.happy.conversation.NewWork(com.slopus.happy.conversation.WorkChoice()))
        }

    fun answered(question: String = "Which file handles the retries?", response: String = ANSWER) =
        SideExchange(question, SideAnswer.Answered(response, synthetic = false, blocks = parseMarkdown(response)))

    fun long() = SideThread((1..LONG).map { answered("Question $it: where does the retry loop stop?") })

    /** Every state an answer can be in but answered. */
    fun states() = SideThread(
        listOf(
            SideExchange("What did you change last?", SideAnswer.Answered(null, synthetic = false)),
            SideExchange("Which file?", SideAnswer.Notice(Problem.SideQuestionUnready)),
            SideExchange("Can you answer this?", SideAnswer.Notice(Problem.SideQuestionUnsupported)),
            SideExchange("Still there?", SideAnswer.Notice(Problem.SideQuestionGone)),
            SideExchange("Are you reachable?", SideAnswer.Notice(Problem.Link(AgentConnectionException.Reason.Unavailable))),
            SideExchange("How long will it take?", SideAnswer.Failed(Problem.Said("Rate limited."))),
            SideExchange("Which test fails?", SideAnswer.Asking),
            SideExchange("And why?", SideAnswer.Queued),
        ),
    )

    /** A thread being answered: the first answered, the next on its way, a follow-up waiting its turn. */
    fun queued() = SideThread(
        listOf(
            answered(response = "`uploader.ts`, in `retryUpload`."),
            SideExchange("Does it stop on a 4xx?", SideAnswer.Asking),
            SideExchange("And after how many tries?", SideAnswer.Queued),
        ),
    )
}
