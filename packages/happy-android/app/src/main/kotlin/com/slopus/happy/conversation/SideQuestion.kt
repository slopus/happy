package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonObject

/**
 * Claude Code's `/btw` in a Happy Agent chat (happy-agent API.md "Side
 * questions"): a question about the chat that the harness answers once,
 * from the conversation, without adding the question or the answer to it.
 * Wherever the computer serves side questions, `/btw` is taken as one and
 * never sent as a message; where it serves none, `/btw` is what it was.
 */
object SideQuestion {
    /** The command's name, without its slash. */
    const val COMMAND = "btw"

    private val command = Regex("^/btw(?:\\s+([\\s\\S]*))?$")

    /**
     * The question a submitted [text] asks: `/btw what changed?` is
     * "what changed?", a bare `/btw` is "" (only its usage is shown), and
     * anything else is null (sideQuestion.ts `parseSideQuestionCommand`).
     */
    fun question(text: String): String? = command.matchEntire(text.trim())?.groupValues?.get(1)?.trim()

    /**
     * Whether a chat's "/" list offers `/btw`: its computer serves side
     * questions (health's `capabilities.sideQuestions`, [served]) and the
     * model they are answered with, [mode], answers them (its definition's
     * `sideQuestions`, [ModeCatalog.sideQuestions]). That is the agent's own
     * mode (API.md `GET …/mode`), or before its first message the composer's.
     * Never read from a model's id or its provider: a route and the flag
     * that advertises it ship together.
     */
    fun offered(served: Boolean, catalog: ModeCatalog?, mode: Mode?): Boolean =
        served && mode != null && catalog?.answersSideQuestions(mode.modelId) == true

    /** The composer's list where `/btw` is [offered]: [btw] first, then the agent's own commands, none of them shadowing it. */
    fun commands(agent: List<SlashCommand>, btw: SlashCommand): List<SlashCommand> = listOf(btw) + agent.filter { it.name != COMMAND }
}

/** One earlier exchange of a side thread, sent as `history` with the next question so a follow-up has its context. */
data class SideTurn(val question: String, val response: String)

/** What `POST` or `GET …/side-questions` answered: still answering, answered, or no answer and why. */
sealed interface SideReply {
    /** Names the question until its answer is collected. */
    val id: String

    data class Answering(override val id: String) : SideReply

    /** [response] is Markdown, null when the harness produced none; [synthetic], a canned reply for one the model could not give. */
    data class Answered(override val id: String, val response: String?, val synthetic: Boolean) : SideReply

    /** The harness gave no answer; [error] says why, in English, as the daemon wrote it. */
    data class Failed(override val id: String, val error: String) : SideReply

    companion object {
        /** `{"sideQuestion": {…}}`; null for any other shape. */
        fun parse(answer: JsonObject): SideReply? {
            val o = answer["sideQuestion"].obj ?: return null
            val id = o["id"].str?.takeIf { it.isNotEmpty() } ?: return null
            return when (o["status"].str) {
                "answering" -> Answering(id)
                "answered" -> Answered(id, o["response"].str, o["synthetic"].bool == true)
                "failed" -> Failed(id, o["error"].str.orEmpty())
                else -> null
            }
        }
    }
}

/** Where one side question's answer stands, as the panel draws it. */
@Immutable
sealed interface SideAnswer {
    /** Waits for the answer to the question before it. */
    data object Queued : SideAnswer

    data object Asking : SideAnswer

    /** [blocks] are [response] parsed, off the main thread; [synthetic] is shown as said, never copied and never sent back as history. */
    data class Answered(val response: String?, val synthetic: Boolean, val blocks: List<MarkdownBlock> = emptyList()) : SideAnswer

    /** No answer, for a reason the person can act on (nothing to answer from yet, offline): said plainly. */
    data class Notice(val problem: Problem) : SideAnswer

    /** No answer: "Couldn't get an answer:" and why. */
    data class Failed(val reason: Problem) : SideAnswer
}

@Immutable
data class SideExchange(val question: String, val answer: SideAnswer)

/** One chat's side thread: its questions, oldest first, and the follow-up being typed, kept so leaving the chat keeps it. */
@Immutable
data class SideThread(val exchanges: List<SideExchange> = emptyList(), val draft: String = "")
