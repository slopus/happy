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
 * One thing `POST /v0/search` found (happy-agent API.md, "Search" ›
 * Result types): its [key] (`<type>:<id>`, the same one the phone's own
 * search gives it), its 1-based [rank] in the daemon's whole list, and the
 * fields its row shows. People (`user`) and skills (`skill`) have no page
 * on the phone, so they are left out as types it doesn't know are.
 */
@Immutable
sealed interface SearchHit {
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
    ) : SearchHit

    @Serializable
    data class VaultFolder(override val key: String, override val rank: Int, val surfaceId: String, val folderId: String, val name: String, val path: String = "", val match: String = "name") : SearchHit

    @Serializable
    data class Document(override val key: String, override val rank: Int, val surfaceId: String, val name: String, val match: String = "name", val line: Int? = null, val snippet: String? = null) : SearchHit

    @Serializable
    data class Todo(override val key: String, override val rank: Int, val surfaceId: String, val todoId: String, val text: String, val status: String = "active") : SearchHit

    @Serializable
    data class CalendarEvent(
        override val key: String,
        override val rank: Int,
        val surfaceId: String,
        val eventId: String,
        val title: String,
        val allDay: Boolean = false,
        val start: Long = 0,
        /** `name`, or `content` in its notes or location, with [snippet]. */
        val match: String = "name",
        val snippet: String? = null,
    ) : SearchHit

    /** One message of a conversation, found by its text: a person's (`user`) or an agent's (`agent`). */
    @Serializable
    data class Message(
        override val key: String,
        override val rank: Int,
        val agentId: String,
        val messageId: String,
        val role: String = "agent",
        val snippet: String? = null,
        val createdAt: Long = 0,
        val workspaceId: String? = null,
        val projectId: String? = null,
    ) : SearchHit

    @Serializable
    data class Artifact(override val key: String, override val rank: Int, val artifactId: String, val title: String, val artifactType: String = "", val match: String = "name", val snippet: String? = null) : SearchHit

    @Serializable
    data class Surface(override val key: String, override val rank: Int, val surfaceId: String, val surfaceType: String = "", val name: String) : SearchHit

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
    ) : SearchHit

    @Serializable
    data class Project(override val key: String, override val rank: Int, val projectId: String, val name: String, val archived: Boolean = false) : SearchHit

    @Serializable
    data class Workspace(override val key: String, override val rank: Int, val workspaceId: String, val projectId: String? = null, val name: String, val archived: Boolean = false) : SearchHit

    companion object {
        /** The types in the daemon's provider order, which the phone's own search ranks in too. */
        val TYPES = listOf("vault_file", "vault_folder", "document", "message", "todo", "calendar_event", "artifact", "surface", "agent", "project", "workspace")

        /**
         * [value] as the hit its `type` names, any field this phone doesn't
         * know left out ([AgentClient.json] ignores them); null for a type
         * it doesn't know, or one that doesn't read.
         */
        fun parse(value: kotlinx.serialization.json.JsonElement): SearchHit? {
            val obj = value as? JsonObject ?: return null
            val serializer: KSerializer<out SearchHit> = when ((obj["type"] as? JsonPrimitive)?.content) {
                "vault_file" -> VaultFile.serializer()
                "vault_folder" -> VaultFolder.serializer()
                "document" -> Document.serializer()
                "message" -> Message.serializer()
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
data class SearchAnswer(val query: String, val hits: List<SearchHit>, val truncated: Boolean = false, val partial: Boolean = false)

/** `POST /v0/search`, a daemon's half of search. */
class SearchClient(private val client: AgentClient) {
    /** [query]'s results, at most [limit]; null where the daemon has no search (an older one's `404`). */
    suspend fun search(query: String, limit: Int = DEFAULT_LIMIT): SearchAnswer? {
        val q = query.trim().take(MAX_QUERY)
        if (q.isEmpty()) return SearchAnswer(q, emptyList())
        val response = try {
            // A query in the body, never in a URL; searching changes nothing.
            client.send("POST", "/v0/search", JsonObject(mapOf("q" to JsonPrimitive(q), "limit" to JsonPrimitive(limit))))
        } catch (e: AgentApiException) {
            if (e.status == 404) return null
            throw e
        }
        val body = try {
            AgentClient.json.parseToJsonElement(response.text).jsonObject
        } catch (e: Exception) {
            throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse).initCause(e)
        }
        val hits = (body["results"] as? JsonArray).orEmpty().mapNotNull(SearchHit::parse)
        fun flag(name: String) = (body[name] as? JsonPrimitive)?.content == "true"
        return SearchAnswer(q, hits, flag("truncated"), flag("partial"))
    }

    companion object {
        const val DEFAULT_LIMIT = 30
        const val MAX_QUERY = 256
    }
}

/**
 * Search's fusion (API.md, "Search" › Fusing results; the
 * client package's `fuseSearchResults()`): Reciprocal Rank Fusion of
 * the daemon's list and the phone's own. A remote result scores
 * `1 / (k + rank)`, a local one `1 / (k + p)` at its 1-based position; a
 * key in both is one result scored as the remote term plus the local term,
 * carrying the remote fields. Highest score first; then by remote rank,
 * results the daemon didn't return last; then by local position.
 */
object SearchFusion {
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
