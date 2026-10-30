package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.AgentQuestionOption
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.Question
import com.slopus.happy.ui.chat.InlineQuestion
import com.slopus.happy.ui.chat.InlineQuestionForm
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.components.HappyTextField
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

object ConversationQuestionTags {
    const val CARD = "conversation.question"
    const val TITLE = "conversation.question.title"
    const val FIELD = "conversation.question.field"
    const val SUBMIT = "conversation.question.submit"
    const val UNAVAILABLE = "conversation.question.unavailable"
}

/** The card's measures; the choice form inside is the legacy chat's (QuestionSpec). */
object ConversationQuestionSpec {
    val marginHorizontal = 8.dp
    val marginBottom = 8.dp
    val radius = 16.dp
    val padding = 12.dp
    val maxHeight = 360.dp
    val title = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.SemiBold)
    val question = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.Medium)
    val field = happyTextStyle(fontSize = 15, lineHeight = 20)
    val submit = happyTextStyle(fontSize = 14, weight = FontWeight.SemiBold)
}

/**
 * The question a run waits on, over the composer. Spec: 8 in from the
 * sides and 8 above the composer, a surfaceHigh card, radius 16, padding
 * 12, at most 360 high (less on a short screen, see [ConversationScreen])
 * and scrolling inside. "Question", "Permission
 * request" or "<server> asks for permission" (13/18 semibold,
 * textSecondary), then the agent's context in Markdown. Prompts that all
 * offer options use the legacy choice form (InlineQuestionForm); a prompt
 * without options takes free text: the question (15/20 medium), a field
 * (surface, radius 8, padding 12/10, at least 44 high) and Answer at the
 * end (14 semibold on surfaceHighest, radius 8, padding 20/12, 0.5 until
 * every prompt has text, a spinner while it goes). A question asking for
 * a secret is answered by [SecretRequestForm], which scrolls only its
 * fields and keeps Cancel and Save below them; where this build can't make
 * secrets, it says where to answer it.
 */
@Composable
fun ConversationQuestionCard(
    question: Question,
    onAnswer: suspend (Map<String, List<String>>) -> Unit,
    modifier: Modifier = Modifier,
    /** How a secret request is made and answered; null where this build cannot. */
    secrets: SecretRequestActions? = null,
    /** The card's height cap: [ConversationQuestionSpec.maxHeight], or less where the screen is short. */
    maxHeight: Dp = ConversationQuestionSpec.maxHeight,
) {
    val colors = HappyTheme.colors
    val secret = question.secret
    val card = modifier
        .fillMaxWidth()
        .contentMaxWidth(LocalWindowLayout.current)
        .padding(horizontal = ConversationQuestionSpec.marginHorizontal)
        .padding(bottom = ConversationQuestionSpec.marginBottom)
        .testTag(ConversationQuestionTags.CARD)
        .clip(RoundedCornerShape(ConversationQuestionSpec.radius))
        .background(colors.surfaceHigh)
        .heightIn(max = maxHeight)
    val header: @Composable () -> Unit = {
        val title = when {
            question.permissionFrom != null -> stringResource(R.string.conversation_permission_from, question.permissionFrom)
            question.isPermission -> stringResource(R.string.conversation_permission)
            else -> stringResource(R.string.conversation_question)
        }
        Text(title, style = ConversationQuestionSpec.title, color = colors.textSecondary, modifier = Modifier.testTag(ConversationQuestionTags.TITLE))
        question.context?.let { context -> MarkdownView(remember(context) { parseMarkdown(context) }) }
    }
    if (secret != null && secrets != null) {
        // The secret form scrolls its own fields under this header and keeps its buttons below them.
        Box(card) {
            SecretRequestForm(secret, secrets, header) { secretId ->
                // The answer is the secret's id under the prompt that asked, never a value.
                onAnswer(mapOf((question.prompts.singleOrNull()?.id ?: "secret") to listOf(secretId)))
            }
        }
        return
    }
    Column(
        modifier = card
            .verticalScroll(rememberScrollState())
            .padding(ConversationQuestionSpec.padding),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        header()
        when {
            secret != null -> Text(
                stringResource(R.string.conversation_secret_unavailable),
                style = ConversationQuestionSpec.field,
                color = colors.textSecondary,
                modifier = Modifier.testTag(ConversationQuestionTags.UNAVAILABLE),
            )
            question.prompts.all { it.options.isNotEmpty() } -> InlineQuestionForm(
                questions = question.prompts.map { prompt ->
                    InlineQuestion(
                        id = prompt.id,
                        question = prompt.question,
                        header = prompt.header.orEmpty(),
                        options = prompt.options.map { AgentQuestionOption(it.label, it.description) },
                        multiSelect = prompt.multiSelect,
                    )
                },
                canInteract = true,
                submittedAnswers = null,
                onSubmit = onAnswer,
            )
            else -> FreeTextForm(question, onAnswer)
        }
    }
}

@Composable
private fun FreeTextForm(question: Question, onAnswer: suspend (Map<String, List<String>>) -> Unit) {
    val colors = HappyTheme.colors
    var answers by remember(question.id) { mutableStateOf(question.prompts.associate { it.id to "" }) }
    var sending by remember(question.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ready = !sending && answers.values.all { it.isNotBlank() }
    for (prompt in question.prompts) {
        Text(prompt.question, style = ConversationQuestionSpec.question, color = colors.text)
        if (prompt.options.isNotEmpty()) {
            // A prompt with choices beside free ones: its labels fill the field.
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                prompt.options.forEach { option ->
                    Text(
                        option.label,
                        style = ConversationQuestionSpec.field,
                        color = colors.text,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .border(1.dp, colors.divider, RoundedCornerShape(8.dp))
                            .clickable(role = Role.Button) { answers = answers + (prompt.id to option.label) }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                    )
                }
            }
        }
        HappyTextField(
            value = answers[prompt.id].orEmpty(),
            onValueChange = { answers = answers + (prompt.id to it) },
            placeholder = stringResource(R.string.conversation_answer_placeholder),
            textStyle = ConversationQuestionSpec.field,
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
            minHeight = 44.dp,
            cornerRadius = 8.dp,
            enabled = !sending,
            modifier = Modifier.testTag(ConversationQuestionTags.FIELD),
        )
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Box(
            modifier = Modifier
                .testTag(ConversationQuestionTags.SUBMIT)
                .alpha(if (ready || sending) 1f else 0.5f)
                .clip(RoundedCornerShape(8.dp))
                .background(colors.surfaceHighest)
                .clickable(enabled = ready, role = Role.Button) {
                    sending = true
                    scope.launch {
                        try {
                            onAnswer(answers.mapValues { listOf(it.value.trim()) })
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            // The screen's alert says why; the text stays to send again.
                        } finally {
                            sending = false
                        }
                    }
                }
                .padding(horizontal = 20.dp, vertical = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (sending) CircularProgressIndicator(Modifier.heightIn(max = 18.dp), color = colors.text, strokeWidth = 2.dp)
            else Text(stringResource(R.string.conversation_answer), style = ConversationQuestionSpec.submit, color = colors.text)
        }
    }
}
