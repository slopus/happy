package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.AskPhase
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.Question
import com.slopus.happy.conversation.answers
import com.slopus.happy.conversation.complete
import com.slopus.happy.conversation.picking
import com.slopus.happy.ui.chat.ChatTheme
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ShimmerSpec
import com.slopus.happy.ui.components.ShimmerText
import com.slopus.happy.ui.theme.AppMono
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

object AskTags {
    const val ROW = "conversation.ask"
    const val RULE = "conversation.ask.rule"
    const val OPTION = "conversation.ask.option"
    const val ANSWER = "conversation.ask.answer"
    const val NOTE = "conversation.ask.note"
    const val SUBMIT = "conversation.ask.submit"
}

/**
 * A question in the transcript, desktop's `HappyAgentUserInputPrompt` card
 * as iOS lays it (7f6355041 `QuestionLayout`, `TurnTokens`): the block sits
 * [outset] out from the text column on each side, so the words inside line
 * up with the transcript's.
 */
object AskSpec {
    val outset = 12.dp
    val legendTop = 6.dp
    val legendBottom = 5.dp
    val legendGap = 3.dp
    val eyebrowGap = 8.dp
    val eyebrowHeight = 16.dp
    val optionGap = 2.dp
    val optionMinHeight = 32.dp
    val optionPaddingV = 4.dp
    val box = 18.dp
    val boxGap = 9.dp
    val check = 14.dp
    val answerPaddingV = 5.dp
    val promptGap = 8.dp
    val footerPaddingV = 4.dp
    val footerPaddingH = 8.dp
    val button = 28.dp
    val buttonPaddingH = 10.dp
    val radius = 6.dp
    /** Above and below the whole block, as a message has. */
    val marginV = 8.dp

    /** How much of `--surface-selected` a picked option (72%) and an answer (58%) are washed in. */
    const val PICKED_ALPHA = 0.72f
    const val ANSWERED_ALPHA = 0.58f
    /** A disabled Submit, and the options while the answer is on its way. */
    const val DISABLED_ALPHA = 0.48f
    const val PENDING_ALPHA = 0.55f

    val header = happyTextStyle(fontSize = 11, lineHeight = 16, letterSpacing = 0.44f, weight = FontWeight.SemiBold, family = AppMono)
    val rule = happyTextStyle(fontSize = 12, lineHeight = 16)
    val prompt = happyTextStyle(fontSize = 15, lineHeight = 22, weight = FontWeight.Medium)
    val option = happyTextStyle(fontSize = 14, lineHeight = 19)
    val description = happyTextStyle(fontSize = 12, lineHeight = 16)
    val answer = happyTextStyle(fontSize = 14, lineHeight = 20, weight = FontWeight.Medium)
    val submit = happyTextStyle(fontSize = 12, lineHeight = 16, letterSpacing = 0.12f, weight = FontWeight.Bold)
    val title = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.SemiBold)
}

/**
 * The waiting question's ticks, kept by the screen until they go (iOS
 * keeps them on the chat's controller): by Submit, or with words typed in
 * the composer, which answer each prompt nothing was ticked on.
 */
@Stable
class AskActions(private val scope: CoroutineScope, private val onAnswer: suspend (questionId: String, answers: Map<String, List<String>>) -> Unit) {
    private val picks = mutableStateMapOf<String, Map<String, List<String>>>()

    fun picked(questionId: String): Map<String, List<String>> = picks[questionId].orEmpty()

    fun pick(question: Question, promptId: String, label: String) {
        picks[question.id] = question.picking(picked(question.id), promptId, label)
    }

    /** Ticks outlive only the question they were for. */
    fun keepOnly(questionId: String?) {
        picks.keys.retainAll { it == questionId }
    }

    fun submit(question: Question) {
        val picked = picked(question.id)
        if (question.complete(picked)) send(question, picked)
    }

    /** [typed] answers [question] where nothing is ticked; true when it did, so the words are no message. */
    fun typed(question: Question, typed: String): Boolean {
        val answer = question.answers(picked(question.id), typed)
        send(question, answer.answers)
        return answer.textUsed
    }

    private fun send(question: Question, answers: Map<String, List<String>>) {
        scope.launch {
            try {
                onAnswer(question.id, answers)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The row says why (AskPhase.Failed), and the ticks stay to go again.
            }
        }
    }
}

/**
 * A question the agent asked. Waiting: each prompt's eyebrow (its header in
 * 11/16 mono semibold capitals, 8, then "Choose one", "Choose any" or "Reply
 * in the message box" in 12/16 textSecondary) 6 under the prompt above and
 * 3 over the question (15/22 medium); its options 2 apart, each at least
 * 32 high, 4 above and below and 12 in, an 18 box (radius 6, input fill,
 * radioInactive hairline; ticked: radioActive with a white 14 check) 9
 * before the label (14/19) over its description (12/16 textSecondary). A
 * ticked option is washed in surfaceSelected at 0.72. Prompts 8 apart; then
 * Submit, a 28 pill 10 in each side (12/16 bold on surfaceHigh with a
 * divider hairline) 8 from the right and 4 above and below, at 0.48 until
 * every prompt has a tick. While the answer goes the options fade to 0.55
 * and Submit's word shimmers; a refusal says "Answer not sent: why" in
 * textDestructive over it. Answered: the eyebrow says "Answered" (or "No
 * answer"), and each answer stands in its own surfaceSelected wash at
 * 0.58, 14/20 medium, 5 above and below. The agent's context, in Markdown,
 * leads; a permission request is named first.
 */
@Composable
fun AskRow(row: ConversationRow.Ask, actions: AskActions?, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val question = row.question
    val answered = row.phase == AskPhase.Answered
    val sending = row.phase == AskPhase.Submitting
    val picked = if (answered) emptyMap() else actions?.picked(question.id).orEmpty()
    val optionAlpha = if (sending) AskSpec.PENDING_ALPHA else 1f
    val haptics = LocalHapticFeedback.current
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal - AskSpec.outset, vertical = AskSpec.marginV)
            .testTag(AskTags.ROW),
    ) {
        val inset = Modifier.padding(horizontal = AskSpec.outset)
        if (question.isPermission) {
            Text(
                if (question.permissionFrom != null) stringResource(R.string.conversation_permission_from, question.permissionFrom) else stringResource(R.string.conversation_permission),
                style = AskSpec.title,
                color = colors.textSecondary,
                modifier = inset,
            )
        }
        question.context?.let { context -> MarkdownView(remember(context) { parseMarkdown(context) }, modifier = inset.fillMaxWidth()) }
        question.prompts.forEachIndexed { index, prompt ->
            if (index > 0) Spacer(Modifier.height(AskSpec.promptGap))
            val values = if (answered) question.answers?.get(prompt.id).orEmpty() else picked[prompt.id].orEmpty()
            val rule = when {
                answered -> stringResource(if (values.isEmpty()) R.string.conversation_ask_no_answer else R.string.conversation_ask_answered)
                prompt.options.isEmpty() -> stringResource(R.string.conversation_ask_reply_in_composer)
                prompt.multiSelect -> stringResource(R.string.conversation_ask_choose_any)
                else -> stringResource(R.string.conversation_ask_choose_one)
            }
            Spacer(Modifier.height(AskSpec.legendTop))
            Row(inset.height(AskSpec.eyebrowHeight), verticalAlignment = Alignment.CenterVertically) {
                prompt.header?.takeIf { it.isNotEmpty() }?.let { header ->
                    Text(header.uppercase(), style = AskSpec.header, color = colors.textSecondary, maxLines = 1)
                    Spacer(Modifier.width(AskSpec.eyebrowGap))
                }
                Text(rule, style = AskSpec.rule, color = colors.textSecondary, maxLines = 1, modifier = Modifier.testTag(AskTags.RULE))
            }
            Spacer(Modifier.height(AskSpec.legendGap))
            Text(prompt.question, style = AskSpec.prompt, color = colors.text, modifier = inset)
            Spacer(Modifier.height(AskSpec.legendBottom))
            Column(verticalArrangement = Arrangement.spacedBy(AskSpec.optionGap)) {
                if (answered) {
                    for (value in values.ifEmpty { listOf(stringResource(R.string.conversation_ask_no_answer)) }) {
                        val description = prompt.options.firstOrNull { it.label == value }?.description?.takeIf { it.isNotEmpty() }
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .testTag(AskTags.ANSWER)
                                .background(colors.surfaceSelected.copy(alpha = colors.surfaceSelected.alpha * AskSpec.ANSWERED_ALPHA), RoundedCornerShape(AskSpec.radius))
                                .padding(horizontal = AskSpec.outset, vertical = AskSpec.answerPaddingV),
                        ) {
                            Text(value, style = AskSpec.answer, color = colors.text)
                            description?.let { Text(it, style = AskSpec.description, color = colors.textSecondary) }
                        }
                    }
                } else {
                    for (option in prompt.options) {
                        val ticked = option.label in values
                        AskOption(
                            option = option,
                            ticked = ticked,
                            alpha = optionAlpha,
                            enabled = !sending && actions != null,
                            onClick = {
                                haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                                actions?.pick(question, prompt.id, option.label)
                            },
                        )
                    }
                }
            }
        }
        if (answered) return@Column
        (row.phase as? AskPhase.Failed)?.let { failed ->
            Spacer(Modifier.height(AskSpec.footerPaddingV))
            Text(
                stringResource(R.string.conversation_ask_not_sent, problemText(failed.reason)),
                style = AskSpec.rule,
                color = colors.textDestructive,
                modifier = inset.testTag(AskTags.NOTE),
            )
        }
        val ready = question.complete(picked) && !sending && actions != null
        Row(
            Modifier
                .fillMaxWidth()
                .padding(vertical = AskSpec.footerPaddingV)
                .padding(end = AskSpec.footerPaddingH),
            horizontalArrangement = Arrangement.End,
        ) {
            val shape = RoundedCornerShape(AskSpec.button / 2)
            Box(
                Modifier
                    .testTag(AskTags.SUBMIT)
                    .alpha(if (ready || sending) 1f else AskSpec.DISABLED_ALPHA)
                    .height(AskSpec.button)
                    .background(colors.surfaceHigh, shape)
                    .border(1.dp, colors.divider, shape)
                    .clickable(enabled = ready, role = Role.Button) { actions?.submit(question) }
                    .padding(horizontal = AskSpec.buttonPaddingH),
                contentAlignment = Alignment.Center,
            ) {
                // Desktop's pending Submit: the word stays and shimmers.
                ShimmerText(
                    stringResource(R.string.conversation_ask_submit),
                    style = AskSpec.submit,
                    baseColor = ShimmerSpec.rest(colors.text, colors.surfaceHigh),
                    highlightColor = colors.text,
                    shimmering = sending,
                    stillColor = colors.text,
                )
            }
        }
    }
}

@Composable
private fun AskOption(option: Question.Option, ticked: Boolean, alpha: Float, enabled: Boolean, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val chat = ChatTheme.colors
    val shape = RoundedCornerShape(AskSpec.radius)
    Row(
        Modifier
            .fillMaxWidth()
            .testTag(AskTags.OPTION)
            .defaultMinSize(minHeight = AskSpec.optionMinHeight)
            .then(if (ticked) Modifier.background(colors.surfaceSelected.copy(alpha = colors.surfaceSelected.alpha * AskSpec.PICKED_ALPHA * alpha), shape) else Modifier)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, enabled = enabled, role = Role.Checkbox, onClick = onClick)
            .semantics { selected = ticked }
            .padding(horizontal = AskSpec.outset, vertical = AskSpec.optionPaddingV),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .alpha(alpha)
                .size(AskSpec.box)
                .background(if (ticked) chat.radioActive else colors.input.background, shape)
                .border(1.dp, if (ticked) chat.radioActive else chat.radioInactive, shape),
            contentAlignment = Alignment.Center,
        ) {
            if (ticked) Icon(Ionicon.Checkmark, AskSpec.check, androidx.compose.ui.graphics.Color.White)
        }
        Spacer(Modifier.width(AskSpec.boxGap))
        Column(Modifier.weight(1f).alpha(alpha)) {
            Text(option.label, style = AskSpec.option, color = colors.text)
            option.description?.takeIf { it.isNotEmpty() }?.let { Text(it, style = AskSpec.description, color = colors.textSecondary) }
        }
    }
}
