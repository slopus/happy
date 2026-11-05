package com.slopus.happy.vaults

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.merge
import kotlinx.serialization.json.JsonObject

/**
 * One agent connection's vaults: their routes, the journal's `vault.*`
 * events with what this phone's own requests answered ([known]), and the
 * uploads in flight. Screens make a [VaultFolderFeed] per folder they show.
 */
class Vaults(
    client: AgentClient,
    journal: Flow<AgentEvent>,
    private val scope: CoroutineScope,
    private val kept: suspend (String) -> JsonObject? = { null },
    private val keep: suspend (String, JsonObject) -> Unit = { _, _ -> },
) {
    val routes = VaultClient(client)
    private val local = MutableSharedFlow<VaultEvent>(extraBufferCapacity = 256)

    /** Every vault event, the journal's and the phone's own answers. */
    val events: Flow<VaultEvent> = merge(journal.mapNotNull(VaultEvent::of), local)

    val uploads = VaultUploads(routes, scope, placed = ::known)

    /** An entry a request answered with: shown at once, before (or without) its event. */
    fun known(entry: VaultItem) {
        local.tryEmit(VaultEvent.Known(entry))
    }

    /** Settings this phone just saved: the settings page shows them at once. */
    fun settingsChanged(surfaceId: String) {
        local.tryEmit(VaultEvent.SettingsUpdated(surfaceId))
    }

    private val sorts = java.util.concurrent.ConcurrentHashMap<String, VaultSort>()

    /** The order a vault's folders were last put in, for the next folder opened. */
    fun sort(surfaceId: String): VaultSort = sorts[surfaceId] ?: VaultSort()

    fun setSort(surfaceId: String, sort: VaultSort) {
        sorts[surfaceId] = sort
    }

    fun folder(feedScope: CoroutineScope, surfaceId: String, parentId: String?, sort: VaultSort = VaultSort()): VaultFolderFeed =
        VaultFolderFeed(feedScope, routes, events, surfaceId, parentId, sort, kept, keep)
}
