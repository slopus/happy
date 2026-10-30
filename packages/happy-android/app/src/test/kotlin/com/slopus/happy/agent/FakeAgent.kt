package com.slopus.happy.agent

import com.slopus.happy.connection.ByteSource
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.connection.TransportStream
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Builders for the agent's JSON, with only what home reads. */
object Wire {
    fun agent(
        id: String, workspaceId: String = "w$id", version: String = "01", title: String? = null, status: String = "idle",
        unread: Boolean = false, question: Boolean = false, subtask: Boolean = false, parent: String? = null,
        subtasks: List<JsonObject> = emptyList(), archivedAt: Long? = null, orderKey: String? = null, visible: Boolean = true,
        updatedAt: Long = 2L,
    ) = buildJsonObject {
        put("id", id); put("workspaceId", workspaceId); put("version", version); put("status", status)
        put("parentAgentId", parent); put("subtask", subtask); put("userVisible", visible)
        put("title", title); put("titleStatus", if (title == null) "idle" else "ready")
        put("pendingQuestionId", if (question) "q$id" else null)
        put("unread", if (unread) buildJsonObject { put("reason", "turn_finished"); put("since", 5L) } else kotlinx.serialization.json.JsonNull)
        put("subtasks", JsonArray(subtasks)); put("orderKey", orderKey); put("archivedAt", archivedAt)
        put("createdAt", 1L); put("updatedAt", updatedAt)
    }

    fun bot(id: String, name: String, agent: JsonObject, orderKey: String = "1", version: String = "01", archived: Boolean = false) = buildJsonObject {
        put("id", id); put("name", name); put("version", version); put("orderKey", orderKey)
        put("status", if (archived) "archived" else "active"); put("archivedAt", if (archived) 9L else null)
        put("agent", agent)
    }

    fun task(id: String, name: String, agent: JsonObject, version: String = "01", archived: Boolean = false) = buildJsonObject {
        put("id", id); put("name", name); put("version", version)
        put("status", if (archived) "archived" else "active"); put("archivedAt", if (archived) 9L else null)
        put("agent", agent)
    }

    fun membership(taskId: String, orderKey: String) = buildJsonObject { put("taskId", taskId); put("orderKey", orderKey) }

    fun project(id: String, name: String, agents: List<JsonObject>, orderKey: String = "1", version: String = "01") = buildJsonObject {
        put("id", id); put("name", name); put("version", version); put("orderKey", orderKey); put("status", "active")
        put("agents", JsonArray(agents))
    }

    fun workspace(id: String, projectId: String, name: String, agents: List<JsonObject>, orderKey: String = "1") = buildJsonObject {
        put("id", id); put("projectId", projectId); put("parentId", projectId); put("name", name); put("version", "01")
        put("orderKey", orderKey); put("status", "active"); put("agents", JsonArray(agents))
    }

    fun bootstrap(
        projects: List<JsonObject> = emptyList(), workspaces: List<JsonObject> = emptyList(), bots: List<JsonObject> = emptyList(),
        tasks: List<JsonObject> = emptyList(), memberships: List<JsonObject> = emptyList(), cursor: String = "c0",
    ) = buildJsonObject {
        put("projects", JsonArray(projects)); put("workspaces", JsonArray(workspaces)); put("bots", JsonArray(bots))
        put("tasks", JsonArray(tasks)); put("taskMemberships", JsonArray(memberships)); put("cursor", cursor)
    }

    fun event(cursor: String, type: String, payload: JsonObject) = AgentEvent(cursor, type, payload)

    fun updated(idKey: String, id: String, previous: String, version: String, changes: JsonObject) = buildJsonObject {
        put(idKey, id); put("previousVersion", previous); put("version", version); put("changes", changes)
    }

    /** One SSE frame as the daemon writes it. */
    fun frame(cursor: String, type: String, payload: JsonObject): String {
        val envelope = buildJsonObject { put("cursor", cursor); put("type", type); put("occurredAt", 1L); put("payload", payload) }
        return "id: $cursor\nevent: $type\ndata: $envelope\n\n"
    }

    fun hello(cursor: String, gap: Boolean = false) =
        "event: hello\ndata: {\"cursor\":\"$cursor\",\"gap\":$gap,\"resumed\":${!gap},\"daemonId\":\"d1\"}\n\n"
}

/**
 * A Happy Agent behind the phone's transport: health, config, the desktop
 * bootstrap and `/v0/events/stream`, whose frames a test sends through
 * [frames] (chunked, as the daemon writes them).
 */
class FakeAgent(var bootstrap: JsonObject = Wire.bootstrap(), var name: String = "Studio") : Transport {
    val calls = mutableListOf<String>()
    val streamCursors = mutableListOf<String?>()
    var frames = Channel<String>(Channel.UNLIMITED)
    var revoked = false
    var resources = mutableMapOf<String, JsonObject>()

    override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>): TransportResponse {
        calls += "$method $path"
        if (revoked) return TransportResponse(401, body = "{\"code\":\"unauthorized\"}".toByteArray())
        fun ok(text: String) = TransportResponse(200, mapOf("content-type" to "application/json"), text.toByteArray())
        return when (path) {
            "/v0/health" -> ok("{\"ready\":true,\"version\":{\"protocol\":30,\"daemon\":\"1.0\"}}")
            "/v0/config" -> ok("{\"config\":{\"node\":{\"name\":\"$name\",\"avatar\":null}}}")
            "/v0/bootstrap/desktop" -> ok(bootstrap.toString())
            else -> resources[path]?.let { ok(it.toString()) } ?: TransportResponse(404, body = "{\"error\":\"Not found.\",\"code\":\"not_found\"}".toByteArray())
        }
    }

    override suspend fun stream(path: String, credential: String, headers: Map<String, String>, silenceMillis: Long): TransportStream {
        calls += "STREAM $path"
        streamCursors += headers["Last-Event-ID"]
        val channel = frames
        var headSent = false
        return TransportStream.open(object : ByteSource {
            override suspend fun read(): ByteArray {
                if (!headSent) {
                    headSent = true
                    return "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n".toByteArray()
                }
                val text = channel.receiveCatching().getOrNull() ?: return ByteArray(0)
                val bytes = text.toByteArray()
                return "${bytes.size.toString(16)}\r\n".toByteArray() + bytes + "\r\n".toByteArray()
            }

            override fun close() {}
        })
    }

    override suspend fun close() {}
}

fun JsonObject.with(key: String, value: Any?): JsonObject = JsonObject(this + (key to when (value) {
    null -> kotlinx.serialization.json.JsonNull
    is String -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    is kotlinx.serialization.json.JsonElement -> value
    else -> error("unsupported")
}))
