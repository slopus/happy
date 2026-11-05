package com.slopus.happy.vaults

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.Problem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/**
 * One open folder of a vault, live: its kept copy from disk first, then
 * every page of its children (a folder of thousands is a few pages, shown
 * from the first), then the journal's `vault.*` events reconciled by
 * [VaultListing]. A reconnect reads it again; a failed read tries again
 * every few seconds while nothing is shown wrong. Sorting is the phone's
 * own, over everything held, so changing it reads nothing.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class VaultFolderFeed(
    private val scope: CoroutineScope,
    private val routes: VaultClient,
    private val events: Flow<VaultEvent>,
    val surfaceId: String,
    val parentId: String?,
    sort: VaultSort = VaultSort(),
    private val kept: suspend (String) -> JsonObject? = { null },
    private val keep: suspend (String, JsonObject) -> Unit = { _, _ -> },
    private val retryMs: Long = 5_000,
) {
    @Immutable
    data class State(
        val entries: List<VaultItem> = emptyList(),
        val sort: VaultSort = VaultSort(),
        /** Something is shown: the kept copy or the first page. */
        val loaded: Boolean = false,
        /** Every page is in. */
        val complete: Boolean = false,
        val error: Problem? = null,
        /** The folder is gone for good (removed from the Trash, or never was). */
        val gone: Boolean = false,
    ) {
        val empty: Boolean get() = complete && entries.isEmpty()
    }

    private val confined = Dispatchers.Default.limitedParallelism(1)
    private val listing = VaultListing(surfaceId, parentId)
    private val stateFlow = MutableStateFlow(State(sort = sort))
    val state: StateFlow<State> = stateFlow.asStateFlow()
    private var reading: Job? = null
    private var started = false
    private var comparator = sort.comparator()

    /** Follows the journal first, so nothing that happens while the folder is read is missed, then reads it. */
    fun start() {
        if (started) return
        started = true
        scope.launch(confined, start = CoroutineStart.UNDISPATCHED) { events.collect { receive(it) } }
        scope.launch(confined) {
            kept(key)?.let { restore(it) }
            reload()
        }
    }

    fun sort(next: VaultSort): Job = scope.launch(confined) {
        if (next == stateFlow.value.sort) return@launch
        comparator = next.comparator()
        stateFlow.value = stateFlow.value.copy(sort = next)
        publish()
    }

    fun retry(): Job = scope.launch(confined) { reload() }

    private val key: String get() = "vault:$surfaceId:${parentId ?: "root"}"

    private fun restore(kept: JsonObject) {
        val entries = (kept["entries"] as? JsonArray).orEmpty().mapNotNull { VaultItem.parse(it) }
        if (entries.isEmpty() && kept["entries"] == null) return
        listing.page(entries)
        stateFlow.value = stateFlow.value.copy(loaded = true)
        publish()
    }

    private fun reload() {
        reading?.cancel()
        reading = scope.launch(confined) {
            while (true) {
                listing.begin()
                try {
                    var page: String? = null
                    do {
                        val answer = routes.children(surfaceId, parentId, page)
                        listing.page(answer.items)
                        page = answer.next
                        stateFlow.value = stateFlow.value.copy(loaded = true, error = null)
                        publish()
                    } while (page != null)
                    listing.finish()
                    stateFlow.value = stateFlow.value.copy(complete = true, error = null)
                    publish()
                    remember()
                    return@launch
                } catch (e: CancellationException) {
                    listing.abandon()
                    throw e
                } catch (e: AgentApiException) {
                    listing.abandon()
                    if (e.status == 404) {
                        stateFlow.value = stateFlow.value.copy(gone = true, loaded = true, complete = true)
                        return@launch
                    }
                    stateFlow.value = stateFlow.value.copy(error = Conversation.describe(e))
                } catch (e: Exception) {
                    listing.abandon()
                    stateFlow.value = stateFlow.value.copy(error = Conversation.describe(e))
                }
                delay(retryMs)
            }
        }
    }

    private fun receive(event: VaultEvent) {
        when (val outcome = listing.receive(event)) {
            VaultListing.Outcome.Ignored -> Unit
            VaultListing.Outcome.Changed -> publish()
            VaultListing.Outcome.Reload -> reload()
            VaultListing.Outcome.Gone -> stateFlow.value = stateFlow.value.copy(gone = true)
            is VaultListing.Outcome.Read -> scope.launch(confined) {
                val entry = try {
                    routes.location(surfaceId, outcome.itemId, outcome.folder).item
                } catch (e: CancellationException) {
                    throw e
                } catch (e: AgentApiException) {
                    if (e.status != 404) return@launch
                    null
                } catch (_: Exception) {
                    return@launch
                }
                if (listing.read(outcome.itemId, entry)) publish()
            }
        }
    }

    private fun publish() {
        stateFlow.value = stateFlow.value.copy(entries = listing.entries.sortedWith(comparator))
    }

    /** The folder as last read, for the next time it opens; a very large one isn't kept. */
    private suspend fun remember() {
        val entries = listing.entries.toList()
        if (entries.size > KEEP_LIMIT) return
        val array = AgentClient.json.encodeToJsonElement(ListSerializer(VaultItem.serializer()), entries)
        try {
            keep(key, JsonObject(mapOf("entries" to array)))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Only the next opening's head start is lost.
        }
    }

    companion object {
        const val KEEP_LIMIT = 2_000
    }
}
