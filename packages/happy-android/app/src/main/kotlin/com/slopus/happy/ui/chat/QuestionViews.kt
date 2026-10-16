package com.slopus.happy.ui.chat

import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.slopus.happy.R
import com.slopus.happy.chat.AgentFormStatus
import com.slopus.happy.chat.AgentQuestion
import com.slopus.happy.chat.AgentQuestionAnswer
import com.slopus.happy.chat.AgentQuestionDraft
import com.slopus.happy.chat.AgentQuestionOption
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.PendingAgentCommunication
import com.slopus.happy.chat.PermissionAnswer
import com.slopus.happy.chat.PermissionDecision
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.buildAnswers
import com.slopus.happy.chat.canSubmit
import com.slopus.happy.chat.isQuestionAnswered
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.selectAgentFormCommunication
import com.slopus.happy.chat.shouldUseAgentQuestionFallback
import com.slopus.happy.chat.str
import com.slopus.happy.chat.toggleOption
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
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

/** One question of [InlineQuestionForm]. */
data class InlineQuestion(
    val id: String,
    val question: String,
    val header: String,
    val options: List<AgentQuestionOption>,
    val multiSelect: Boolean = false,
    val required: Boolean? = null,
)

/** Selected option labels by question id. */
typealias InlineQuestionAnswers = Map<String, List<String>>

/**
 * InlineQuestionForm.tsx, the choice form AskUserQuestion and
 * request_user_input share, in a tool section: questions 16 apart, each a
 * header chip (surfaceHighest, padding 8/4, radius 4, 4 below; 12 semibold
 * textSecondary uppercase), the question (15 weight 500, 8 below), and its
 * options 4 apart. An option: padding 12, radius 8, surface fill, 1 divider
 * border, at least 44 high, 10 apart a 20 mark (radio: 2 ring, 10 dot; or a
 * radius-4 checkbox with a 14 white checkmark, both radio-blue when chosen,
 * 2 down) and the label (14 weight 500) over its description (13
 * textSecondary, 2 down). Chosen: surfaceHighest with a radio-blue border.
 * Without interaction options fade to 0.6. Submit sits right, 8 down:
 * padding 20/12, radius 8, surfaceHighest, 1 divider border (radio-blue
 * once every required question has an answer), 14 semibold, 0.5 until then,
 * a spinner while sending. Once sent the form becomes "Header: answers"
 * lines, 8 apart (13 semibold textSecondary, 13 text; "—" for none).
 */
@Composable
fun InlineQuestionForm(
    questions: List<InlineQuestion>,
    canInteract: Boolean,
    submittedAnswers: InlineQuestionAnswers?,
    onSubmit: suspend (InlineQuestionAnswers) -> Unit,
    modifier: Modifier = Modifier,
) {
    val key = questions.joinToString("\u0000") { it.id }
    var selections by remember(key) { mutableStateOf<Map<String, Set<Int>>>(emptyMap()) }
    var submitting by remember(key) { mutableStateOf(false) }
    var localAnswers by remember(key) { mutableStateOf<InlineQuestionAnswers?>(null) }
    val scope = rememberCoroutineScope()
    val submitted = submittedAnswers ?: localAnswers
    val interactive = canInteract && submitted == null
    val allAnswered = questions.all { it.required == false || (selections[it.id]?.size ?: 0) > 0 }
    val colors = HappyTheme.colors

    ToolSection {
        if (submitted != null) {
            Column(modifier = modifier.testTag(QuestionTags.SUBMITTED), verticalArrangement = Arrangement.spacedBy(QuestionSpec.submittedGap)) {
                for (question in questions) {
                    Row(horizontalArrangement = Arrangement.spacedBy(QuestionSpec.submittedGap)) {
                        Text("${question.header}:", style = QuestionSpec.submittedHeader, color = colors.textSecondary)
                        Text(
                            submitted[question.id]?.joinToString(", ")?.ifEmpty { null } ?: "—",
                            style = QuestionSpec.submittedValue,
                            color = colors.text,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
            return@ToolSection
        }
        Column(modifier = modifier.testTag(QuestionTags.FORM), verticalArrangement = Arrangement.spacedBy(QuestionSpec.formGap)) {
            for (question in questions) {
                val selected = selections[question.id].orEmpty()
                Column(modifier = Modifier.testTag(QuestionTags.QUESTION), verticalArrangement = Arrangement.spacedBy(QuestionSpec.questionGap)) {
                    HeaderChip(question.header, QuestionSpec.chipText, Modifier.padding(bottom = QuestionSpec.chipMarginBottom))
                    Text(
                        question.question,
                        style = QuestionSpec.questionText,
                        color = colors.text,
                        modifier = Modifier.padding(bottom = QuestionSpec.questionMarginBottom),
                    )
                    Column(verticalArrangement = Arrangement.spacedBy(QuestionSpec.optionsGap)) {
                        question.options.forEachIndexed { index, option ->
                            InlineOption(
                                option = option,
                                selected = index in selected,
                                multiSelect = question.multiSelect,
                                enabled = interactive,
                                onClick = {
                                    val current = selections[question.id].orEmpty()
                                    val next = when {
                                        !question.multiSelect -> setOf(index)
                                        index in current -> current - index
                                        else -> current + index
                                    }
                                    selections = selections + (question.id to next)
                                },
                            )
                        }
                    }
                }
            }
            if (interactive) {
                Row(modifier = Modifier.fillMaxWidth().padding(top = QuestionSpec.submitMarginTop), horizontalArrangement = Arrangement.End) {
                    SubmitButton(
                        ready = allAnswered && !submitting,
                        submitting = submitting,
                        onClick = {
                            val answers = questions.mapNotNull { q ->
                                val chosen = selections[q.id].orEmpty()
                                if (chosen.isEmpty()) null else q.id to chosen.sorted().mapNotNull { q.options.getOrNull(it)?.label }
                            }.toMap()
                            submitting = true
                            localAnswers = answers
                            scope.launch {
                                try {
                                    onSubmit(answers)
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    localAnswers = null
                                    Log.w("InlineQuestionForm", "Failed to submit question answer", e)
                                } finally {
                                    submitting = false
                                }
                            }
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun HeaderChip(text: String, style: androidx.compose.ui.text.TextStyle, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        style = style,
        color = HappyTheme.colors.textSecondary,
        modifier = modifier
            .testTag(QuestionTags.HEADER_CHIP)
            .clip(RoundedCornerShape(QuestionSpec.chipRadius))
            .background(HappyTheme.colors.surfaceHighest)
            .padding(horizontal = QuestionSpec.chipPaddingHorizontal, vertical = QuestionSpec.chipPaddingVertical),
    )
}

@Composable
private fun InlineOption(option: AgentQuestionOption, selected: Boolean, multiSelect: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val radio = ChatTheme.colors.radioActive
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val shape = RoundedCornerShape(QuestionSpec.optionRadius)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(QuestionTags.OPTION)
            .alpha(if (!enabled) QuestionSpec.DISABLED_OPACITY else if (pressed) QuestionSpec.PRESSED_OPACITY else 1f)
            .defaultMinSize(minHeight = QuestionSpec.optionMinHeight)
            .clip(shape)
            .background(if (selected) colors.surfaceHighest else colors.surface)
            .border(1.dp, if (selected) radio else colors.divider, shape)
            .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = if (multiSelect) Role.Checkbox else Role.RadioButton, onClick = onClick)
            .semantics { this.selected = selected }
            .padding(QuestionSpec.optionPadding),
        horizontalArrangement = Arrangement.spacedBy(QuestionSpec.optionGap),
    ) {
        Box(modifier = Modifier.padding(top = QuestionSpec.markTop)) {
            if (multiSelect) {
                CheckMark(selected, QuestionSpec.mark, QuestionSpec.checkboxRadius, if (selected) radio else colors.textSecondary, radio)
            } else {
                Box(
                    modifier = Modifier
                        .size(QuestionSpec.mark)
                        .border(2.dp, if (selected) radio else colors.textSecondary, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    if (selected) Box(Modifier.size(QuestionSpec.radioDot).background(radio, CircleShape))
                }
            }
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(option.label, style = QuestionSpec.optionLabel, color = colors.text)
            option.description?.takeIf { it.isNotEmpty() }?.let {
                Text(it, style = QuestionSpec.optionDescription, color = colors.textSecondary, modifier = Modifier.padding(top = QuestionSpec.optionDescriptionMarginTop))
            }
        }
    }
}

@Composable
private fun CheckMark(selected: Boolean, size: androidx.compose.ui.unit.Dp, radius: androidx.compose.ui.unit.Dp, border: Color, fill: Color) {
    val shape = RoundedCornerShape(radius)
    Box(
        modifier = Modifier
            .size(size)
            .clip(shape)
            .then(if (selected) Modifier.background(fill) else Modifier)
            .border(2.dp, border, shape),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) Icon(Ionicon.Checkmark, QuestionSpec.checkIcon, Color.White)
    }
}

@Composable
private fun SubmitButton(ready: Boolean, submitting: Boolean, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(QuestionSpec.submitRadius)
    Box(
        modifier = Modifier
            .testTag(QuestionTags.SUBMIT)
            .alpha(if (ready) 1f else QuestionSpec.SUBMIT_DISABLED_OPACITY)
            .defaultMinSize(minHeight = QuestionSpec.optionMinHeight)
            .clip(shape)
            .background(colors.surfaceHighest)
            .border(1.dp, if (ready) ChatTheme.colors.radioActive else colors.divider, shape)
            .clickable(enabled = ready, role = Role.Button, onClick = onClick)
            .padding(horizontal = QuestionSpec.submitPaddingHorizontal, vertical = QuestionSpec.submitPaddingVertical),
        contentAlignment = Alignment.Center,
    ) {
        if (submitting) {
            CircularProgressIndicator(Modifier.size(20.dp), color = colors.text, strokeWidth = 2.dp)
        } else {
            Text(stringResource(R.string.tools_ask_user_question_submit), style = QuestionSpec.submitText, color = colors.text)
        }
    }
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
    val env = LocalToolEnvironment.current
    val tool = message.tool
    val communication = remember(env.agentState, tool.callId) { selectAgentFormCommunication(env.agentState, tool.callId) } ?: return
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

/**
 * AgentQuestionBanner.tsx above the composer, for the first pending request
 * the transcript cannot show (a text-only form, or a kind this build does
 * not know): 12 side margins and 8 below, padding 12/10, radius 14, surface
 * fill, 1 border in textLink (divider when unsupported), 10 apart a 24
 * icon box (help-circle-outline 20 textLink; alert-circle-outline
 * textSecondary), the title (14 semibold, one line) over the subtitle (13
 * textSecondary, two lines), then a chevron 18, or "Dismiss" (14 semibold
 * textLink) for an unsupported one. A form opens [AgentQuestionModal].
 */
@Composable
fun AgentQuestionBanner(
    pending: List<PendingAgentCommunication>,
    onAnswer: suspend (communicationId: String, answers: Map<String, AgentQuestionAnswer>, kind: String) -> Unit,
    onCancel: suspend (communicationId: String, kind: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val first = pending.firstOrNull(::shouldUseAgentQuestionFallback) ?: return
    var openId by rememberSaveable { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    // An answer from another device closes the form here too.
    LaunchedEffect(pending, openId) {
        if (openId != null && pending.none { it.id == openId }) openId = null
    }
    when (first) {
        is PendingAgentCommunication.Unsupported -> AgentQuestionBannerView(
            first,
            modifier = modifier,
            onDismiss = { scope.launch { runCatching { onCancel(first.id, first.rawKind) } } },
        )
        is PendingAgentCommunication.Form -> {
            AgentQuestionBannerView(first, modifier = modifier, onPress = { openId = first.id })
            if (openId == first.id) {
                AgentQuestionModal(
                    form = first,
                    onSubmit = { answers -> onAnswer(first.id, answers, "form") },
                    onDismiss = {
                        openId = null
                        scope.launch { runCatching { onCancel(first.id, "form") } }
                    },
                    onClose = { openId = null },
                )
            }
        }
    }
}

@Composable
fun AgentQuestionBannerView(
    pending: PendingAgentCommunication,
    modifier: Modifier = Modifier,
    onPress: () -> Unit = {},
    onDismiss: () -> Unit = {},
) {
    val colors = HappyTheme.colors
    val unsupported = pending as? PendingAgentCommunication.Unsupported
    val form = pending as? PendingAgentCommunication.Form
    val shape = RoundedCornerShape(QuestionSpec.bannerRadius)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(start = QuestionSpec.bannerMarginHorizontal, end = QuestionSpec.bannerMarginHorizontal, bottom = QuestionSpec.bannerMarginBottom)
            .testTag(QuestionTags.BANNER)
            .clip(shape)
            .background(colors.surface)
            .border(1.dp, if (unsupported != null) colors.divider else colors.textLink, shape)
            .then(if (form != null) Modifier.clickable(role = Role.Button, onClick = onPress) else Modifier)
            .padding(horizontal = QuestionSpec.bannerPaddingHorizontal, vertical = QuestionSpec.bannerPaddingVertical),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(QuestionSpec.bannerGap),
    ) {
        Box(Modifier.width(QuestionSpec.bannerIconBox), contentAlignment = Alignment.Center) {
            if (unsupported != null) Icon(Ionicon.AlertCircleOutline, QuestionSpec.bannerIcon, colors.textSecondary)
            else Icon(Ionicon.HelpCircleOutline, QuestionSpec.bannerIcon, colors.textLink)
        }
        Column(modifier = Modifier.weight(1f)) {
            val title = unsupported?.let { it.title ?: stringResource(R.string.agent_question_unsupported_title) }
                ?: form?.questions?.firstOrNull()?.header ?: stringResource(R.string.agent_question_title)
            val remaining = (form?.questions?.size ?: 0) - 1
            val subtitle = when {
                unsupported != null -> stringResource(R.string.agent_question_unsupported_description, unsupported.rawKind)
                remaining > 0 -> pluralResource(R.plurals.agent_question_more_questions, remaining, remaining)
                else -> form?.questions?.firstOrNull()?.question.orEmpty()
            }
            Text(title, style = QuestionSpec.bannerTitle, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, style = QuestionSpec.bannerSubtitle, color = colors.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (unsupported != null) {
            Text(
                stringResource(R.string.agent_question_dismiss),
                style = QuestionSpec.bannerDismiss,
                color = colors.textLink,
                modifier = Modifier.testTag(QuestionTags.BANNER_DISMISS).clickable(role = Role.Button, onClick = onDismiss),
            )
        } else {
            Icon(Ionicon.ChevronForward, QuestionSpec.bannerChevron, colors.textSecondary)
        }
    }
}

/**
 * AgentQuestionModal.tsx, full screen on the grouped background: a header
 * (padding 16/14, hairline below) with Cancel (16 textLink) and the title
 * (16 semibold, centred); questions 28 apart in a scroll padded 16, each
 * 8 apart: the header chip with an orange 6 dot while unanswered, the
 * question (17 semibold), "Choose as many as apply" (13 textSecondary) for
 * multi-select, options (padding 14, radius 12, surface fill, 1 border in
 * textLink when chosen; a 22 radius-6 checkbox, 2 divider border, filled
 * textLink with a 14 white check; the label 15 semibold over its 13
 * description, 2 apart), and unless custom answers are off "Your own
 * answer" (13 semibold textSecondary) over a field (at least 48, radius
 * 12, surface, 1 divider border, padding 14/12, 15). A failed send shows
 * its message (14, #FF3B30) and keeps the answers. The footer (padding 16,
 * 12 above, hairline on top) holds Send answer: 50 high, radius 14,
 * textLink fill, 16 semibold white, 0.4 until every required question is
 * answered, a spinner while sending. Cancel and back dismiss the request.
 */
@Composable
fun AgentQuestionModal(
    form: PendingAgentCommunication.Form,
    onSubmit: suspend (Map<String, AgentQuestionAnswer>) -> Unit,
    onDismiss: () -> Unit,
    onClose: () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        AgentQuestionForm(form, onSubmit, onDismiss, onClose)
    }
}

/** The modal's content, without the window, for layout tests. */
@Composable
fun AgentQuestionForm(
    form: PendingAgentCommunication.Form,
    onSubmit: suspend (Map<String, AgentQuestionAnswer>) -> Unit,
    onDismiss: () -> Unit,
    onClose: () -> Unit,
) {
    val colors = HappyTheme.colors
    var drafts by remember(form.id) { mutableStateOf<Map<String, AgentQuestionDraft>>(emptyMap()) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember(form.id) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ready = canSubmit(form.questions, drafts)
    val failed = stringResource(R.string.agent_question_submit_failed)
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    BackHandler(enabled = !submitting, onBack = onDismiss)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .testTag(QuestionTags.MODAL)
            .background(colors.grouped.background)
            .statusBarsPadding()
            .imePadding(),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = QuestionSpec.modalHeaderPaddingHorizontal, vertical = QuestionSpec.modalHeaderPaddingVertical),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.common_cancel),
                style = QuestionSpec.modalHeaderAction,
                color = colors.textLink,
                modifier = Modifier.width(QuestionSpec.modalHeaderSpacer).testTag(QuestionTags.MODAL_CANCEL).clickable(enabled = !submitting, role = Role.Button, onClick = onDismiss),
            )
            Text(
                stringResource(R.string.agent_question_title),
                style = QuestionSpec.modalHeaderTitle,
                color = colors.text,
                textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(QuestionSpec.modalHeaderSpacer))
        }
        HorizontalDivider(thickness = hairline, color = colors.divider)
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(QuestionSpec.modalContentPadding)
                .padding(bottom = QuestionSpec.modalScrollBottom),
            verticalArrangement = Arrangement.spacedBy(QuestionSpec.modalQuestionGap),
        ) {
            for (question in form.questions) {
                ModalQuestion(
                    question = question,
                    draft = drafts[question.id] ?: AgentQuestionDraft.EMPTY,
                    answered = isQuestionAnswered(question, drafts[question.id]),
                    enabled = !submitting,
                    onChange = { drafts = drafts + (question.id to it) },
                )
            }
            error?.let { Text(it, style = QuestionSpec.modalError, color = QuestionSpec.modalErrorColor) }
        }
        HorizontalDivider(thickness = hairline, color = colors.divider)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.grouped.background)
                .navigationBarsPadding()
                .padding(start = QuestionSpec.modalContentPadding, end = QuestionSpec.modalContentPadding, top = QuestionSpec.modalFooterPaddingTop, bottom = QuestionSpec.modalFooterPaddingBottom),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(QuestionSpec.modalSubmitHeight)
                    .testTag(QuestionTags.MODAL_SUBMIT)
                    .alpha(if (ready && !submitting) 1f else QuestionSpec.MODAL_SUBMIT_DISABLED_OPACITY)
                    .clip(RoundedCornerShape(QuestionSpec.modalSubmitRadius))
                    .background(colors.textLink)
                    .clickable(enabled = ready && !submitting, role = Role.Button) {
                        submitting = true
                        error = null
                        scope.launch {
                            try {
                                onSubmit(buildAnswers(form.questions, drafts))
                                onClose()
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                error = e.message?.ifEmpty { null } ?: failed
                            } finally {
                                submitting = false
                            }
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                if (submitting) CircularProgressIndicator(Modifier.size(24.dp), color = Color.White, strokeWidth = 2.dp)
                else Text(stringResource(R.string.agent_question_submit), style = QuestionSpec.modalSubmitText, color = Color.White)
            }
        }
    }
}

@Composable
private fun ModalQuestion(question: AgentQuestion, draft: AgentQuestionDraft, answered: Boolean, enabled: Boolean, onChange: (AgentQuestionDraft) -> Unit) {
    val colors = HappyTheme.colors
    Column(modifier = Modifier.testTag(QuestionTags.QUESTION), verticalArrangement = Arrangement.spacedBy(QuestionSpec.modalBlockGap)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HeaderChip(question.header, QuestionSpec.modalChipText)
            if (!answered) Box(Modifier.size(QuestionSpec.requiredDot).background(QuestionSpec.requiredColor, CircleShape))
        }
        Text(question.question, style = QuestionSpec.modalQuestion, color = colors.text)
        if (question.multiSelect) {
            Text(stringResource(R.string.agent_question_choose_multiple), style = QuestionSpec.modalHint, color = colors.textSecondary)
        }
        for (option in question.options) {
            val selected = option.label in draft.options
            val shape = RoundedCornerShape(QuestionSpec.modalOptionRadius)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(QuestionTags.OPTION)
                    .clip(shape)
                    .background(colors.surface)
                    .border(1.dp, if (selected) colors.textLink else Color.Transparent, shape)
                    .clickable(enabled = enabled, role = if (question.multiSelect) Role.Checkbox else Role.RadioButton) {
                        onChange(toggleOption(draft, option.label, question.multiSelect))
                    }
                    .semantics { this.selected = selected }
                    .padding(QuestionSpec.modalOptionPadding),
                horizontalArrangement = Arrangement.spacedBy(QuestionSpec.modalOptionGap),
            ) {
                Box(Modifier.padding(top = 1.dp)) {
                    CheckMark(selected, QuestionSpec.modalCheckbox, QuestionSpec.modalCheckboxRadius, if (selected) colors.textLink else colors.divider, colors.textLink)
                }
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(option.label, style = QuestionSpec.modalOptionLabel, color = colors.text)
                    option.description?.takeIf { it.isNotEmpty() }?.let { Text(it, style = QuestionSpec.modalOptionDescription, color = colors.textSecondary) }
                }
            }
        }
        if (question.allowCustom != false) {
            Column(modifier = Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(stringResource(R.string.agent_question_own_answer), style = QuestionSpec.modalCustomLabel, color = colors.textSecondary)
                val shape = RoundedCornerShape(QuestionSpec.modalCustomRadius)
                val style = QuestionSpec.modalCustomInput.copy(color = colors.text)
                BasicTextField(
                    value = draft.custom,
                    onValueChange = { onChange(draft.copy(custom = it)) },
                    enabled = enabled,
                    textStyle = style,
                    cursorBrush = SolidColor(colors.text),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag(QuestionTags.MODAL_CUSTOM)
                        .defaultMinSize(minHeight = QuestionSpec.modalCustomMinHeight)
                        .clip(shape)
                        .background(colors.surface)
                        .border(1.dp, colors.divider, shape),
                    decorationBox = { inner ->
                        Box(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
                            if (draft.custom.isEmpty()) {
                                Text(stringResource(R.string.agent_question_own_answer_placeholder), style = style.copy(color = colors.textSecondary))
                            }
                            inner()
                        }
                    },
                )
            }
        }
    }
}
