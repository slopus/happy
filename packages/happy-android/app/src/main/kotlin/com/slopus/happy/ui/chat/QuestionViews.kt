package com.slopus.happy.ui.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.chat.AgentFormStatus
import com.slopus.happy.chat.AgentQuestionAnswer
import com.slopus.happy.chat.AgentQuestionOption
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.PermissionAnswer
import com.slopus.happy.chat.PermissionDecision
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.selectAgentFormCommunication
import com.slopus.happy.chat.str
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

object QuestionTags {
    const val FORM = "question.form"
    const val QUESTION = "question.question"
    const val HEADER_CHIP = "question.headerChip"
    const val OPTION = "question.option"
    const val SUBMIT = "question.submit"
    const val SUBMITTED = "question.submitted"
    const val BANNER = "question.banner"
    const val BANNER_DISMISS = "question.bannerDismiss"
    const val MODAL = "question.modal"
    const val MODAL_CANCEL = "question.modalCancel"
    const val MODAL_SUBMIT = "question.modalSubmit"
    const val MODAL_CUSTOM = "question.modalCustom"
}

/** InlineQuestionForm.tsx, AgentQuestionBanner.tsx and AgentQuestionModal.tsx; text without a family is the system font. */
object QuestionSpec {
    val formGap = 16.dp
    val questionGap = 8.dp
    val chipPaddingHorizontal = 8.dp
    val chipPaddingVertical = 4.dp
    val chipRadius = 4.dp
    val chipMarginBottom = 4.dp
    val chipText = happyTextStyle(fontSize = 12, weight = FontWeight.SemiBold, family = FontFamily.Default)
    val questionText = happyTextStyle(fontSize = 15, weight = FontWeight.Medium, family = FontFamily.Default)
    val questionMarginBottom = 8.dp
    val optionsGap = 4.dp
    val optionPadding = 12.dp
    val optionRadius = 8.dp
    val optionGap = 10.dp
    val optionMinHeight = 44.dp
    const val DISABLED_OPACITY = 0.6f
    const val PRESSED_OPACITY = 0.7f
    val mark = 20.dp
    val markTop = 2.dp
    val radioDot = 10.dp
    val checkboxRadius = 4.dp
    val checkIcon = 14.dp
    val optionLabel = happyTextStyle(fontSize = 14, weight = FontWeight.Medium, family = FontFamily.Default)
    val optionDescription = happyTextStyle(fontSize = 13, family = FontFamily.Default)
    val optionDescriptionMarginTop = 2.dp
    val submitMarginTop = 8.dp
    val submitPaddingHorizontal = 20.dp
    val submitPaddingVertical = 12.dp
    val submitRadius = 8.dp
    val submitText = happyTextStyle(fontSize = 14, weight = FontWeight.SemiBold, family = FontFamily.Default)
    const val SUBMIT_DISABLED_OPACITY = 0.5f
    val submittedGap = 8.dp
    val submittedHeader = happyTextStyle(fontSize = 13, weight = FontWeight.SemiBold, family = FontFamily.Default)
    val submittedValue = happyTextStyle(fontSize = 13, family = FontFamily.Default)

    val bannerMarginHorizontal = 12.dp
    val bannerMarginBottom = 8.dp
    val bannerPaddingHorizontal = 12.dp
    val bannerPaddingVertical = 10.dp
    val bannerRadius = 14.dp
    val bannerGap = 10.dp
    val bannerIconBox = 24.dp
    val bannerIcon = 20.dp
    val bannerChevron = 18.dp
    val bannerTitle = happyTextStyle(fontSize = 14, weight = FontWeight.SemiBold)
    val bannerSubtitle = happyTextStyle(fontSize = 13)
    val bannerDismiss = happyTextStyle(fontSize = 14, weight = FontWeight.SemiBold)

    val modalHeaderPaddingHorizontal = 16.dp
    val modalHeaderPaddingVertical = 14.dp
    val modalHeaderAction = happyTextStyle(fontSize = 16)
    val modalHeaderTitle = happyTextStyle(fontSize = 16, weight = FontWeight.SemiBold)
    val modalHeaderSpacer = 60.dp
    val modalContentPadding = 16.dp
    val modalQuestionGap = 28.dp
    val modalBlockGap = 8.dp
    val modalChipText = happyTextStyle(fontSize = 12, weight = FontWeight.SemiBold)
    val requiredDot = 6.dp
    val requiredColor = Color(0xFFFF9500)
    val modalQuestion = happyTextStyle(fontSize = 17, weight = FontWeight.SemiBold)
    val modalHint = happyTextStyle(fontSize = 13)
    val modalOptionPadding = 14.dp
    val modalOptionRadius = 12.dp
    val modalOptionGap = 12.dp
    val modalCheckbox = 22.dp
    val modalCheckboxRadius = 6.dp
    val modalOptionLabel = happyTextStyle(fontSize = 15, weight = FontWeight.SemiBold)
    val modalOptionDescription = happyTextStyle(fontSize = 13)
    val modalCustomLabel = happyTextStyle(fontSize = 13, weight = FontWeight.SemiBold)
    val modalCustomInput = happyTextStyle(fontSize = 15)
    val modalCustomMinHeight = 48.dp
    val modalCustomRadius = 12.dp
    val modalError = happyTextStyle(fontSize = 14)
    val modalErrorColor = Color(0xFFFF3B30)
    val modalFooterPaddingTop = 12.dp
    val modalFooterPaddingBottom = 12.dp
    val modalSubmitHeight = 50.dp
    val modalSubmitRadius = 14.dp
    val modalSubmitText = happyTextStyle(fontSize = 16, weight = FontWeight.SemiBold)
    const val MODAL_SUBMIT_DISABLED_OPACITY = 0.4f
    val modalScrollBottom = 96.dp
}

/**
 * AskUserQuestionView.tsx: Claude's questions as the inline form, open
 * while the call runs; the answers go back through the permission as
 * `updatedInput.answers` (question → "a, b"), approved. A completed call
 * shows each header with "—".
 */
@Composable
fun AskUserQuestionView(message: ChatMessage.ToolCallMessage, callbacks: MessageCallbacks) {
    val tool = message.tool
    val raw = tool.input.obj?.get("questions").arr.orEmpty().mapNotNull { it.obj }
    val questions = remember(tool.input) {
        raw.mapIndexed { index, q ->
            InlineQuestion(
                id = "question-$index",
                question = q["question"].str.orEmpty(),
                header = q["header"].str.orEmpty(),
                options = q["options"].arr.orEmpty().mapNotNull { it.obj }.map { o -> AgentQuestionOption(o["label"].str.orEmpty(), o["description"].str) },
                multiSelect = (q["multiSelect"] as? JsonPrimitive)?.content == "true",
                required = true,
            )
        }
    }
    if (questions.isEmpty()) return
    val permissionId = tool.permission?.id
    InlineQuestionForm(
        questions = questions,
        canInteract = tool.state == ToolState.Running,
        submittedAnswers = if (tool.state == ToolState.Completed) emptyMap() else null,
        onSubmit = { answers ->
            if (permissionId == null) return@InlineQuestionForm
            val provider = buildJsonObject {
                questions.forEachIndexed { index, q ->
                    val selected = answers[q.id]
                    val original = raw.getOrNull(index)?.get("question").str
                    if (original != null && !selected.isNullOrEmpty()) put(original, JsonPrimitive(selected.joinToString(", ")))
                }
            }
            callbacks.onPermission(
                PermissionAnswer(permissionId, approved = true, decision = PermissionDecision.Approved, updatedInput = buildJsonObject { put("answers", provider) }),
                null,
            )
        },
    )
}

/**
 * RequestUserInputView.tsx: the agent communication this call raised, as
 * the inline form while pending and its answers once completed (nothing
 * for a cancelled one, and nothing when a question offers no options).
 */
@Composable
fun RequestUserInputView(message: ChatMessage.ToolCallMessage, callbacks: MessageCallbacks) {
    val agentState = LocalToolAgentState.current
    val tool = message.tool
    val communication = remember(agentState, tool.callId) { selectAgentFormCommunication(agentState, tool.callId) } ?: return
    if (communication.questions.any { it.options.isEmpty() }) return
    val submitted: InlineQuestionAnswers? = when {
        communication.status == AgentFormStatus.Pending -> null
        communication.status == AgentFormStatus.Cancelled || communication.answers == null -> emptyMap()
        else -> communication.answers.mapValues { (_, a) -> a.options + listOfNotNull(a.custom?.ifEmpty { null }) }
    }
    InlineQuestionForm(
        questions = communication.questions.map { InlineQuestion(it.id, it.question, it.header, it.options, it.multiSelect, it.required) },
        canInteract = tool.state == ToolState.Running && communication.status == AgentFormStatus.Pending,
        submittedAnswers = submitted,
        onSubmit = { answers ->
            if (communication.status != AgentFormStatus.Pending) return@InlineQuestionForm
            val out = LinkedHashMap<String, AgentQuestionAnswer>()
            for (q in communication.questions) {
                val selected = answers[q.id]
                if (selected.isNullOrEmpty()) continue
                out[q.id] = AgentQuestionAnswer(if (q.multiSelect) selected else selected.take(1))
            }
            callbacks.onAnswerQuestion(communication.id, out, "form")
        },
    )
}
