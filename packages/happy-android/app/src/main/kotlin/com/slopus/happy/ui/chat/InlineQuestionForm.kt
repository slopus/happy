package com.slopus.happy.ui.chat

import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.AgentQuestionOption
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

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
internal fun HeaderChip(text: String, style: androidx.compose.ui.text.TextStyle, modifier: Modifier = Modifier) {
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
internal fun CheckMark(selected: Boolean, size: androidx.compose.ui.unit.Dp, radius: androidx.compose.ui.unit.Dp, border: Color, fill: Color) {
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
