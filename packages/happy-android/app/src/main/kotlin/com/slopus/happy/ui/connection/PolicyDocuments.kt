package com.slopus.happy.ui.connection

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.Permission
import com.slopus.happy.agent.PolicyDocument
import com.slopus.happy.agent.PolicyDocumentSource
import com.slopus.happy.agent.ServerPermissions
import com.slopus.happy.agent.Surface
import com.slopus.happy.agent.SurfaceCatalog
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** One of a Happy Cloud server's policy documents ([PolicyDocument.id]). */
@Serializable data class PolicyDocumentRoute(val connectionId: String, val document: String)

object PolicyDocumentTags {
    const val TEXT = "policy.text"
    const val NOTE = "policy.note"
    const val SAVE = "policy.save"
    const val RETRY = "policy.retry"
    fun row(document: PolicyDocument) = "policy.row.${document.id}"
}

/** Where a Cloud instructions link goes: the settings' document, the Policy vault, or nowhere yet. */
internal sealed interface InstructionsPlace {
    data object Document : InstructionsPlace
    data class Vault(val surface: Surface) : InstructionsPlace
    data class Missing(val loading: Boolean) : InstructionsPlace
}

/**
 * The settings' Instructions wherever the server serves them ([PolicyDocument.served]);
 * never by whether a Policy vault exists, which new teams don't have.
 */
internal fun instructionsPlace(permissions: ServerPermissions, catalog: SurfaceCatalog): InstructionsPlace {
    if (PolicyDocument.served(permissions)) return InstructionsPlace.Document
    // FALLBACK (servers deployed before /v0/config/instructions, no policy.edit in their
    // catalog): the instructions are documents in the flagged Policy vault, as before.
    // Delete once every server serves them.
    return policyVault(catalog)?.let(InstructionsPlace::Vault) ?: InstructionsPlace.Missing(loading = !catalog.loaded)
}

@Composable
internal fun PolicyDocumentPage(graph: AppGraph, nav: NavHostController, connectionId: String, document: PolicyDocument) {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) } ?: return
    val scope = rememberCoroutineScope()
    val source = remember(session, document, scope) {
        PolicyDocumentSource({ document.read(session.client) }, { document.write(session.client, it) }, session.events, scope)
    }
    val permissions by session.permissions.collectAsStateWithLifecycle()
    PolicyDocumentScreen(
        document = document,
        source = source,
        editable = permissions.allows(Permission.POLICY_EDIT),
        onBack = { nav.popBackStack() },
    )
}

/**
 * A policy document as plain text the size of the screen, as iOS has it:
 * a note on what it is above it; Save in the bar for those granted
 * `policy.edit`, read-only with "Only owners can change this. Agents
 * can't." for everyone else. Back with unsaved changes asks first.
 */
@Composable
internal fun PolicyDocumentScreen(document: PolicyDocument, source: PolicyDocumentSource, editable: Boolean, onBack: () -> Unit) {
    val state by source.current.collectAsStateWithLifecycle()
    // What was typed; null while the page shows the server's text as it is.
    var draft by rememberSaveable(document) { mutableStateOf<String?>(null) }
    var asking by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val saved = state.saved
    val text = draft ?: saved.orEmpty()
    val dirty = saved != null && draft != null && draft != saved
    val tooLong = text.encodeToByteArray().size > document.limit
    source.typing = { dirty }
    val leave = { if (dirty) asking = true else onBack() }
    BackHandler(enabled = dirty) { asking = true }
    val colors = HappyTheme.colors
    val title = stringResource(if (document == PolicyDocument.Instructions) R.string.policy_instructions else R.string.policy_security)
    Screen(
        header = {
            StackHeader(title, leave) {
                if (editable && saved != null) {
                    TextButton(
                        onClick = { scope.launch { if (source.save(text)) draft = null } },
                        enabled = dirty && !tooLong && !state.saving,
                        modifier = Modifier.testTag(PolicyDocumentTags.SAVE),
                    ) { Text(stringResource(R.string.common_save)) }
                } else if (state.failed) {
                    TextButton(onClick = source::load, modifier = Modifier.testTag(PolicyDocumentTags.RETRY)) { Text(stringResource(R.string.policy_try_again)) }
                }
            }
        },
        avoidKeyboard = true,
        ground = colors.surface,
    ) {
        Column(Modifier.fillMaxSize()) {
            val about = stringResource(if (document == PolicyDocument.Instructions) R.string.policy_about_instructions else R.string.policy_about_security)
            val (note, warning) = when {
                state.problem == PolicyDocumentSource.Problem.NotAllowed -> stringResource(R.string.policy_not_allowed) to true
                state.problem == PolicyDocumentSource.Problem.TooLong || tooLong -> stringResource(R.string.policy_too_long, document.limit / 1024) to true
                state.problem == PolicyDocumentSource.Problem.Failed -> stringResource(R.string.policy_save_failed) to true
                state.failed -> stringResource(R.string.policy_load_failed) to true
                saved == null -> "" to false
                saved.isEmpty() && !editable -> "${stringResource(R.string.policy_empty)} $about" to false
                editable -> about to false
                else -> "$about ${stringResource(R.string.policy_owners_only)}" to false
            }
            if (note.isNotEmpty()) {
                Text(
                    note,
                    style = happyTextStyle(fontSize = 13, lineHeight = 18),
                    color = if (warning) colors.textDestructive else colors.textSecondary,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag(PolicyDocumentTags.NOTE),
                )
            }
            if (saved == null) {
                if (!state.failed) {
                    Box(Modifier.fillMaxWidth().padding(top = 32.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(strokeWidth = 2.dp, color = colors.textSecondary)
                    }
                }
            } else {
                BasicTextField(
                    value = text,
                    onValueChange = { draft = it; source.clearProblem() },
                    readOnly = !editable || state.saving,
                    textStyle = happyTextStyle(fontSize = 15, lineHeight = 22).copy(fontFamily = FontFamily.Monospace, color = colors.text),
                    cursorBrush = SolidColor(colors.textLink),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth().weight(1f).padding(PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp)).testTag(PolicyDocumentTags.TEXT),
                )
            }
        }
    }
    if (asking) {
        HappyAlert(
            Alert(
                stringResource(R.string.policy_discard_title),
                buttons = listOf(
                    AlertButton(stringResource(R.string.policy_keep_editing)),
                    AlertButton(stringResource(R.string.policy_discard), destructive = true) { onBack() },
                ),
            ),
            onDismiss = { asking = false },
        )
    }
}
