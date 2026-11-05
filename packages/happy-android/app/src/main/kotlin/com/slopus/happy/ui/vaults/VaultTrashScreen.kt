package com.slopus.happy.ui.vaults

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.Problem
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.artifacts.PlaceMessage
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.components.barInsetTop
import com.slopus.happy.ui.conversation.problemText
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.surfaces.SeedlingEmpty
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.vaults.VaultItem
import com.slopus.happy.vaults.VaultNames
import com.slopus.happy.vaults.VaultEvent
import com.slopus.happy.vaults.VaultPreview
import com.slopus.happy.vaults.VaultTrashItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

object VaultTrashTags {
    const val SCREEN = "vault.trash"
    const val NOTE = "vault.trash.note"
}

internal class VaultTrashModel(val session: AgentSession, val surfaceId: String) : ViewModel() {
    data class State(val items: List<VaultTrashItem>? = null, val trashDays: Int? = null, val known: Boolean = false, val error: Problem? = null)

    private val stateFlow = MutableStateFlow(State())
    val state: StateFlow<State> = stateFlow.asStateFlow()
    private var reading: Job? = null

    init {
        viewModelScope.launch {
            read(0)
            session.vaults.events.collect { event ->
                val touched = when (event) {
                    VaultEvent.Resync -> true
                    is VaultEvent.Updated -> event.surfaceId == surfaceId && (event.changes.containsKey("deletedAt") || stateFlow.value.items?.any { it.item.id == event.itemId } == true)
                    is VaultEvent.Known -> event.item.surfaceId == surfaceId
                    is VaultEvent.Removed -> event.surfaceId == surfaceId
                    is VaultEvent.SettingsUpdated -> event.surfaceId == surfaceId
                    else -> false
                }
                if (touched) read(BURST_MS)
            }
        }
    }

    /** Reads the Trash again, once for a burst of changes. */
    private fun read(after: Long) {
        reading?.cancel()
        reading = viewModelScope.launch {
            if (after > 0) delay(after)
            val routes = session.vaults.routes
            try {
                val items = ArrayList<VaultTrashItem>()
                var page: String? = null
                do {
                    val answer = routes.trash(surfaceId, page)
                    items += answer.items
                    page = answer.next
                } while (page != null)
                val days = runCatching { routes.settings(surfaceId).retention.trashDays }
                stateFlow.update { it.copy(items = items, trashDays = days.getOrNull() ?: it.trashDays, known = days.isSuccess || it.known, error = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                stateFlow.update { it.copy(error = Conversation.describe(e)) }
            }
        }
    }

    companion object { const val BURST_MS = 150L }
}

/**
 * A vault's Trash: what was deleted, most recently first, each where it
 * was and when it went, and how long the Trash keeps things. A folder
 * opens to show what is inside it and a file to show itself, so people
 * can look before they restore; More (or a long press) restores it, to
 * where it was or the root when that folder is gone. Live.
 */
@Composable
fun VaultTrashScreen(session: AgentSession, surfaceId: String, onBack: () -> Unit, open: (Any) -> Unit) {
    val model = viewModel(key = "vault-trash:${session.connectionId}:$surfaceId") { VaultTrashModel(session, surfaceId) }
    val state by model.state.collectAsStateWithLifecycle()
    val actions = rememberVaultActions(session, surfaceId, open)
    var viewing by remember { mutableStateOf<VaultItem?>(null) }
    PlaceScaffold(stringResource(R.string.vaults_trash), onBack, VaultTrashTags.SCREEN) {
        val items = state.items
        when {
            items == null -> if (state.error != null) Column(Modifier.padding(top = barInsetTop())) { PlaceMessage(problemText(state.error!!)) } else LoadingIndicator()
            items.isEmpty() -> SeedlingEmpty(stringResource(R.string.vaults_trash_empty))
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = barInsetTop(), bottom = 32.dp)) {
                item(key = "note") { TrashNote(state.trashDays, state.known) }
                items(items, key = { it.item.id }) { item ->
                    val entry = item.item
                    val was = VaultNames.shownPath(item.path.substringBeforeLast('/')).ifEmpty { "/" }
                    val detail = stringResource(R.string.vaults_deleted_from, vaultTime(entry.deletedAt ?: 0), was)
                    VaultItemRow(entry, last = item === items.last(), actions = actions, detail = detail, inTrash = true, onClick = {
                        when {
                            entry.isFolder -> open(VaultFolderRoute(session.connectionId, surfaceId, entry.id, entry.name))
                            VaultPreview.inViewer(entry) -> viewing = entry
                            else -> open(VaultFileRoute(session.connectionId, surfaceId, entry.id, name = entry.shownName))
                        }
                    })
                }
            }
        }
    }
    viewing?.let { VaultMediaViewer(session, listOf(it), 0) { viewing = null } }
    VaultActionsHost(actions)
}

@Composable
private fun TrashNote(days: Int?, known: Boolean) {
    if (!known) return
    Text(
        if (days == null) stringResource(R.string.vaults_trash_kept) else pluralResource(R.plurals.vaults_trash_note, days, days),
        style = happyTextStyle(fontSize = 13, lineHeight = 18),
        color = HappyTheme.colors.textSecondary,
        modifier = Modifier.contentMaxWidth(LocalWindowLayout.current).fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag(VaultTrashTags.NOTE),
    )
}
