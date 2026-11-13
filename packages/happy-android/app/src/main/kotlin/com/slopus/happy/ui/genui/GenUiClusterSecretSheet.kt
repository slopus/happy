package com.slopus.happy.ui.genui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.genui.ClusterSecretKind
import com.slopus.happy.ui.components.HappySwitch
import com.slopus.happy.ui.components.HappyTextField
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Segment
import com.slopus.happy.ui.components.SegmentedTabs
import com.slopus.happy.ui.components.TrackOverlay
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

object GenUiClusterTags {
    const val SHEET = "genui.cluster"
    const val OWNER = "genui.cluster.owner."
    const val HOST = "genui.cluster.host"
    const val PATH = "genui.cluster.path"
    const val HEADER = "genui.cluster.header"
    const val PREFIX = "genui.cluster.prefix"
    const val HOSTS = "genui.cluster.hosts"
    const val SERVER = "genui.cluster.server"
    const val METHOD = "genui.cluster.method."
    const val USERNAME = "genui.cluster.username"
    const val REPOS = "genui.cluster.repos"
    const val OPERATION = "genui.cluster.operation."
    const val MCP = "genui.cluster.mcp"
    const val ADD_TARGET = "genui.cluster.add.target"
    const val ADD_HEADER = "genui.cluster.add.header"
}

/** A `cluster_secret` button tapped: which version and element, the secret type, and the action's prefill. */
@Immutable
data class ClusterAsk(val artifactId: String, val version: Int, val element: String, val kind: ClusterSecretKind, val prefill: JsonObject)

/** What the person is told after a failed save; the cluster's own words where it gave some. */
private sealed interface ClusterTrouble {
    data class Said(val words: String) : ClusterTrouble
    data object Stale : ClusterTrouble
    data object Gone : ClusterTrouble
    data object NoOrigin : ClusterTrouble
    data object Failed : ClusterTrouble
}

/**
 * The Happy Cloud secret form a Gen UI `cluster_secret` button opens
 * (cluster API.md "Gen UI actions"), as a sheet: the action's type, its
 * prefill as the starting point, every field the person's to change. An
 * action naming a stored secret opens on that one to change it.
 *
 * Saving sends the form once through the artifact's actions route, which
 * stores it, grants it to the origin agent and tells that agent, under a
 * retry key that lives until the form changes. Values live in this sheet's
 * memory alone: never saved state, a log, or an error shown here.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GenUiClusterSecretSheet(ask: ClusterAsk, api: GenUiSecretApi, onSaved: (ClusterSaved) -> Unit, onDismiss: () -> Unit) {
    val colors = HappyTheme.colors
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    // Deliberately not rememberSaveable: a typed value never reaches saved state.
    val draft = remember(ask) { ClusterSecretDraft(ask.kind, ask.prefill) }
    val named = remember(ask) { (ask.prefill["id"] as? JsonPrimitive)?.content }
    var loading by remember(ask) { mutableStateOf(true) }
    var unopened by remember(ask) { mutableStateOf<Int?>(null) }
    var saving by remember(ask) { mutableStateOf(false) }
    var tried by remember(ask) { mutableStateOf(false) }
    var trouble by remember(ask) { mutableStateOf<ClusterTrouble?>(null) }
    var saved by remember(ask) { mutableStateOf<ClusterSaved?>(null) }
    var retry by remember(ask) { mutableStateOf<String?>(null) }

    // A new secret needs whom it may be for; a named one, the stored secret it changes.
    LaunchedEffect(draft) {
        try {
            if (named != null) {
                val stored = api.clusterSecret(named)
                if (stored == null || stored.kind != ask.kind) unopened = R.string.genui_cluster_missing else draft.adopt(stored)
            } else {
                draft.allow(api.clusterOwners())
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            unopened = R.string.genui_cluster_load_failed
        }
        loading = false
    }
    // A form changed after a failed save is another save.
    LaunchedEffect(draft) {
        snapshotFlow { draft.form().hashCode() }.drop(1).collect { retry = null }
    }

    fun close() {
        draft.forget()
        onDismiss()
    }

    fun save() {
        tried = true
        if (draft.problems.isNotEmpty() || loading || unopened != null || saving) return
        saving = true
        trouble = null
        val id = retry ?: AgentClient.newId().also { retry = it }
        scope.launch {
            try {
                val done = api.saveCluster(ask.artifactId, ask.version, ask.element, id, draft.form())
                draft.forget()
                retry = null
                saved = done
                onSaved(done)
            } catch (e: CancellationException) {
                throw e
            } catch (e: AgentApiException) {
                val current = ClusterStored.parse((e.body as? JsonObject)?.get("secret"))
                trouble = when {
                    e.status == 404 -> ClusterTrouble.Gone
                    e.status == 409 && e.code == "no_origin" -> ClusterTrouble.NoOrigin
                    e.status == 409 && current != null && draft.changing -> {
                        draft.adopt(current)
                        retry = null
                        ClusterTrouble.Stale
                    }
                    e.status == 409 -> {
                        retry = null
                        ClusterTrouble.Failed
                    }
                    // The cluster says no value in an answer; its 400 and 403 words name what to fix.
                    (e.status == 400 || e.status == 403) && !e.message.isNullOrBlank() -> ClusterTrouble.Said(e.message!!)
                    else -> ClusterTrouble.Failed
                }
            } catch (_: Exception) {
                trouble = ClusterTrouble.Failed
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
        modifier = Modifier.testTag(GenUiClusterTags.SHEET),
    ) {
        val done = saved
        if (done != null) {
            Saved(
                stringResource(R.string.genui_cluster_saved, done.secret?.name ?: draft.name.trim()),
                stringResource(R.string.genui_cluster_told),
            ) { scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss() } }
            return@ModalBottomSheet
        }
        val problems = if (tried) draft.problems else emptySet()
        val enabled = !saving && !loading && unopened == null
        Column(Modifier.fillMaxWidth().imePadding().navigationBarsPadding()) {
            Column(
                Modifier.weight(1f, fill = false).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = SecretSheetSpec.padding),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    stringResource(if (draft.changing) R.string.genui_secret_change else ask.kind.title),
                    style = SecretSheetSpec.title,
                    color = colors.text,
                    modifier = Modifier.testTag(GenUiSecretTags.MODE),
                )
                Text(stringResource(R.string.genui_cluster_about), style = SecretSheetSpec.small, color = colors.textSecondary)
                when {
                    loading -> Note(stringResource(R.string.genui_cluster_loading))
                    unopened != null -> Problem(stringResource(unopened!!))
                    ClusterProblem.Unchangeable in draft.problems -> Problem(stringResource(R.string.genui_cluster_unchangeable))
                }

                if (!draft.changing && draft.owners.size > 1) {
                    Label(R.string.genui_cluster_owner)
                    SegmentedTabs(
                        draft.owners.map { Segment(stringResource(it.words), GenUiClusterTags.OWNER + it.wire) },
                        draft.owners.indexOf(draft.owner),
                        { if (enabled) draft.owner = draft.owners[it] },
                    )
                }
                if (!loading && unopened == null && ClusterProblem.Owner in draft.problems) Problem(stringResource(R.string.genui_cluster_owner_problem))

                Label(R.string.genui_secret_name)
                Field(draft.name, { draft.name = it }, stringResource(R.string.genui_cluster_name_placeholder), GenUiSecretTags.NAME, enabled, words = true)
                if (ClusterProblem.Name in problems) Problem(stringResource(R.string.genui_cluster_name_problem))

                Label(R.string.genui_secret_description)
                Field(draft.description, { draft.description = it }, stringResource(R.string.genui_secret_description_placeholder), GenUiSecretTags.DESCRIPTION, enabled, words = true, singleLine = false)
                if (ClusterProblem.Description in problems) Problem(stringResource(R.string.genui_cluster_description_problem))

                when (ask.kind) {
                    ClusterSecretKind.Endpoint -> EndpointFields(draft, problems, enabled)
                    ClusterSecretKind.SshKey -> KeyFields(draft, problems, enabled, hosts = true)
                    ClusterSecretKind.GitCredential -> GitFields(draft, problems, enabled)
                    ClusterSecretKind.Environment -> EnvironmentFields(draft, problems, enabled)
                }
            }
            Column(
                Modifier.fillMaxWidth().padding(horizontal = SecretSheetSpec.padding, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                trouble?.let { Problem(it.words()) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                    SheetButton(stringResource(R.string.common_cancel), GenUiSecretTags.CANCEL, enabled = !saving, background = colors.surfaceHigh, onClick = ::close)
                    SheetButton(
                        stringResource(R.string.common_save),
                        GenUiSecretTags.SAVE,
                        enabled = enabled && api.served && ClusterProblem.Unchangeable !in draft.problems,
                        background = colors.surfaceHighest,
                        busy = saving,
                        onClick = ::save,
                    )
                }
            }
        }
    }
}

/** Where an endpoint's values go and the headers they ride in; changing, only the values. */
@Composable
private fun EndpointFields(draft: ClusterSecretDraft, problems: Set<ClusterProblem>, enabled: Boolean) {
    if (!draft.changing) {
        Label(R.string.genui_cluster_targets)
        draft.targets.forEach { target ->
            key(target.key) {
                FieldPair(
                    1.6f,
                    { Field(target.host, { target.host = it.trim() }, "api.example.com", GenUiClusterTags.HOST, enabled, mono = true, modifier = it) },
                    { Field(target.path, { target.path = it }, "/v1", GenUiClusterTags.PATH, enabled, mono = true, modifier = it) },
                    if (draft.targets.size > 1) ({ RemoveButton(stringResource(R.string.genui_secret_remove_variable, target.host), enabled) { draft.targets.remove(target) } }) else null,
                )
                if (target.methods.isNotEmpty()) Note(stringResource(R.string.genui_cluster_methods, target.methods.joinToString(", ")))
            }
        }
        Add(R.string.genui_cluster_add_target, GenUiClusterTags.ADD_TARGET, enabled && draft.targets.size < ClusterSecretDraft.MAX_TARGETS, draft::addTarget)
        if (ClusterProblem.Targets in problems) Problem(stringResource(R.string.genui_cluster_targets_problem))
    }

    Label(R.string.genui_cluster_headers)
    draft.headers.forEachIndexed { index, row ->
        key(row.key) {
            Group {
                if (draft.changing) {
                    Text(row.name + row.prefix.let { if (it.isEmpty()) "" else "  ·  $it" }, style = SecretSheetSpec.mono, color = HappyTheme.colors.text)
                } else {
                    FieldPair(
                        1.3f,
                        { Field(row.name, { row.name = it.trim() }, stringResource(R.string.genui_cluster_header_placeholder), GenUiClusterTags.HEADER, enabled, mono = true, modifier = it) },
                        { Field(row.prefix, { row.prefix = it }, stringResource(R.string.genui_cluster_prefix_placeholder), GenUiClusterTags.PREFIX, enabled, mono = true, modifier = it) },
                        if (draft.headers.size > 1) ({ RemoveButton(stringResource(R.string.genui_secret_remove_variable, row.name), enabled) { draft.headers.remove(row) } }) else null,
                    )
                }
                MaskedField(row.value, { row.value = it }, valueHint(draft.changing), label = row.name, enabled = enabled, last = index == draft.headers.lastIndex)
            }
        }
    }
    if (!draft.changing) Add(R.string.genui_cluster_add_header, GenUiClusterTags.ADD_HEADER, enabled && draft.headers.size < ClusterSecretDraft.MAX_HEADERS, draft::addHeader)
    when {
        ClusterProblem.Headers in problems -> Problem(stringResource(R.string.genui_cluster_headers_problem))
        ClusterProblem.Value in problems -> Problem(stringResource(R.string.genui_cluster_value_problem))
    }
    if (!draft.changing) Toggle(R.string.genui_cluster_mcp, GenUiClusterTags.MCP, draft.mcp, enabled) { draft.mcp = it }
}

/** An SSH key: the hosts it opens when new ([hosts]), then the key and its passphrase. */
@Composable
private fun KeyFields(draft: ClusterSecretDraft, problems: Set<ClusterProblem>, enabled: Boolean, hosts: Boolean) {
    if (hosts && !draft.changing) {
        Label(R.string.genui_cluster_hosts)
        Field(draft.hosts, { draft.hosts = it }, "github.com, *.example.com", GenUiClusterTags.HOSTS, enabled, mono = true)
        if (ClusterProblem.Hosts in problems) Problem(stringResource(R.string.genui_cluster_hosts_problem))
    }
    Label(R.string.genui_cluster_private_key)
    MaskedField(draft.privateKey, { draft.privateKey = it }, if (draft.changing) stringResource(R.string.genui_secret_value_keep) else "-----BEGIN OPENSSH PRIVATE KEY-----", label = stringResource(R.string.genui_cluster_private_key), enabled = enabled, multiline = true)
    if (ClusterProblem.Key in problems) Problem(stringResource(R.string.genui_cluster_key_problem))
    MaskedField(draft.passphrase, { draft.passphrase = it }, stringResource(R.string.genui_cluster_passphrase), label = stringResource(R.string.genui_cluster_passphrase), enabled = enabled, last = true)
}

/** A git credential: the server, how it signs in and what it may do when new, then its value. */
@Composable
private fun GitFields(draft: ClusterSecretDraft, problems: Set<ClusterProblem>, enabled: Boolean) {
    if (!draft.changing) {
        Label(R.string.genui_cluster_server)
        Field(draft.server, { draft.server = it.trim() }, "github.com", GenUiClusterTags.SERVER, enabled, mono = true)
        if (ClusterProblem.Server in problems) Problem(stringResource(R.string.genui_cluster_server_problem))

        Label(R.string.genui_cluster_method)
        SegmentedTabs(
            GitMethod.entries.map { Segment(stringResource(it.words), GenUiClusterTags.METHOD + it.wire) },
            GitMethod.entries.indexOf(draft.method),
            { if (enabled) draft.method = GitMethod.entries[it] },
        )
        if (draft.method != GitMethod.SshKey) {
            Label(R.string.genui_cluster_username)
            Field(draft.username, { draft.username = it.trim() }, "git", GenUiClusterTags.USERNAME, enabled, mono = true)
            if (ClusterProblem.Username in problems) Problem(stringResource(R.string.genui_cluster_username_problem))
        }
        Label(R.string.genui_cluster_repos)
        Field(draft.repos, { draft.repos = it }, "acme/api, acme/web", GenUiClusterTags.REPOS, enabled, mono = true)

        Label(R.string.genui_cluster_operations)
        GitOperation.entries.filter { it != GitOperation.Sign || draft.method == GitMethod.SshKey }.forEach { op ->
            Toggle(op.words, GenUiClusterTags.OPERATION + op.wire, op in draft.operations, enabled) { draft.toggle(op) }
        }
        if (ClusterProblem.Operations in problems) Problem(stringResource(R.string.genui_cluster_operations_problem))
    }
    when (draft.method) {
        GitMethod.SshKey -> KeyFields(draft, problems, enabled, hosts = false)
        GitMethod.Password, GitMethod.Token -> {
            val words = draft.method.words
            Label(words)
            val value = if (draft.method == GitMethod.Password) draft.password else draft.token
            MaskedField(
                value,
                { if (draft.method == GitMethod.Password) draft.password = it else draft.token = it },
                valueHint(draft.changing),
                label = stringResource(words),
                enabled = enabled,
                last = true,
            )
            if (ClusterProblem.Value in problems) Problem(stringResource(R.string.genui_cluster_value_problem))
        }
    }
}

/** An environment secret's variables; changing, their values only. */
@Composable
private fun EnvironmentFields(draft: ClusterSecretDraft, problems: Set<ClusterProblem>, enabled: Boolean) {
    Label(R.string.genui_secret_variables)
    draft.variables.forEachIndexed { index, row ->
        key(row.key) {
            Group {
                if (draft.changing) {
                    Text(row.name, style = SecretSheetSpec.mono, color = HappyTheme.colors.text)
                } else {
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
                        if (draft.variables.size > 1) RemoveButton(stringResource(R.string.genui_secret_remove_variable, row.name), enabled) { draft.variables.remove(row) }
                    }
                }
                MaskedField(row.value, { row.value = it }, valueHint(draft.changing), label = row.name, enabled = enabled, last = index == draft.variables.lastIndex)
            }
        }
    }
    if (!draft.changing) Add(R.string.genui_secret_add_variable, GenUiSecretTags.ADD, enabled, draft::addVariable)
    when {
        ClusterProblem.NoVariables in problems -> Problem(stringResource(R.string.genui_secret_no_variables))
        ClusterProblem.VariableName in problems -> Problem(stringResource(R.string.genui_secret_variable_name_problem))
        ClusterProblem.VariableTwice in problems -> Problem(stringResource(R.string.genui_secret_variable_twice))
        ClusterProblem.Value in problems -> Problem(stringResource(R.string.genui_cluster_value_problem))
    }
    if (!draft.changing) Toggle(R.string.genui_cluster_mcp, GenUiClusterTags.MCP, draft.mcp, enabled) { draft.mcp = it }
}

@Composable
private fun valueHint(changing: Boolean): String = stringResource(if (changing) R.string.genui_secret_value_keep else R.string.genui_secret_value_placeholder)

/** A plain field of the form: [mono] for hosts and names, [words] for a sentence's capitals and correction. */
@Composable
private fun Field(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    tag: String,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    words: Boolean = false,
    singleLine: Boolean = true,
) = HappyTextField(
    value = value,
    onValueChange = onValueChange,
    placeholder = placeholder,
    textStyle = if (mono) SecretSheetSpec.mono else SecretSheetSpec.body,
    contentPadding = SecretSheetSpec.field,
    minHeight = 44.dp,
    cornerRadius = 8.dp,
    singleLine = singleLine,
    enabled = enabled,
    keyboardOptions = if (words) {
        KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = if (singleLine) ImeAction.Next else ImeAction.Default)
    } else {
        KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next)
    },
    modifier = modifier.testTag(tag),
)

/**
 * Two fields that belong together, such as a host and its paths: side by
 * side, [weight] to 1, or one under the other at a large font scale, where
 * side by side neither shows a host whole.
 */
@Composable
private fun FieldPair(weight: Float, first: @Composable (Modifier) -> Unit, second: @Composable (Modifier) -> Unit, remove: (@Composable () -> Unit)?) {
    if (LocalDensity.current.fontScale < 1.5f) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            first(Modifier.weight(weight))
            second(Modifier.weight(1f))
            remove?.invoke()
        }
    } else {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                first(Modifier)
                second(Modifier)
            }
            remove?.invoke()
        }
    }
}

/** One header or variable: its name and its hidden value, read as one by a screen reader. */
@Composable
private fun Group(content: @Composable () -> Unit) = Column(
    Modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(10.dp))
        .background(HappyTheme.colors.surfaceHigh.copy(alpha = 0.5f))
        .padding(10.dp)
        .semantics { isTraversalGroup = true },
    verticalArrangement = Arrangement.spacedBy(6.dp),
) { content() }

@Composable
private fun Add(words: Int, tag: String, enabled: Boolean, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    Row(
        Modifier
            .testTag(tag)
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(Ionicon.Add, 18.dp, colors.textLink)
        Text(stringResource(words), style = SecretSheetSpec.label, color = colors.textLink)
    }
}

@Composable
private fun Toggle(words: Int, tag: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    val label = stringResource(words)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = SecretSheetSpec.body, color = HappyTheme.colors.text, modifier = Modifier.weight(1f))
        HappySwitch(checked, onChange, Modifier.testTag(tag), enabled = enabled, label = label)
    }
}

@Composable
private fun ClusterTrouble.words(): String = when (this) {
    is ClusterTrouble.Said -> words
    ClusterTrouble.Stale -> stringResource(R.string.genui_secret_stale)
    ClusterTrouble.Gone -> stringResource(R.string.genui_cluster_gone)
    ClusterTrouble.NoOrigin -> stringResource(R.string.genui_cluster_no_origin)
    ClusterTrouble.Failed -> stringResource(R.string.genui_secret_failed)
}

private val ClusterSecretKind.title: Int
    get() = when (this) {
        ClusterSecretKind.Endpoint -> R.string.genui_cluster_new_endpoint
        ClusterSecretKind.SshKey -> R.string.genui_cluster_new_ssh_key
        ClusterSecretKind.GitCredential -> R.string.genui_cluster_new_git
        ClusterSecretKind.Environment -> R.string.genui_cluster_new_environment
    }

private val ClusterOwner.words: Int
    get() = when (this) {
        ClusterOwner.Me -> R.string.genui_cluster_owner_me
        ClusterOwner.Team -> R.string.genui_cluster_owner_team
    }

private val GitMethod.words: Int
    get() = when (this) {
        GitMethod.SshKey -> R.string.genui_cluster_method_ssh_key
        GitMethod.Password -> R.string.genui_cluster_method_password
        GitMethod.Token -> R.string.genui_cluster_method_token
    }

private val GitOperation.words: Int
    get() = when (this) {
        GitOperation.Read -> R.string.genui_cluster_operation_read
        GitOperation.Write -> R.string.genui_cluster_operation_write
        GitOperation.Sign -> R.string.genui_cluster_operation_sign
    }
