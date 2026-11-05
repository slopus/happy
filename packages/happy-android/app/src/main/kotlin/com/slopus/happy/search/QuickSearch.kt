package com.slopus.happy.search

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.AgentConnectionException
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/**
 * One thing `GET /v0/quick-search` found (happy-agent API.md, "Quick
 * search" › Result types): its [key] (`<type>:<id>`, the same one the
 * phone's own search gives it), its 1-based [rank] in the daemon's whole
 * list, and the fields its row shows.
 */
@Immutable
sealed interface QuickSearchHit {
    val key: String
    val rank: Int

    @Serializable
    data class VaultFile(
        override val key: String,
        override val rank: Int,
        val surfaceId: String,
        val fileId: String,
        val name: String,
        val path: String = "",
        /** `file`, or `artifact` for a vault app. */
        val kind: String = "file",
        val match: String = "name",
        val innerPath: String? = null,
        val line: Int? = null,
        val snippet: String? = null,
    ) : QuickSearchHit

    @Serializable
    data class VaultFolder(override val key: String, override val rank: Int, val surfaceId: String, val folderId: String, val name: String, val path: String = "", val match: String = "name") : QuickSearchHit

    @Serializable
    data class Document(override val key: String, override val rank: Int, val surfaceId: String, val name: String, val match: String = "name", val line: Int? = null, val snippet: String? = null) : QuickSearchHit

    @Serializable
    data class Todo(override val key: String, override val rank: Int, val surfaceId: String, val todoId: String, val text: String, val status: String = "active") : QuickSearchHit

    @Serializable
    data class CalendarEvent(override val key: String, override val rank: Int, val surfaceId: String, val eventId: String, val title: String, val allDay: Boolean = false, val start: Long = 0) : QuickSearchHit

    @Serializable
    data class Artifact(override val key: String, override val rank: Int, val artifactId: String, val title: String, val artifactType: String = "", val match: String = "name", val snippet: String? = null) : QuickSearchHit

    @Serializable
    data class Surface(override val key: String, override val rank: Int, val surfaceId: String, val surfaceType: String = "", val name: String) : QuickSearchHit

    /** A conversation: `chat`, `task`, `subtask` or `bot`; [workspaceId] and [projectId] where it is, null where it is in none. */
    @Serializable
    data class Agent(
        override val key: String,
        override val rank: Int,
        val agentId: String,
        val title: String = "",
        val kind: String = "chat",
        val archived: Boolean = false,
        val workspaceId: String? = null,
        val projectId: String? = null,
    ) : QuickSearchHit

    @Serializable
    data class Project(override val key: String, override val rank: Int, val projectId: String, val name: String, val archived: Boolean = false) : QuickSearchHit

    @Serializable
    data class Workspace(override val key: String, override val rank: Int, val workspaceId: String, val projectId: String? = null, val name: String, val archived: Boolean = false) : QuickSearchHit

    companion object {
        /** The types in the daemon's provider order, which the phone's own search ranks in too. */
        val TYPES = listOf("vault_file", "vault_folder", "document", "todo", "calendar_event", "artifact", "surface", "agent", "project", "workspace")

        /**
         * [value] as the hit its `type` names, any field this phone doesn't
         * know left out ([AgentClient.json] ignores them); null for a type
         * it doesn't know, or one that doesn't read.
         */
        fun parse(value: kotlinx.serialization.json.JsonElement): QuickSearchHit? {
            val obj = value as? JsonObject ?: return null
            val serializer: KSerializer<out QuickSearchHit> = when ((obj["type"] as? JsonPrimitive)?.content) {
                "vault_file" -> VaultFile.serializer()
                "vault_folder" -> VaultFolder.serializer()
                "document" -> Document.serializer()
                "todo" -> Todo.serializer()
                "calendar_event" -> CalendarEvent.serializer()
                "artifact" -> Artifact.serializer()
                "surface" -> Surface.serializer()
                "agent" -> Agent.serializer()
                "project" -> Project.serializer()
                "workspace" -> Workspace.serializer()
                else -> return null
            }
            return try {
                AgentClient.json.decodeFromJsonElement(serializer, obj)
            } catch (_: Exception) {
                null
            }
        }
    }
}

/** What the daemon found for [query]: [hits] in its fused order; [truncated] more matched; [partial] a provider was too slow. */
@Immutable
data class QuickSearchAnswer(val query: String, val hits: List<QuickSearchHit>, val truncated: Boolean = false, val partial: Boolean = false)

/** `GET /v0/quick-search`, a daemon's half of quick search. */
class QuickSearchClient(private val client: AgentClient) {
    /** [query]'s results, at most [limit]; null where the daemon has no quick search (an older one's `404`). */
    suspend fun search(query: String, limit: Int = DEFAULT_LIMIT): QuickSearchAnswer? {
        val q = query.trim().take(MAX_QUERY)
        if (q.isEmpty()) return QuickSearchAnswer(q, emptyList())
        val response = try {
            client.send("GET", "/v0/quick-search?q=${AgentClient.escape(q)}&limit=$limit")
        } catch (e: AgentApiException) {
            if (e.status == 404) return null
            throw e
        }
        val body = try {
            AgentClient.json.parseToJsonElement(response.text).jsonObject
        } catch (e: Exception) {
            throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse).initCause(e)
        }
        val hits = (body["results"] as? JsonArray).orEmpty().mapNotNull(QuickSearchHit::parse)
        fun flag(name: String) = (body[name] as? JsonPrimitive)?.content == "true"
        return QuickSearchAnswer(q, hits, flag("truncated"), flag("partial"))
    }

    companion object {
        const val DEFAULT_LIMIT = 30
        const val MAX_QUERY = 256
    }
}

/**
 * Quick search's fusion (API.md, "Quick search" › Fusing results; the
 * client package's `fuseQuickSearchResults()`): Reciprocal Rank Fusion of
 * the daemon's list and the phone's own. A remote result scores
 * `1 / (k + rank)`, a local one `1 / (k + p)` at its 1-based position; a
 * key in both is one result scored as the remote term plus the local term,
 * carrying the remote fields. Highest score first; then by remote rank,
 * results the daemon didn't return last; then by local position.
 */
object QuickSearchFusion {
    const val K = 60

    /** One fused result: what the daemon said of it, what the phone holds of it, or both. */
    data class Fused<R, L>(val key: String, val remote: R?, val local: L?)

    fun <R, L> fuse(
        remote: List<R>,
        local: List<L>,
        remoteKey: (R) -> String,
        remoteRank: (R) -> Int,
        localKey: (L) -> String,
        k: Int = K,
    ): List<Fused<R, L>> {
        class Entry(val key: String, var remote: R?, var rank: Int?, var local: L?, var position: Int?, var score: Double)
        val byKey = LinkedHashMap<String, Entry>()
        for (result in remote) {
            val key = remoteKey(result)
            if (key in byKey) continue
            val rank = remoteRank(result)
            byKey[key] = Entry(key, result, rank, null, null, 1.0 / (k + rank))
        }
        local.forEachIndexed { index, result ->
            val key = localKey(result)
            val position = index + 1
            val held = byKey[key]
            when {
                held == null -> byKey[key] = Entry(key, null, null, result, position, 1.0 / (k + position))
                held.position != null -> Unit
                else -> {
                    held.local = result
                    held.position = position
                    held.score = held.score + 1.0 / (k + position)
                }
            }
        }
        return byKey.values
            .sortedWith(
                compareByDescending<Entry> { it.score }
                    .thenBy { it.rank ?: Int.MAX_VALUE }
                    .thenBy { it.position ?: Int.MAX_VALUE },
            )
            .map { Fused(it.key, it.remote, it.local) }
    }
}
