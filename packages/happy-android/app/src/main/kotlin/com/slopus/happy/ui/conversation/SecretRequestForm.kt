package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentDataType
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDataType
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.isSensitiveData
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.constrainWidth
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.ConversationApiException
import com.slopus.happy.conversation.Question
import com.slopus.happy.conversation.SecretSummary
import com.slopus.happy.ui.components.HappyTextField
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

object SecretRequestTags {
    const val FORM = "conversation.secret"
    const val NAME = "conversation.secret.name"
    const val VALUE = "conversation.secret.value"
    const val SUBMIT = "conversation.secret.submit"
    const val CANCEL = "conversation.secret.cancel"
    const val EXISTING = "conversation.secret.existing"
    const val PICK = "conversation.secret.pick"
    const val PROBLEM = "conversation.secret.problem"
    const val KEPT = "conversation.secret.kept"
    const val MALFORMED = "conversation.secret.malformed"
}

/** What the form needs of the computer: the catalog it may pick from, and making one. */
class SecretRequestActions(
    val secrets: suspend () -> List<SecretSummary>,
    /** Makes the secret and returns the id the daemon gave it. */
    val create: suspend (id: String?, description: String?, values: Map<String, String>) -> String,
)

/** A request this build can't make a form out of, so it says so instead of showing a useless one. */
private val Question.SecretRequest.isBroken: Boolean
    get() = variables.isEmpty() ||
        variables.any { it.name.isBlank() } ||
        variables.distinctBy { it.name.lowercase() }.size != variables.size

/**
 * The form an agent's secret request asks for (API.md "Secret requests"):
 * a name and description filled in from what the agent suggested, and one
 * hidden field per variable it needs. Saving makes the secret and answers
 * the question with its id alone — the values go in that one request and
 * nowhere else: never into the draft, saved state, the transcript, a log,
 * an error message or any message shown here.
 *
 * Three things the person can always get back out of:
 *  - a secret already in the catalog that carries every variable can be
 *    picked instead, and nothing is sent until they say so;
 *  - Cancel forgets what was typed without sending anything;
 *  - when the secret was made but the answer didn't get through, saving
 *    again answers with the id already returned rather than making a
 *    second secret, and asks for nothing again.
 *
 * The form fills the card itself: [header] (the card's title and context)
 * and the fields scroll, and Cancel and Save stay below them, so the
 * card's 360 cap cuts the fields and never the buttons. Only when there is
 * no room left for a field over them — a short screen with the keyboard
 * up — do the buttons step aside for the field being typed in; the last
 * field's Done puts the keyboard away and brings them back.
 */
@Composable
internal fun SecretRequestForm(
    request: Question.SecretRequest,
    actions: SecretRequestActions,
    header: @Composable () -> Unit = {},
    onAnswer: suspend (secretId: String) -> Unit,
) {
    val colors = HappyTheme.colors
    val scope = rememberCoroutineScope()
    if (request.isBroken) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(ConversationQuestionSpec.padding),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            header()
            Text(
                stringResource(R.string.conversation_secret_malformed),
                style = ConversationQuestionSpec.field,
                color = colors.textSecondary,
                modifier = Modifier.testTag(SecretRequestTags.MALFORMED),
            )
        }
        return
    }
    // Deliberately not rememberSaveable: a typed value never reaches saved state.
    var values by remember(request) { mutableStateOf(request.variables.associate { it.name to "" }) }
    var name by remember(request) { mutableStateOf(request.suggestedId.orEmpty()) }
    var sending by remember(request) { mutableStateOf(false) }
    var problem by remember(request) { mutableStateOf<String?>(null) }
    var existing by remember(request) { mutableStateOf<List<SecretSummary>>(emptyList()) }
    // The id the daemon returned, kept so a failed answer is retried with it
    // rather than making the secret twice. Once it is set the values are gone.
    var made by remember(request) { mutableStateOf<String?>(null) }
    val kept = made != null
    val ready = !sending && (kept || values.values.all { it.isNotBlank() })
    val conflict = stringResource(R.string.conversation_secret_name_taken)
    val failed = stringResource(R.string.conversation_secret_failed)
    val answerFailed = stringResource(R.string.conversation_secret_answer_failed)

    // The header and the fields scroll; what the person acts with stays below them.
    val body: @Composable () -> Unit = {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = ConversationQuestionSpec.padding, top = ConversationQuestionSpec.padding, end = ConversationQuestionSpec.padding, bottom = 4.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            header()
            request.description?.let { Text(it, style = ConversationQuestionSpec.question, color = colors.text) }
            if (kept) {
                Text(
                    stringResource(R.string.conversation_secret_kept, made.orEmpty()),
                    style = ConversationQuestionSpec.question,
                    color = colors.text,
                    modifier = Modifier.testTag(SecretRequestTags.KEPT),
                )
            } else {
                Text(stringResource(R.string.conversation_secret_name), style = ConversationQuestionSpec.title, color = colors.textSecondary)
                HappyTextField(
                    value = name,
                    onValueChange = { name = it; problem = null },
                    placeholder = stringResource(R.string.conversation_secret_name_placeholder),
                    textStyle = ConversationQuestionSpec.field,
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                    minHeight = 44.dp,
                    cornerRadius = 8.dp,
                    enabled = !sending,
                    modifier = Modifier.testTag(SecretRequestTags.NAME),
                )
                request.variables.forEachIndexed { index, variable ->
                    SecretValueField(
                        variable = variable,
                        value = values[variable.name].orEmpty(),
                        enabled = !sending,
                        last = index == request.variables.lastIndex,
                        onValueChange = { values = values + (variable.name to it); problem = null },
                    )
                }
                Text(
                    stringResource(R.string.conversation_secret_use_existing),
                    style = ConversationQuestionSpec.title,
                    color = colors.textLink,
                    modifier = Modifier
                        .testTag(SecretRequestTags.EXISTING)
                        .clickable(enabled = !sending, role = Role.Button) {
                            scope.launch {
                                existing = try {
                                    // Only ones the agents may read, and only ones that carry every variable.
                                    actions.secrets().filter { it.availableToAgents && it.covers(request) }
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (_: Exception) {
                                    problem = failed
                                    emptyList()
                                }
                            }
                        }
                        .padding(vertical = 6.dp),
                )
                existing.forEach { secret ->
                    Text(
                        secret.description?.takeIf { it.isNotBlank() }?.let { "${secret.id} — $it" } ?: secret.id,
                        style = ConversationQuestionSpec.field,
                        color = colors.text,
                        modifier = Modifier
                            .testTag(SecretRequestTags.PICK)
                            .fillMaxWidth()
                            .clickable(enabled = !sending, role = Role.Button) {
                                sending = true
                                scope.launch {
                                    try {
                                        onAnswer(secret.id)
                                    } catch (e: CancellationException) {
                                        throw e
                                    } catch (_: Exception) {
                                        problem = failed
                                    } finally {
                                        sending = false
                                    }
                                }
                            }
                            .padding(vertical = 8.dp),
                    )
                }
            }
        }
    }
    val buttons: @Composable () -> Unit = {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(start = ConversationQuestionSpec.padding, top = 4.dp, end = ConversationQuestionSpec.padding, bottom = ConversationQuestionSpec.padding),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            problem?.let {
                Text(it, style = ConversationQuestionSpec.title, color = colors.textDestructive, modifier = Modifier.testTag(SecretRequestTags.PROBLEM))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                if (!kept) {
                    // Only while nothing is in flight: a half-sent create whose id we
                    // threw away would leave a secret behind that nothing points at.
                    FormButton(
                        label = stringResource(R.string.conversation_secret_cancel),
                        tag = SecretRequestTags.CANCEL,
                        enabled = !sending,
                        background = colors.surfaceHigh,
                    ) {
                        values = request.variables.associate { it.name to "" }
                        name = request.suggestedId.orEmpty()
                        existing = emptyList()
                        problem = null
                    }
                }
                FormButton(
                    label = stringResource(if (kept) R.string.conversation_secret_answer else R.string.conversation_secret_save),
                    tag = SecretRequestTags.SUBMIT,
                    enabled = ready,
                    background = colors.surfaceHighest,
                ) {
                    sending = true
                    problem = null
                    scope.launch {
                        try {
                            val id = made ?: actions.create(name.takeIf { it.isNotBlank() }, request.description, values).also {
                                made = it
                                // Saved on the computer; there is no reason to hold them here any longer.
                                values = request.variables.associate { variable -> variable.name to "" }
                            }
                            // Only the returned id is ever answered with.
                            onAnswer(id)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            // Never the daemon's body, which a careless client could echo a value into.
                            problem = when {
                                made != null -> answerFailed
                                e is ConversationApiException && e.status == 409 -> conflict
                                else -> failed
                            }
                        } finally {
                            sending = false
                        }
                    }
                }
            }
        }
    }
    ButtonsBelow(body, buttons, Modifier.fillMaxWidth().testTag(SecretRequestTags.FORM))
}

/** The least room the fields keep while the buttons are below them: a variable's name and one field. */
private val FieldsAtLeast = 96.dp

/**
 * [body] over [buttons], the body taking what the buttons leave. When that
 * would be less than [FieldsAtLeast] — the keyboard up on a short screen —
 * the buttons are left out and the body has it all, so the field being
 * typed in stays in view; they are back as soon as the keyboard is down.
 * Neither is ever recomposed elsewhere, so a focused field keeps its focus.
 */
@Composable
private fun ButtonsBelow(body: @Composable () -> Unit, buttons: @Composable () -> Unit, modifier: Modifier = Modifier) {
    Layout(contents = listOf(body, buttons), modifier = modifier) { (bodies, buttonRows), constraints ->
        val loose = constraints.copy(minHeight = 0)
        val below = buttonRows.single().measure(loose)
        val room = constraints.maxHeight - below.height
        val withButtons = !constraints.hasBoundedHeight || room >= FieldsAtLeast.roundToPx()
        val above = bodies.single().measure(if (withButtons && constraints.hasBoundedHeight) loose.copy(maxHeight = room) else loose)
        val width = constraints.constrainWidth(maxOf(above.width, below.width))
        val height = constraints.constrainHeight(above.height + if (withButtons) below.height else 0)
        layout(width, height) {
            above.place(0, 0)
            if (withButtons) below.place(0, above.height)
        }
    }
}

/**
 * One variable's value, under the name the agent gave it.
 *
 * What a screen reader is handed for the field itself is an EditText whose
 * text is dots and whose `isPassword` is true — Compose's accessibility
 * delegate reads the transformed `EditableText`, never the raw `InputText`,
 * and a content description is dropped for an editable node (Material's own
 * `TextField(label = …)` is no different). So the name is its own node
 * directly before the field, and the two are one traversal group, which is
 * how Compose labels a field. Nothing announces the value.
 *
 * The password keyboard is what sets the `Password` semantics, and it also
 * stops the IME learning what was typed. `ContentDataType.None` keeps the
 * field out of the autofill view structure, so no password manager offers to
 * keep a copy of an agent's credential.
 *
 * `isSensitiveData` marks the node sensitive, which does two things in the
 * delegate: on a platform that has it the node says so
 * (`AccessibilityNodeInfo.setAccessibilityDataSensitive`), and a request that
 * isn't from an accessibility tool is handed nothing at all for this node.
 * A screen reader still reaches the field; a service that only watches does
 * not. Both halves are covered in SecretMaskingTest.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun SecretValueField(
    variable: Question.SecretVariable,
    value: String,
    enabled: Boolean,
    /** The last field's key is Done, which only puts the keyboard away: nothing is saved from the keyboard. */
    last: Boolean,
    onValueChange: (String) -> Unit,
) {
    val colors = HappyTheme.colors
    Column(
        modifier = Modifier.fillMaxWidth().semantics { isTraversalGroup = true },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(variable.name, style = ConversationQuestionSpec.question, color = colors.text)
        variable.description?.let { Text(it, style = ConversationQuestionSpec.title, color = colors.textSecondary) }
        HappyTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = stringResource(R.string.conversation_secret_value_placeholder),
            textStyle = ConversationQuestionSpec.field,
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
            minHeight = 44.dp,
            cornerRadius = 8.dp,
            enabled = enabled,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                // With no handler, Done's default is to hide the keyboard, and Next moves on.
                imeAction = if (last) ImeAction.Done else ImeAction.Next,
                autoCorrectEnabled = false,
            ),
            singleLine = true,
            modifier = Modifier
                .testTag(SecretRequestTags.VALUE)
                .semantics {
                    contentDescription = variable.name
                    contentDataType = ContentDataType.None
                    isSensitiveData = true
                },
        )
    }
}

@Composable
private fun FormButton(
    label: String,
    tag: String,
    enabled: Boolean,
    background: androidx.compose.ui.graphics.Color,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .testTag(tag)
            .alpha(if (enabled) 1f else 0.5f)
            .clip(RoundedCornerShape(8.dp))
            .background(background)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Text(label, style = ConversationQuestionSpec.field, color = HappyTheme.colors.text)
    }
}
