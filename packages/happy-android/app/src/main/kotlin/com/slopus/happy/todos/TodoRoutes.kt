package com.slopus.happy.todos

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentClient.Companion.escape
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.connection.AgentConnectionException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * The todo routes the library uses (happy-agent API.md, "Todo routes"),
 * and the Surface creation the todo lists screen offers ("Surface catalog
 * and members"). [AgentTodoRoutes] is a connection's; tests give a fake.
 * Failures are [com.slopus.happy.agent.AgentApiException]s.
 */
interface TodoRoutes {
    suspend fun todos(surfaceId: String, scope: TodoItem.Status): List<TodoItem>
    suspend fun todo(surfaceId: String, todoId: String): TodoItem
    /** A new todo at the top; [id] is the creation's retry key, so a repeat answers the todo made the first time. */
    suspend fun create(surfaceId: String, id: String, text: String, mutationId: String): TodoItem
    suspend fun update(surfaceId: String, todoId: String, text: String?, status: TodoItem.Status?, ifMatch: String, mutationId: String): TodoItem
    suspend fun delete(surfaceId: String, todoId: String, ifMatch: String, mutationId: String): TodoItem
    suspend fun reorder(surfaceId: String, todoId: String, afterId: String?, ifMatch: String, mutationId: String): TodoItem
    /** Every revision, oldest first, following the pages. */
    suspend fun versions(surfaceId: String, todoId: String): List<TodoRevision>
    /** Team members' names by user ID (`GET /v0/users`); unknown ones are left out. */
    suspend fun names(ids: List<String>): Map<String, String>
}

class AgentTodoRoutes(private val client: AgentClient) : TodoRoutes {
    private fun path(surfaceId: String, todoId: String? = null, route: String? = null) =
        "/v0/surfaces/todo/${escape(surfaceId)}" + (todoId?.let { "/" + escape(it) } ?: "") + (route?.let { "/$it" } ?: "")

    private suspend fun call(method: String, path: String, body: JsonElement? = null, headers: Map<String, String> = emptyMap()): JsonObject {
        val response = client.send(method, path, body, headers)
        return try {
            AgentClient.json.parseToJsonElement(response.text).obj
        } catch (_: Exception) {
            null
        } ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }

    private fun todoOf(answer: JsonObject): TodoItem =
        TodoItem.parse(answer["todo"]) ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)

    override suspend fun todos(surfaceId: String, scope: TodoItem.Status): List<TodoItem> =
        call("GET", path(surfaceId) + "?scope=${scope.wire}")["todos"].arr.orEmpty().mapNotNull(TodoItem::parse)

    override suspend fun todo(surfaceId: String, todoId: String): TodoItem = todoOf(call("GET", path(surfaceId, todoId)))

    override suspend fun create(surfaceId: String, id: String, text: String, mutationId: String): TodoItem =
        todoOf(call("POST", path(surfaceId), buildJsonObject {
            put("id", JsonPrimitive(id))
            put("text", JsonPrimitive(text))
            put("mutationId", JsonPrimitive(mutationId))
        }))

    override suspend fun update(surfaceId: String, todoId: String, text: String?, status: TodoItem.Status?, ifMatch: String, mutationId: String): TodoItem =
        todoOf(call("PATCH", path(surfaceId, todoId), buildJsonObject {
            put("mutationId", JsonPrimitive(mutationId))
            text?.let { put("text", JsonPrimitive(it)) }
            status?.let { put("status", JsonPrimitive(it.wire)) }
        }, mapOf("If-Match" to ifMatch)))

    override suspend fun delete(surfaceId: String, todoId: String, ifMatch: String, mutationId: String): TodoItem =
        todoOf(call("DELETE", path(surfaceId, todoId), buildJsonObject { put("mutationId", JsonPrimitive(mutationId)) }, mapOf("If-Match" to ifMatch)))

    override suspend fun reorder(surfaceId: String, todoId: String, afterId: String?, ifMatch: String, mutationId: String): TodoItem =
        todoOf(call("POST", path(surfaceId, todoId, "reorder"), buildJsonObject {
            put("afterId", afterId?.let(::JsonPrimitive) ?: JsonNull)
            put("mutationId", JsonPrimitive(mutationId))
        }, mapOf("If-Match" to ifMatch)))

    override suspend fun versions(surfaceId: String, todoId: String): List<TodoRevision> {
        val revisions = ArrayList<TodoRevision>()
        var after: String? = null
        repeat(50) {
            val query = "?limit=200" + (after?.let { "&afterVersion=${escape(it)}" } ?: "")
            val answer = call("GET", path(surfaceId, todoId, "versions") + query)
            revisions += answer["versions"].arr.orEmpty().mapNotNull(TodoRevision::parse)
            val next = answer["nextAfterVersion"].str
            if (next == null || next == after) return revisions
            after = next
        }
        return revisions
    }

    override suspend fun names(ids: List<String>): Map<String, String> {
        if (ids.isEmpty()) return emptyMap()
        return ids.distinct().chunked(100).flatMap { batch ->
            val answer = call("GET", "/v0/users?ids=" + batch.joinToString(",") { escape(it) })
            answer["users"].arr.orEmpty().mapNotNull { user ->
                val o = user.obj ?: return@mapNotNull null
                val id = o["id"].str ?: return@mapNotNull null
                o["name"].str?.takeIf { it.isNotEmpty() }?.let { id to it }
            }
        }.toMap()
    }
}

/**
 * A new Surface of [type] named [name], joined by its maker
 * (`POST /v0/surfaces`); [id] is the retry key. Answers the Surface as the
 * agent wrote it, for the catalog to show at once.
 */
suspend fun AgentClient.createSurface(type: String, name: String, id: String = AgentClient.newId()): JsonObject {
    val response = send("POST", "/v0/surfaces", buildJsonObject {
        put("id", JsonPrimitive(id))
        put("type", JsonPrimitive(type))
        put("name", JsonPrimitive(name))
        put("mutationId", JsonPrimitive(AgentClient.newId()))
    })
    return try {
        AgentClient.json.parseToJsonElement(response.text).obj?.get("surface").obj
    } catch (_: Exception) {
        null
    } ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
}
