package com.slopus.happy.ui.vaults

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.slopus.happy.R
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.Problem
import com.slopus.happy.ui.artifacts.PlaceMessage
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.components.barInsetTop
import com.slopus.happy.ui.conversation.problemText
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.surfaces.SeedlingEmpty
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.vaults.VaultActivity
import com.slopus.happy.vaults.VaultEvent
import com.slopus.happy.vaults.VaultLocation
import com.slopus.happy.vaults.VaultNames
import com.slopus.happy.vaults.VaultPreview
import com.slopus.happy.vaults.VaultVersion
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

object VaultHistoryTags {
    const val SCREEN = "vault.history"
    const val VERSION = "vault.history.version"
    const val ACTIVITY = "vault.history.activity"
    const val PIN = "vault.history.pin"
    fun version(number: Int) = "vault.history.version.$number"
}

/**
 * A history row (iOS's document history row): a 36 badge 16 in, 12 to
 * the words, 10 above and below, the line 2 under the title.
 */
object VaultHistorySpec {
    val badge = 36.dp
    val padding = 16.dp
    val vertical = 10.dp
    val gap = 12.dp
}

internal class VaultHistoryModel(val session: AgentSession, val surfaceId: String, val itemId: String, val folder: Boolean) : ViewModel() {
    data class State(
        val location: VaultLocation? = null,
        val versions: List<VaultVersion>? = null,
        val activity: List<VaultActivity>? = null,
        /** People by ID, agents by ID, folders by ID (null: the root). */
        val people: Map<String, String> = emptyMap(),
        val agents: Map<String, String> = emptyMap(),
        val folders: Map<String, String> = emptyMap(),
        val error: Problem? = null,
        val gone: Boolean = false,
    )

    private val stateFlow = MutableStateFlow(State())
    val state: StateFlow<State> = stateFlow.asStateFlow()

    init {
        viewModelScope.launch {
            read()
            session.vaults.events.collect { event ->
                when {
                    event is VaultEvent.Resync -> read()
                    event is VaultEvent.Updated && event.itemId == itemId -> read()
                    event is VaultEvent.Known && event.item.id == itemId -> read()
                    event is VaultEvent.VersionPinned && event.fileId == itemId -> {
                        stateFlow.update { state ->
                            state.copy(versions = state.versions?.map { if (it.number == event.number) it.copy(pinned = event.pinned) else it })
                        }
                        // A pin is also a line of the activity.
                        read()
                    }
                    event is VaultEvent.Removed && event.itemId == itemId -> stateFlow.update { it.copy(gone = true) }
                }
            }
        }
    }

    fun pin(version: VaultVersion) {
        viewModelScope.launch {
            try {
                val answer = session.vaults.routes.pin(surfaceId, itemId, version.number, !version.pinned)
                stateFlow.update { state -> state.copy(versions = state.versions?.map { if (it.number == answer.number) answer else it }) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                stateFlow.update { it.copy(error = Conversation.describe(e)) }
            }
        }
    }

    fun dismissError() = stateFlow.update { it.copy(error = null) }

    private suspend fun read() {
        val routes = session.vaults.routes
        try {
            val location = routes.location(surfaceId, itemId, folder)
            val versions = if (location.item.isFolder) emptyList() else routes.versions(surfaceId, itemId).items
            val activity = routes.activity(surfaceId, itemId, folder).items
            stateFlow.update { it.copy(location = location, versions = versions, activity = activity, gone = false) }
            names(versions, activity)
        } catch (e: CancellationException) {
            throw e
        } catch (e: AgentApiException) {
            if (e.status == 404) stateFlow.update { it.copy(gone = true) }
            else if (stateFlow.value.versions == null) stateFlow.update { it.copy(error = Conversation.describe(e)) }
        } catch (e: Exception) {
            if (stateFlow.value.versions == null) stateFlow.update { it.copy(error = Conversation.describe(e)) }
        }
    }

    /** The people, agents and folders the history names, by name. */
    private suspend fun names(versions: List<VaultVersion>, activity: List<VaultActivity>) {
        val actors = versions.map { it.actor } + activity.map { it.actor }
        val people = actors.mapNotNull { it.userId }.toSet()
        val catalog = session.catalog.value
        val agents = actors.mapNotNull { it.agentId }.toSet().mapNotNull { id -> catalog.agent(id)?.title?.takeIf { it.isNotBlank() }?.let { id to it } }.toMap()
        val known = stateFlow.value.folders
        val folderIds = activity.flatMap { listOf(it.parentId, it.fromParentId, it.toParentId) }.filterNotNull().toSet() - known.keys
        val folders = coroutineScope {
            folderIds.take(20).map { id ->
                async { runCatching { session.vaults.routes.location(surfaceId, id, folder = true).item.name }.getOrNull()?.let { id to it } }
            }.awaitAll().filterNotNull().toMap()
        }
        val names = try {
            if (people.isEmpty()) emptyMap() else session.team.names(people)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyMap()
        }
        stateFlow.update { it.copy(people = it.people + names, agents = it.agents + agents, folders = it.folders + folders) }
    }
}

/**
 * An entry's history: its surviving versions newest first (who made each
 * and how, when, how big, pinned, which it restored), then its activity
 * (made, renamed, moved, put in the Trash and back, versions made and
 * pinned), live. A version's menu previews it, restores it as the newest
 * (history only grows), pins or unpins it, or saves it to the phone. A
 * folder has activity alone.
 */
@Composable
fun VaultHistoryScreen(session: AgentSession, surfaceId: String, itemId: String, folder: Boolean, name: String, onBack: () -> Unit, open: (Any) -> Unit) {
    val model = viewModel(key = "vault-history:${session.connectionId}:$itemId") { VaultHistoryModel(session, surfaceId, itemId, folder) }
    val state by model.state.collectAsStateWithLifecycle()
    val actions = rememberVaultActions(session, surfaceId, open)
    val entry = state.location?.item
    var viewing by remember { mutableStateOf<Int?>(null) }
    PlaceScaffold(stringResource(R.string.vaults_history), onBack, VaultHistoryTags.SCREEN, subtitle = entry?.shownName ?: VaultNames.shown(name)) {
        val versions = state.versions
        val activity = state.activity
        when {
            state.gone -> SeedlingEmpty(stringResource(R.string.vaults_entry_gone))
            versions == null || activity == null || entry == null ->
                if (state.error != null) Column(Modifier.padding(top = barInsetTop())) { PlaceMessage(problemText(state.error!!)) } else LoadingIndicator()
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = barInsetTop(), bottom = 32.dp)) {
                if (!entry.isFolder) {
                    item(key = "versions") { SectionTitle(stringResource(R.string.vaults_versions)) }
                    items(versions, key = { "v${it.number}" }) { version ->
                        val current = version.number == entry.latestVersion
                        VersionRow(
                            version, current, vaultActor(version.actor, state.people, state.agents),
                            onPreview = {
                                if (VaultPreview.inViewer(entry)) viewing = version.number
                                else open(VaultFileRoute(session.connectionId, surfaceId, itemId, if (current) null else version.number, entry.shownName))
                            },
                            onRestore = if (current || state.location?.inTrash == true) null else ({ actions.restoreVersion(entry, version.number) }),
                            onPin = { model.pin(version) },
                            onSave = { actions.save(entry, version.number) },
                        )
                    }
                }
                item(key = "activity") { SectionTitle(stringResource(R.string.vaults_activity)) }
                items(activity, key = { "a${it.id}" }) { record ->
                    ActivityRow(record, vaultActor(record.actor, state.people, state.agents), state.folders)
                }
            }
        }
    }
    state.error?.takeIf { state.versions != null }?.let { problem ->
        com.slopus.happy.ui.components.HappyAlert(
            com.slopus.happy.ui.components.Alert(stringResource(R.string.vaults_failed), problemText(problem), listOf(com.slopus.happy.ui.components.AlertButton(stringResource(R.string.common_ok)))),
            onDismiss = model::dismissError,
        )
    }
    val shownVersion = viewing
    if (shownVersion != null && entry != null) VaultMediaViewer(session, listOf(entry), 0, shownVersion.takeIf { it != entry.latestVersion }) { viewing = null }
    VaultActionsHost(actions)
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text.uppercase(),
        style = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.Medium),
        color = HappyTheme.colors.textSecondary,
        modifier = Modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .fillMaxWidth()
            .padding(start = VaultHistorySpec.padding, end = VaultHistorySpec.padding, top = 20.dp, bottom = 6.dp)
            .semantics { heading() },
    )
}

/** One version: its number in the badge, who made it, when, how big, "Current" or which it restored, a pin when pinned; a tap offers what it can do. */
@Composable
internal fun VersionRow(
    version: VaultVersion,
    current: Boolean,
    actor: String,
    onPreview: () -> Unit,
    onRestore: (() -> Unit)?,
    onPin: () -> Unit,
    onSave: () -> Unit,
) {
    val colors = HappyTheme.colors
    var menu by remember { mutableStateOf(false) }
    val notes = listOfNotNull(
        vaultDateTime(version.createdAt),
        vaultSize(version.size),
        if (current) stringResource(R.string.vaults_current) else null,
        version.restoredFrom?.let { stringResource(R.string.vaults_restored_from, it) },
    ).filter { it.isNotEmpty() }
    Box(Modifier.contentMaxWidth(LocalWindowLayout.current).fillMaxWidth()) {
        HistoryRow(
            badge = version.number.toString(),
            highlighted = current,
            title = actor,
            detail = notes.joinToString(" · "),
            modifier = Modifier.testTag(VaultHistoryTags.version(version.number)).clickable(role = Role.Button) { menu = true },
            trailing = if (version.pinned) ({ Icon(Ionicon.Pin, 18.dp, colors.textLink, Modifier.testTag(VaultHistoryTags.PIN), contentDescription = stringResource(R.string.vaults_pinned)) }) else null,
        )
        Box(Modifier.align(Alignment.TopEnd)) {
            HappyDropdownMenu(menu, onDismissRequest = { menu = false }) {
                HappyMenuItem(stringResource(R.string.vaults_preview), onClick = { menu = false; onPreview() }, leading = { MenuGlyph(Ionicon.EyeOutline) })
                if (onRestore != null) HappyMenuItem(stringResource(R.string.vaults_restore_version), onClick = { menu = false; onRestore() }, leading = { MenuGlyph(Ionicon.ArrowUndoOutline) })
                HappyMenuItem(
                    stringResource(if (version.pinned) R.string.vaults_unpin else R.string.vaults_pin),
                    onClick = { menu = false; onPin() },
                    supporting = if (version.pinned) null else stringResource(R.string.vaults_pin_hint),
                    leading = { MenuGlyph(if (version.pinned) Ionicon.PinOutline else Ionicon.Pin) },
                )
                HappyMenuItem(stringResource(R.string.vaults_save_to_device), onClick = { menu = false; onSave() }, leading = { MenuGlyph(Ionicon.DownloadOutline) })
            }
        }
    }
}

/** One activity record: what happened in words, who and when under it. */
@Composable
internal fun ActivityRow(record: VaultActivity, actor: String, folders: Map<String, String>) {
    val root = stringResource(R.string.vaults_root)
    val another = stringResource(R.string.vaults_another_folder)
    fun folder(id: String?): String = if (id == null) root else folders[id] ?: another
    val what = when (record.kind) {
        "created" -> stringResource(if (record.copiedFrom != null) R.string.vaults_activity_copied else R.string.vaults_activity_created)
        "moved" -> when {
            record.fromParentId == record.toParentId -> stringResource(R.string.vaults_activity_renamed, VaultNames.shown(record.fromName.orEmpty()), VaultNames.shown(record.toName.orEmpty()))
            record.fromName == record.toName -> stringResource(R.string.vaults_activity_moved, folder(record.fromParentId), folder(record.toParentId))
            else -> stringResource(R.string.vaults_activity_moved_renamed, VaultNames.shown(record.toName.orEmpty()), folder(record.toParentId))
        }
        "deleted" -> stringResource(R.string.vaults_activity_deleted)
        "restored" -> stringResource(R.string.vaults_activity_restored, folder(record.parentId))
        "version_created" -> record.restoredFrom?.let { stringResource(R.string.vaults_activity_version_restored, record.number ?: 0, it) }
            ?: stringResource(R.string.vaults_activity_version, record.number ?: 0)
        "pinned" -> stringResource(R.string.vaults_activity_pinned, record.number ?: 0)
        "unpinned" -> stringResource(R.string.vaults_activity_unpinned, record.number ?: 0)
        else -> stringResource(R.string.vaults_activity_changed)
    }
    val glyph = when (record.kind) {
        "created" -> Ionicon.Add
        "moved" -> Ionicon.MoveOutline
        "deleted" -> Ionicon.TrashOutline
        "restored" -> Ionicon.ArrowUndoOutline
        "version_created" -> Ionicon.CloudUploadOutline
        "pinned", "unpinned" -> Ionicon.PinOutline
        else -> Ionicon.CreateOutline
    }
    Box(Modifier.contentMaxWidth(LocalWindowLayout.current).fillMaxWidth()) {
        HistoryRow(glyph = glyph, title = what, detail = listOf(actor, vaultDateTime(record.at)).filter { it.isNotEmpty() }.joinToString(" · "), modifier = Modifier.testTag(VaultHistoryTags.ACTIVITY))
    }
}

@Composable
private fun HistoryRow(
    title: String,
    detail: String,
    modifier: Modifier = Modifier,
    badge: String? = null,
    glyph: Ionicon? = null,
    highlighted: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
) {
    val colors = HappyTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = VaultHistorySpec.badge + VaultHistorySpec.vertical * 2)
            .padding(horizontal = VaultHistorySpec.padding, vertical = VaultHistorySpec.vertical),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(VaultHistorySpec.badge).clip(CircleShape).background(if (highlighted) colors.textLink else colors.surfaceHigh),
            contentAlignment = Alignment.Center,
        ) {
            if (badge != null) Text(badge, style = happyTextStyle(fontSize = 14, lineHeight = 18, weight = FontWeight.SemiBold), color = if (highlighted) androidx.compose.ui.graphics.Color.White else colors.text)
            else if (glyph != null) Icon(glyph, 18.dp, colors.textSecondary)
        }
        Column(Modifier.padding(start = VaultHistorySpec.gap).weight(1f)) {
            Text(title, style = happyTextStyle(fontSize = 16, lineHeight = 21), color = colors.text)
            Text(detail, style = happyTextStyle(fontSize = 13, lineHeight = 18), color = colors.textSecondary, modifier = Modifier.padding(top = 2.dp))
        }
        trailing?.invoke()
    }
}
