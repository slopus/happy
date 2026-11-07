package com.slopus.happy.artifacts

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.Problem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/**
 * The artifact catalog of one agent connection, kept on the phone (iOS's
 * `ArtifactCatalogFeed`): read from disk first, then whole from the
 * computer, then kept current by its `artifact.*` events; a `hello` (a
 * reconnect) reads it again. Every change is written back, so the list
 * opens on what it last showed with no network.
 *
 * Its state changes only on [scope]'s dispatcher (the main thread in the
 * app); disk work goes to [io].
 */
class ArtifactCatalogFeed(
    private val scope: CoroutineScope,
    /** One page from a cursor: `GET /v0/artifacts?limit=100`. */
    private val fetch: suspend (cursor: String?) -> JsonObject,
    /** One artifact object: `GET /v0/artifacts/:id`. */
    private val fetchOne: suspend (id: String) -> JsonObject,
    private val kept: () -> JsonObject?,
    private val keep: (JsonObject) -> Unit,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    @Immutable
    data class State(
        /** Newest change first. */
        val items: List<ArtifactSummary> = emptyList(),
        /** Something was read, from disk or the computer: the list can say it is empty rather than loading. */
        val loaded: Boolean = false,
        /** This Happy Agent keeps no artifacts (`404` on the catalog). */
        val unsupported: Boolean = false,
        /** The last read failed, and why. */
        val error: Problem? = null,
    )

    private val stateFlow = MutableStateFlow(State())
    val state: StateFlow<State> = stateFlow.asStateFlow()
    private var started = false
    private var reading: Job? = null
    private var again = false

    /** Disk, then the computer, then its [events], for as long as [scope] lives. */
    fun start(events: Flow<AgentEvent>) {
        if (started) return
        started = true
        scope.launch {
            val items = withContext(io) { kept() }?.let(ArtifactCatalog::fromKept)
            if (items != null && !stateFlow.value.loaded) stateFlow.update { it.copy(items = items, loaded = true) }
            refresh()
            events.collect { event ->
                when {
                    event.type == AgentEvent.HELLO -> refresh()
                    event.type.startsWith("artifact.") -> receive(event)
                }
            }
        }
    }

    /**
     * Reads the whole catalog again; asked while a read runs, one more
     * follows it, so the last read begins after the last ask.
     */
    fun refresh(): Job {
        reading?.takeIf { it.isActive }?.let {
            again = true
            return it
        }
        return scope.launch {
            do {
                again = false
                read()
            } while (again)
        }.also { reading = it }
    }

    private suspend fun read() {
        val items = ArrayList<ArtifactSummary>()
        var cursor: String? = null
        try {
            for (pageIndex in 0 until PAGE_LIMIT) {
                val (page, next) = ArtifactCatalog.page(fetch(cursor))
                items += page
                cursor = next ?: break
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: AgentApiException) {
            if (e.status == 404) {
                stateFlow.update { it.copy(items = emptyList(), loaded = true, unsupported = true, error = null) }
                withContext(io) { keep(ArtifactCatalog.kept(emptyList())) }
            } else {
                stateFlow.update { it.copy(error = Conversation.describe(e)) }
            }
            return
        } catch (e: Exception) {
            stateFlow.update { it.copy(error = Conversation.describe(e)) }
            return
        }
        val seen = HashSet<String>()
        stateFlow.update { it.copy(loaded = true, unsupported = false, error = null) }
        set(ArtifactCatalog.sorted(items.filter { seen.add(it.id) }))
    }

    private suspend fun receive(event: AgentEvent) {
        when (val change = ArtifactCatalog.apply(event.type, event.data, stateFlow.value.items)) {
            ArtifactCatalog.Change.None -> Unit
            is ArtifactCatalog.Change.Changed -> set(change.items)
            is ArtifactCatalog.Change.Read -> {
                val artifact = try {
                    ArtifactSummary.parse(fetchOne(change.id))
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    null
                } ?: return
                set(ArtifactCatalog.sorted(stateFlow.value.items.filter { it.id != change.id } + artifact))
            }
        }
    }

    /** Shows [items] and writes them down. */
    private suspend fun set(items: List<ArtifactSummary>) {
        if (items == stateFlow.value.items) return
        stateFlow.update { it.copy(items = items) }
        val value = ArtifactCatalog.kept(items)
        withContext(io) { keep(value) }
    }

    companion object {
        /** The disk resource the list is kept under, beside the agent catalog. */
        const val RESOURCE = "artifact-catalog"
        /** The most pages one read follows: 2000 artifacts. */
        const val PAGE_LIMIT = 20
        const val PAGE_SIZE = 100
    }
}
