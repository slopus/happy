package com.slopus.happy.chat

import androidx.compose.runtime.Immutable

// Agent-to-user communications (sync/agentCommunications.ts). A permission
// gates an action the agent wants to take; a communication asks the user for
// information the agent does not have. Today the only kind is `form`.

/** A communication the agent is waiting on. */
@Immutable
sealed interface PendingAgentCommunication {
    val id: String
    val createdAt: Long
    val toolUseId: String?

    data class Form(
        override val id: String,
        override val createdAt: Long,
        override val toolUseId: String?,
        val questions: List<AgentQuestion>,
    ) : PendingAgentCommunication

    /** A kind this build cannot render: still shown so the user can dismiss it. */
    data class Unsupported(
        override val id: String,
        override val createdAt: Long,
        override val toolUseId: String?,
        val rawKind: String,
        val title: String?,
    ) : PendingAgentCommunication
}

enum class AgentFormStatus { Pending, Answered, Cancelled }

/** A form joined to its transcript tool call, with its answers once completed. */
@Immutable
data class AgentFormCommunication(
    val id: String,
    val createdAt: Long,
    val toolUseId: String?,
    val questions: List<AgentQuestion>,
    val status: AgentFormStatus,
    val answers: Map<String, AgentQuestionAnswer>? = null,
)

/** A draft answer while the user fills the form in. */
@Immutable
data class AgentQuestionDraft(val options: List<String> = emptyList(), val custom: String = "") {
    companion object {
        val EMPTY = AgentQuestionDraft()
    }
}

/** A question is answerable if it offers options or accepts written text. */
private fun AgentCommunication.answerableQuestions(): List<AgentQuestion> =
    questions.orEmpty().filter { it.options.isNotEmpty() || it.allowCustom != false }

/**
 * The communications the agent is waiting on, oldest first. An unknown kind
 * comes back as [PendingAgentCommunication.Unsupported]; a form with nothing
 * answerable is dropped.
 */
fun selectPendingCommunications(state: AgentState?): List<PendingAgentCommunication> {
    state ?: return emptyList()
    val pending = ArrayList<PendingAgentCommunication>()
    for ((id, communication) in state.communications) {
        if (id in state.completedCommunications) continue
        val createdAt = communication.createdAt ?: 0
        val toolUseId = communication.toolUseId?.takeIf { it.isNotEmpty() }
        if (communication.kind != "form") {
            pending.add(PendingAgentCommunication.Unsupported(id, createdAt, toolUseId, communication.kind, communication.title))
            continue
        }
        val questions = communication.answerableQuestions()
        if (questions.isEmpty()) continue
        pending.add(PendingAgentCommunication.Form(id, createdAt, toolUseId, questions))
    }
    return pending.sortedBy { it.createdAt }
}

/**
 * The form raised by one tool call. A completed form wins over a pending
 * snapshot so the transcript shows the answer at once.
 */
fun selectAgentFormCommunication(state: AgentState?, toolUseId: String?): AgentFormCommunication? {
    if (state == null || toolUseId.isNullOrEmpty()) return null
    for ((id, completed) in state.completedCommunications) {
        val communication = completed.communication
        if ((communication.toolUseId ?: id) != toolUseId || communication.kind != "form") continue
        val questions = communication.answerableQuestions()
        if (questions.isEmpty()) return null
        return AgentFormCommunication(
            id = id,
            createdAt = communication.createdAt ?: 0,
            toolUseId = communication.toolUseId?.takeIf { it.isNotEmpty() },
            questions = questions,
            status = if (completed.answered) AgentFormStatus.Answered else AgentFormStatus.Cancelled,
            answers = completed.answers,
        )
    }
    for ((id, communication) in state.communications) {
        if (id in state.completedCommunications) continue
        if ((communication.toolUseId ?: id) != toolUseId || communication.kind != "form") continue
        val questions = communication.answerableQuestions()
        if (questions.isEmpty()) return null
        return AgentFormCommunication(
            id = id,
            createdAt = communication.createdAt ?: 0,
            toolUseId = communication.toolUseId?.takeIf { it.isNotEmpty() },
            questions = questions,
            status = AgentFormStatus.Pending,
        )
    }
    return null
}

/** Choice forms can live in the chat; text-only forms keep the modal. */
fun canRenderAgentFormInline(communication: PendingAgentCommunication): Boolean =
    communication is PendingAgentCommunication.Form &&
        communication.questions.isNotEmpty() &&
        communication.questions.all { it.options.isNotEmpty() }

/**
 * The banner and modal own only the requests the transcript card cannot show,
 * regardless of whether the tool message has arrived, so the two never race.
 */
fun shouldUseAgentQuestionFallback(communication: PendingAgentCommunication): Boolean =
    !canRenderAgentFormInline(communication)

/**
 * A tap on an option: single-select replaces (or clears) the choice,
 * multi-select toggles it.
 */
fun toggleOption(draft: AgentQuestionDraft, label: String, multiSelect: Boolean): AgentQuestionDraft {
    if (!multiSelect) {
        return draft.copy(options = if (label in draft.options) emptyList() else listOf(label))
    }
    return draft.copy(options = if (label in draft.options) draft.options - label else draft.options + label)
}

fun isQuestionAnswered(question: AgentQuestion, draft: AgentQuestionDraft?): Boolean {
    if (question.required == false) return true
    draft ?: return false
    return draft.options.isNotEmpty() || draft.custom.isNotBlank()
}

fun canSubmit(questions: List<AgentQuestion>, drafts: Map<String, AgentQuestionDraft>): Boolean =
    questions.all { isQuestionAnswered(it, drafts[it.id]) }

/**
 * The answer payload sent back to the agent. Custom text keeps its own field;
 * blank drafts are left out rather than sent empty.
 */
fun buildAnswers(questions: List<AgentQuestion>, drafts: Map<String, AgentQuestionDraft>): Map<String, AgentQuestionAnswer> {
    val answers = LinkedHashMap<String, AgentQuestionAnswer>()
    for (question in questions) {
        val draft = drafts[question.id] ?: continue
        val custom = draft.custom.trim()
        val options = if (question.multiSelect) draft.options else draft.options.take(1)
        if (options.isEmpty() && custom.isEmpty()) continue
        answers[question.id] = AgentQuestionAnswer(options, custom.ifEmpty { null })
    }
    return answers
}

/** One-line summary of an answer, for the collapsed card. */
fun describeAnswer(answer: AgentQuestionAnswer?): String {
    answer ?: return "—"
    val parts = answer.options + listOfNotNull(answer.custom?.takeIf { it.isNotEmpty() })
    return if (parts.isNotEmpty()) parts.joinToString(", ") else "—"
}
