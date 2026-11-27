package com.slopus.happy.agent

import androidx.compose.runtime.Immutable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * A repository a task works in, as its home row pictures it: its photo at
 * [picture] (`/v0/repositories/:id/avatar`) over its [thumbhash], else the
 * placeholder its ID picks.
 */
@Immutable
data class RepositoryMark(val id: String, val name: String, val picture: String? = null, val thumbhash: String? = null)

/**
 * What Happy Cloud says of the tasks the person joined
 * (`GET /v0/tasks/repositories`): each task's repositories by task ID, in
 * the server's order, and the lines changed in the checkouts each agent
 * holds, by agent ID, summed over its checkouts that were scanned
 * (`changes`) and didn't fail. A task's row reports its own agent's, a
 * subtask's row its own, as a Happy Agent worktree row reports its own.
 */
@Immutable
data class TaskWork(
    val repositories: Map<String, List<RepositoryMark>> = emptyMap(),
    val changes: Map<String, WorkspaceLineChanges> = emptyMap(),
) {
    companion object {
        val Empty = TaskWork()

        /** `{ tasks: [{ taskId, repositories: [{ …, checkouts: [{ agentId, status, changes }] }] }] }`; null when it isn't that shape at all. */
        fun parse(json: JsonElement?): TaskWork? {
            val tasks = (json as? JsonObject)?.get("tasks") as? JsonArray ?: return null
            val repositories = LinkedHashMap<String, List<RepositoryMark>>()
            val insertions = LinkedHashMap<String, Long>()
            val deletions = LinkedHashMap<String, Long>()
            for (task in tasks.filterIsInstance<JsonObject>()) {
                val taskId = task.string("taskId") ?: continue
                val marks = ArrayList<RepositoryMark>()
                for (repository in (task["repositories"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()) {
                    val id = repository.string("repositoryId") ?: continue
                    val avatar = repository["avatar"] as? JsonObject
                    // The server serves the photo by path; one it names elsewhere, or none with an avatar, is read from its own route.
                    val picture = repository.string("avatarUrl")?.takeIf { it.startsWith("/") }
                        ?: avatar?.let { "/v0/repositories/${AgentClient.escape(id)}/avatar" }
                    marks += RepositoryMark(id, repository.string("name") ?: repository.string("path").orEmpty(), picture, avatar?.string("thumbhash"))
                    for (checkout in (repository["checkouts"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()) {
                        if (checkout.string("status") == "failed") continue
                        val agentId = checkout.string("agentId") ?: continue
                        // Absent on servers deployed before it, null before a scan: nothing to count.
                        val changes = checkout["changes"] as? JsonObject ?: continue
                        val added = changes.count("insertions") ?: continue
                        val deleted = changes.count("deletions") ?: continue
                        insertions[agentId] = (insertions[agentId] ?: 0) + added
                        deletions[agentId] = (deletions[agentId] ?: 0) + deleted
                    }
                }
                repositories[taskId] = marks
            }
            val changes = insertions.mapValues { (agentId, added) ->
                WorkspaceLineChanges(comparison = "ready", insertions = added, deletions = deletions[agentId] ?: 0, countsExact = true, scannedAt = 0.0)
            }
            return TaskWork(repositories, changes)
        }

        private fun JsonObject.count(key: String): Long? =
            (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it >= 0 }
    }
}

/** The route; a fake stands in for it in tests. */
fun interface TaskWorkApi {
    /** `GET /v0/tasks/repositories`; null where the server has none (`404`/`501`). */
    suspend fun read(): JsonObject?
}

class ClusterTaskWork(private val client: AgentClient) : TaskWorkApi {
    override suspend fun read(): JsonObject? = try {
        client.decode<JsonObject>("GET", "/v0/tasks/repositories")
    } catch (e: AgentApiException) {
        if (e.status == 404 || e.status == 501) null else throw e
    }
}

/**
 * The person's tasks' repositories and changed lines on one Happy Cloud
 * connection, as home's task rows show them ([TaskWork]): what the route
 * last answered, kept beside the catalog so an offline home still shows
 * it. Read on every connect (its `hello`) and again on each event that
 * changes it, as desktop does: a checkout's (a change scan is one), a
 * repository's, a task made or joined. Events are hints: a burst is one
 * read after the one under way. A failed read keeps what showed.
 */
class TaskWorkSource(
    private val api: TaskWorkApi,
    events: SharedFlow<AgentEvent>,
    kept: suspend () -> JsonObject?,
    private val keep: suspend (JsonObject) -> Unit,
    scope: CoroutineScope,
) {
    private val state = MutableStateFlow(TaskWork.Empty)
    val work: StateFlow<TaskWork> = state.asStateFlow()

    private val lock = Mutex()
    @Volatile private var heard = false
    private val asks = Channel<Unit>(Channel.CONFLATED)

    init {
        // Subscribed before the link's first hello can come.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            events.collect { event -> if (event.type == AgentEvent.HELLO || event.type in REREAD) asks.trySend(Unit) }
        }
        scope.launch {
            val last = kept()?.let(TaskWork::parse)
            lock.withLock { if (!heard && last != null) state.value = last }
        }
        scope.launch {
            for (ask in asks) read()
        }
    }

    private suspend fun read() {
        val answer = try {
            api.read()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Offline or refused: what was known stays.
            return
        }
        val work = if (answer == null) TaskWork.Empty else TaskWork.parse(answer) ?: return
        lock.withLock {
            heard = true
            state.value = work
        }
        keep(answer ?: JsonObject(emptyMap()))
    }

    companion object {
        /** Kept in the connection's resources under this key. */
        const val RESOURCE = "taskRepositories"

        /** The events after which desktop reads the list again. */
        val REREAD = setOf("checkout.updated", "checkout.deleted", "repository.updated", "repository.deleted", "task.created", "task.joined")
    }
}
