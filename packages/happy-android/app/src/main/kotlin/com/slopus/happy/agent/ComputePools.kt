package com.slopus.happy.agent

import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/** Monitoring facts only: null capacity is unknown, not zero or the per-member sandbox limit. */
data class SandboxCapacity(val used: Int, val total: Int?)
data class ComputePool(val id: String, val name: String, val counts: Map<String, Int>, val capacity: SandboxCapacity)
data class ComputePlacement(val sandboxId: String, val agentId: String, val title: String?)
data class ComputeNode(
    val id: String,
    val pool: String,
    val name: String,
    val status: String,
    val lastSeenAt: Long?,
    val version: String?,
    val capacity: SandboxCapacity,
    val agents: List<ComputePlacement>,
) {
    val canDrain: Boolean get() = status in setOf("online", "offline", "draining")
}
data class ComputeSnapshot(val pools: List<ComputePool>, val nodes: List<ComputeNode>)

/** One-time commands: memory only, never logged, saved, or minted by a refresh. */
class ComputeJoinCommand(val unix: String?, val windows: String?, val expiresAt: Long)

/** The Cloud compute monitoring contract. Mutations deliberately ignore their non-monitoring response objects. */
object ComputePools {
    private const val ROOT = "/v0/compute"
    val statuses = listOf("online", "offline", "draining", "enrolling", "revoked")

    suspend fun read(client: AgentClient): ComputeSnapshot {
        require(client.cloud)
        val pools = client.decode<JsonObject>("GET", "$ROOT/pools").objects("pools").map { p ->
            val counts = requireNotNull(p["nodeCounts"].obj)
            ComputePool(p.text("id"), p.text("name"), (statuses + "total").associateWith { counts.count(it) }, p.capacity())
        }
        val nodes = client.decode<JsonObject>("GET", "$ROOT/nodes").objects("nodes").map { n ->
            ComputeNode(
                id = n.text("id"), pool = n.text("pool"),
                name = n["name"].str?.takeIf { it.isNotBlank() } ?: n["hostname"].str?.takeIf { it.isNotBlank() } ?: n.text("id"),
                status = n.text("status"), lastSeenAt = n.millis("lastSeenAt"), version = n["version"].str,
                capacity = n.capacity(),
                agents = n.objects("activeSandboxes").map { ComputePlacement(it.text("sandboxId"), it.text("agentId"), it["agentTitle"].str) },
            )
        }
        return ComputeSnapshot(pools, nodes)
    }

    suspend fun drain(client: AgentClient, id: String, draining: Boolean) {
        require(client.cloud)
        client.send("POST", "$ROOT/nodes/${AgentClient.escape(id)}/${if (draining) "drain" else "undrain"}")
    }

    suspend fun joinCommand(client: AgentClient, pool: String): ComputeJoinCommand {
        require(client.cloud)
        val answer = client.decode<JsonObject>("POST", "$ROOT/pools/${AgentClient.escape(pool)}/join-tokens", JsonObject(emptyMap()))
        val commands = answer["commands"].obj
        return ComputeJoinCommand(commands?.get("unix").str, commands?.get("windows").str, requireNotNull(answer.millis("expiresAt")))
    }

    private fun JsonObject.text(key: String): String = requireNotNull(this[key].str).also { require(it.isNotBlank()) }
    private fun JsonObject.count(key: String): Int = requireNotNull((this[key] as? JsonPrimitive)?.intOrNull).also { require(it >= 0) }
    private fun JsonObject.millis(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull
    private fun JsonObject.objects(key: String): List<JsonObject> = requireNotNull(this[key].arr).map { requireNotNull(it.obj) }
    private fun JsonObject.capacity(): SandboxCapacity {
        val capacity = requireNotNull(this["sandboxCapacity"].obj)
        require(capacity.containsKey("total"))
        return SandboxCapacity(capacity.count("used"), if (capacity["total"] == JsonNull) null else capacity.count("total"))
    }
}

/** Visible-page snapshots. A forbidden answer clears all facts and latches until the authorized page is recreated. */
class ComputePoolsSource(private val client: AgentClient) {
    sealed interface State {
        data object Loading : State
        data object Failed : State
        data object Forbidden : State
        data class Loaded(val snapshot: ComputeSnapshot) : State
    }
    private val mutable = MutableStateFlow<State>(State.Loading)
    val state = mutable.asStateFlow()
    private val lock = Mutex()

    suspend fun refresh() = lock.withLock {
        if (mutable.value == State.Forbidden) return@withLock
        try {
            mutable.value = State.Loaded(ComputePools.read(client))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            mutable.value = if (e is AgentApiException && e.status == 403) State.Forbidden else State.Failed
        }
    }

    /** Called only while resumed; cancellation stops both the timer and event listener, including in-flight requests. */
    suspend fun observe(events: SharedFlow<AgentEvent>, interval: Long = 30_000) = coroutineScope {
        launch {
            events.collect {
                if (it.type in setOf(AgentEvent.HELLO, "compute.nodes.updated", "compute.pools.updated")) refresh()
            }
        }
        while (isActive) {
            refresh()
            delay(interval)
        }
    }

    /** No automatic retries for management actions. Always re-read after a successful change. */
    suspend fun drain(node: ComputeNode): Boolean {
        val changed = lock.withLock {
            try {
                check(mutable.value is State.Loaded && node.canDrain)
                ComputePools.drain(client, node.id, draining = node.status != "draining")
                true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is AgentApiException && e.status == 403) mutable.value = State.Forbidden
                false
            }
        }
        if (changed) refresh()
        return changed && mutable.value is State.Loaded
    }

    suspend fun joinCommand(pool: ComputePool): ComputeJoinCommand = lock.withLock {
        check(mutable.value is State.Loaded)
        try {
            ComputePools.joinCommand(client, pool.id)
        } catch (e: AgentApiException) {
            if (e.status == 403) mutable.value = State.Forbidden
            throw e
        }
    }
}