package com.slopus.happy.ui.genui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentDataType
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDataType
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.isSensitiveData
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.genui.GenUiActions
import com.slopus.happy.genui.SecretPrefill
import com.slopus.happy.ui.components.HappyTextField
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ShimmerSpec
import com.slopus.happy.ui.components.ShimmerText
import com.slopus.happy.ui.components.TrackOverlay
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

object GenUiSecretTags {
    const val SHEET = "genui.secret"
    const val MODE = "genui.secret.mode"
    const val NAME = "genui.secret.name"
    const val DESCRIPTION = "genui.secret.description"
    const val VARIABLE = "genui.secret.variable"
    const val VALUE = "genui.secret.value"
    const val REMOVE = "genui.secret.remove"
    const val ADD = "genui.secret.add"
    const val PROBLEM = "genui.secret.problem"
    const val CANCEL = "genui.secret.cancel"
    const val SAVE = "genui.secret.save"
    const val DONE = "genui.secret.done"
}

/** A secret button tapped: which version and element, and what its form starts with. */
@Immutable
data class SecretAsk(val artifactId: String, val version: Int, val element: String, val prefill: SecretPrefill, val name: String?)

private object SecretSheetSpec {
    val title = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold)
    val label = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.SemiBold)
    val body = happyTextStyle(fontSize = 15, lineHeight = 20)
    val small = happyTextStyle(fontSize = 13, lineHeight = 18)
    val mono = happyTextStyle(fontSize = 15, lineHeight = 20).copy(fontFamily = FontFamily.Monospace)
    val padding = 20.dp
    val field = PaddingValues(horizontal = 12.dp, vertical = 10.dp)
}

/** What the person is told after a failed save; never the daemon's own words, which could echo a value. */
private enum class SaveTrouble { Stale, Exists, Refused, Unavailable, Conflict, Failed }

/**
 * The Happy Agent secret form a Gen UI `secret` button opens (SPEC.md
 * "Secret actions"), as a sheet. It starts from the action's prefill and
 * the person may change all of it: the name, the description, and which
 * variables there are and what they are called. When the name is a stored
 * secret the form changes it, and a value left empty keeps what is stored.
 *
 * Saving sends the form once, through the artifact's actions route, under
 * a retry key that lives until the form changes. Values live in this
 * sheet's memory alone: never saved state, a log, or an error shown here.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GenUiSecretSheet(ask: SecretAsk, api: GenUiSecretApi, onSaved: (SecretSaved) -> Unit, onDismiss: () -> Unit) {
    val colors = HappyTheme.colors
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    // Deliberately not rememberSaveable: a typed value never reaches saved state.
    val draft = remember(ask) { SecretDraft(ask.prefill, ask.name ?: ask.prefill.id) }
    var checking by remember(ask) { mutableStateOf(false) }
    var saving by remember(ask) { mutableStateOf(false) }
    var tried by remember(ask) { mutableStateOf(false) }
    var trouble by remember(ask) { mutableStateOf<SaveTrouble?>(null) }
    var saved by remember(ask) { mutableStateOf<SecretSaved?>(null) }
    var retry by remember(ask) { mutableStateOf<String?>(null) }

    // The name decides whether the form makes a secret or changes one; asked again once typing settles.
    LaunchedEffect(draft) {
        var first = true
        snapshotFlow { draft.name }.collect { name ->
            if (!GenUiActions.SECRET_ID.matches(name)) {
                draft.adopt(null)
                checking = false
                return@collect
            }
            checking = true
            if (!first) delay(400)
            first = false
            val stored = try {
                api.read(name)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Unknown: saving as new is safe, as the route refuses to overwrite a secret the form didn't show.
                null
            }
            if (draft.name == name) draft.adopt(stored)
            checking = false
        }
    }
    // A form changed after a failed save is another save.
    LaunchedEffect(draft) {
        snapshotFlow { draft.form().let { it.secret.hashCode() to it.ifMatch } }.drop(1).collect { retry = null }
    }

    fun close() {
        draft.forget()
        onDismiss()
    }

    fun save() {
        tried = true
        if (draft.problems.isNotEmpty() || checking || saving) return
        saving = true
        trouble = null
        val id = retry ?: AgentClient.newId().also { retry = it }
        val changing = draft.changing
        scope.launch {
            try {
                val done = api.save(ask.artifactId, ask.version, ask.element, id, draft.form())
                draft.forget()
                retry = null
                saved = done
                onSaved(done)
            } catch (e: CancellationException) {
                throw e
            } catch (e: AgentApiException) {
                val current = StoredSecret.parse((e.body as? JsonObject)?.get("secret"))
                trouble = when {
                    e.status == 404 -> SaveTrouble.Unavailable
                    e.status == 400 -> SaveTrouble.Refused
                    e.status == 409 && current != null && current.id == draft.name -> {
                        draft.adopt(current)
                        retry = null
                        if (changing) SaveTrouble.Stale else SaveTrouble.Exists
                    }
                    e.status == 409 -> SaveTrouble.Conflict
                    else -> SaveTrouble.Failed
                }
            } catch (_: Exception) {
                trouble = SaveTrouble.Failed
            } finally {
                saving = false
            }
        }
    }

    TrackOverlay(true, ::close)
    ModalBottomSheet(
        onDismissRequest = ::close,
        sheetState = sheet,
        containerColor = colors.surface,
        modifier = Modifier.testTag(GenUiSecretTags.SHEET),
    ) {
        val done = saved
        if (done != null) {
            Completion(done) { scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss() } }
            return@ModalBottomSheet
        }
        val problems = if (tried) draft.problems else emptySet()
        Column(Modifier.fillMaxWidth().imePadding().navigationBarsPadding()) {
            Column(
                Modifier.weight(1f, fill = false).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = SecretSheetSpec.padding),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    stringResource(if (draft.changing) R.string.genui_secret_change else R.string.genui_secret_new),
                    style = SecretSheetSpec.title,
                    color = colors.text,
                    modifier = Modifier.testTag(GenUiSecretTags.MODE),
                )
                Text(stringResource(R.string.genui_secret_about), style = SecretSheetSpec.small, color = colors.textSecondary)

                Label(R.string.genui_secret_name)
                HappyTextField(
                    value = draft.name,
                    onValueChange = { draft.name = it.trim() },
                    placeholder = ask.prefill.id ?: "stripe",
                    textStyle = SecretSheetSpec.mono,
                    contentPadding = SecretSheetSpec.field,
                    minHeight = 44.dp,
                    cornerRadius = 8.dp,
                    singleLine = true,
                    enabled = !saving,
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Next),
                    modifier = Modifier.testTag(GenUiSecretTags.NAME),
                )
                when {
                    checking -> Note(stringResource(R.string.genui_secret_checking))
                    draft.existing?.changeable == false -> Problem(stringResource(R.string.genui_secret_managed))
                    SecretProblem.Name in problems -> Problem(stringResource(R.string.genui_secret_name_problem))
                }

                Label(R.string.genui_secret_description)
                HappyTextField(
                    value = draft.description,
                    onValueChange = draft::describe,
                    placeholder = stringResource(R.string.genui_secret_description_placeholder),
                    textStyle = SecretSheetSpec.body,
                    contentPadding = SecretSheetSpec.field,
                    minHeight = 44.dp,
                    cornerRadius = 8.dp,
                    enabled = !saving,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier.testTag(GenUiSecretTags.DESCRIPTION),
                )
                if (SecretProblem.Description in problems) Problem(stringResource(R.string.genui_secret_description_problem))

                Label(R.string.genui_secret_variables)
                draft.rows.forEachIndexed { index, row ->
                    key(row.key) {
                        VariableRow(draft, row, enabled = !saving, last = index == draft.rows.lastIndex)
                    }
                }
                Row(
                    Modifier
                        .testTag(GenUiSecretTags.ADD)
                        .clip(RoundedCornerShape(8.dp))
                        .clickable(enabled = !saving && draft.rows.size < SecretDraft.MAX_BUNDLE, role = Role.Button) { draft.add() }
                        .padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(Ionicon.Add, 18.dp, colors.textLink)
                    Text(stringResource(R.string.genui_secret_add_variable), style = SecretSheetSpec.label, color = colors.textLink)
                }
                when {
                    SecretProblem.NoVariables in problems -> Problem(stringResource(R.string.genui_secret_no_variables))
                    SecretProblem.VariableName in problems -> Problem(stringResource(R.string.genui_secret_variable_name_problem))
                    SecretProblem.VariableTwice in problems -> Problem(stringResource(R.string.genui_secret_variable_twice))
                    SecretProblem.Value in problems -> Problem(stringResource(R.string.genui_secret_value_problem))
                }
            }
            Column(
                Modifier.fillMaxWidth().padding(horizontal = SecretSheetSpec.padding, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                trouble?.let { Problem(stringResource(it.words)) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                    SheetButton(stringResource(R.string.common_cancel), GenUiSecretTags.CANCEL, enabled = !saving, background = colors.surfaceHigh, onClick = ::close)
                    SheetButton(
                        stringResource(R.string.common_save),
                        GenUiSecretTags.SAVE,
                        enabled = !saving && !checking && api.served && draft.existing?.changeable != false,
                        background = colors.surfaceHighest,
                        busy = saving,
                        onClick = ::save,
                    )
                }
            }
        }
    }
}

private val SaveTrouble.words: Int
    get() = when (this) {
        SaveTrouble.Stale -> R.string.genui_secret_stale
        SaveTrouble.Exists -> R.string.genui_secret_exists
        SaveTrouble.Refused -> R.string.genui_secret_refused
        SaveTrouble.Unavailable -> R.string.genui_secret_unavailable
        SaveTrouble.Conflict -> R.string.genui_secret_conflict
        SaveTrouble.Failed -> R.string.genui_secret_failed
    }

/**
 * One variable: its name, editable, the agent's hint under it, and its
 * value hidden as typed. A stored one changing says that empty keeps it.
 * The value field is labelled by the name beside it and shares nothing:
 * no autofill, no IME learning, and sensitive to anything but an
 * accessibility tool (as SecretRequestForm's fields).
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun VariableRow(draft: SecretDraft, row: SecretRow, enabled: Boolean, last: Boolean) {
    val colors = HappyTheme.colors
    val remove = stringResource(R.string.genui_secret_remove_variable, row.name)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(colors.surfaceHigh.copy(alpha = 0.5f))
            .padding(10.dp)
            .semantics { isTraversalGroup = true },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HappyTextField(
                value = row.name,
                onValueChange = { row.name = it.trim() },
                placeholder = stringResource(R.string.genui_secret_variable_placeholder),
                textStyle = SecretSheetSpec.mono,
                contentPadding = SecretSheetSpec.field,
                minHeight = 40.dp,
                cornerRadius = 8.dp,
                singleLine = true,
                enabled = enabled,
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Next),
                modifier = Modifier.weight(1f).testTag(GenUiSecretTags.VARIABLE),
            )
            Box(
                Modifier
                    .testTag(GenUiSecretTags.REMOVE)
                    .size(40.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(enabled = enabled, role = Role.Button) { draft.remove(row) }
                    .semantics { contentDescription = remove },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Ionicon.Close, 20.dp, colors.textSecondary)
            }
        }
        row.hint?.let { Text(it, style = SecretSheetSpec.small, color = colors.textSecondary) }
        HappyTextField(
            value = row.value,
            onValueChange = { row.value = it },
            placeholder = stringResource(if (draft.changing && row.keeps) R.string.genui_secret_value_keep else R.string.genui_secret_value_placeholder),
            textStyle = SecretSheetSpec.body,
            contentPadding = SecretSheetSpec.field,
            minHeight = 44.dp,
            cornerRadius = 8.dp,
            enabled = enabled,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                imeAction = if (last) ImeAction.Done else ImeAction.Next,
                autoCorrectEnabled = false,
            ),
            singleLine = true,
            modifier = Modifier
                .testTag(GenUiSecretTags.VALUE)
                .semantics {
                    contentDescription = row.name
                    contentDataType = ContentDataType.None
                    isSensitiveData = true
                },
        )
    }
}

/** Saved: what the response says was made or changed, and the names the agent may now use. */
@Composable
private fun Completion(saved: SecretSaved, onDone: () -> Unit) {
    val colors = HappyTheme.colors
    Column(
        Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = SecretSheetSpec.padding).padding(bottom = 12.dp).testTag(GenUiSecretTags.DONE),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Ionicon.CheckmarkCircle, 24.dp, colors.success)
            Text(
                stringResource(if (saved.created) R.string.genui_secret_added else R.string.genui_secret_updated, saved.secret.id),
                style = SecretSheetSpec.title,
                color = colors.text,
            )
        }
        Text(
            stringResource(R.string.genui_secret_told, saved.secret.variables.joinToString(", ")),
            style = SecretSheetSpec.body,
            color = colors.textSecondary,
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            SheetButton(stringResource(R.string.genui_secret_done), GenUiSecretTags.DONE + ".close", enabled = true, background = colors.surfaceHighest, onClick = onDone)
        }
    }
}

@Composable
private fun Label(words: Int) = Text(stringResource(words), style = SecretSheetSpec.label, color = HappyTheme.colors.textSecondary, modifier = Modifier.padding(top = 8.dp))

@Composable
private fun Note(words: String) = Text(words, style = SecretSheetSpec.small, color = HappyTheme.colors.textSecondary)

@Composable
private fun Problem(words: String) = Text(words, style = SecretSheetSpec.small, color = HappyTheme.colors.textDestructive, modifier = Modifier.testTag(GenUiSecretTags.PROBLEM))

@Composable
private fun SheetButton(label: String, tag: String, enabled: Boolean, background: Color, busy: Boolean = false, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    Box(
        modifier = Modifier
            .testTag(tag)
            .alpha(if (enabled || busy) 1f else 0.5f)
            .clip(RoundedCornerShape(8.dp))
            .background(background)
            .clickable(enabled = enabled && !busy, role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        ShimmerText(
            label,
            style = SecretSheetSpec.label,
            baseColor = ShimmerSpec.rest(colors.text, background),
            highlightColor = colors.text,
            shimmering = busy,
            stillColor = colors.text,
        )
    }
}
