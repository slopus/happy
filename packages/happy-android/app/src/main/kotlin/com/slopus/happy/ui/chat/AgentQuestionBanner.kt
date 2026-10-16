package com.slopus.happy.ui.chat

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.slopus.happy.R
import com.slopus.happy.chat.AgentQuestion
import com.slopus.happy.chat.AgentQuestionAnswer
import com.slopus.happy.chat.AgentQuestionDraft
import com.slopus.happy.chat.PendingAgentCommunication
import com.slopus.happy.chat.buildAnswers
import com.slopus.happy.chat.canSubmit
import com.slopus.happy.chat.isQuestionAnswered
import com.slopus.happy.chat.shouldUseAgentQuestionFallback
import com.slopus.happy.chat.toggleOption
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

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
