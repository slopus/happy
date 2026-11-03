package com.slopus.happy.agent

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A tab is one member's entry on one connection, never a global kind singleton. */
object TabOpening {
    data class Reference(val kind: String, val id: String, val name: String)
    sealed interface Action {
        data object None : Action
        data class Join(val id: String) : Action
        data class Create(val reference: Reference) : Action
    }

    fun action(kind: String, id: String, snapshot: JsonObject): Action {
        if (kind == "surface") return Action.Join(id)
        val reference = when (kind) {
            "agent" -> listOf("bot", "task").firstNotNullOfOrNull { ownerKind ->
                (snapshot[ownerKind + "s"] as? JsonArray)?.filterIsInstance<JsonObject>()?.firstNotNullOfOrNull { owner ->
                    val ownerId = owner.string("id")
                    if ((owner["agent"] as? JsonObject)?.string("id") == id && ownerId != null)
                        Reference(ownerKind, ownerId, owner.string("name") ?: "Untitled") else null
                }
            } ?: return Action.None
            "artifact" -> Reference(kind, id, "Untitled")
            else -> return Action.None
        }
        val user = (snapshot["profile"] as? JsonObject)?.string("userId")
        val matches = (snapshot["surfaces"] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty().filter { tab ->
            val target = tab["target"] as? JsonObject
            target?.string("state") == "available" && target.string("type") == reference.kind && target.string(reference.kind + "Id") == reference.id
        }
        if (matches.any { tab -> (tab["members"] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty().any { it.string("userId") == user } }) return Action.None
        val own = matches.firstOrNull { it.string("creatorUserId") == user }?.string("id")
        return own?.let(Action::Join) ?: Action.Create(reference)
    }
}

internal suspend fun AgentClient.openTab(kind: String, id: String, mutationId: String) {
    val snapshot = if (kind == "surface") JsonObject(emptyMap()) else {
        val bootstrap = AgentClient.json.parseToJsonElement(send("GET", "/v0/bootstrap/desktop").text) as JsonObject
        val catalog = AgentClient.json.parseToJsonElement(send("GET", "/v0/surfaces").text) as JsonObject
        JsonObject(bootstrap + ("surfaces" to (catalog["surfaces"] ?: JsonArray(emptyList()))))
    }
    when (val action = TabOpening.action(kind, id, snapshot)) {
        TabOpening.Action.None -> Unit
        is TabOpening.Action.Join -> send("POST", "/v0/surfaces/${AgentClient.escape(action.id)}/join", buildJsonObject { put("mutationId", mutationId) })
        is TabOpening.Action.Create -> send("POST", "/v0/surfaces", buildJsonObject {
            put("id", mutationId); put("mutationId", mutationId)
            put("type", action.reference.kind); put("name", action.reference.name)
            put(action.reference.kind + "Id", action.reference.id)
        })
    }
}

sealed interface TabDestination {
    data class Content(val type: String, val name: String) : TabDestination
    data class Artifact(val id: String, val name: String) : TabDestination
    data class Conversation(val agentId: String) : TabDestination
}

/** Resolve through this connection only; unavailable targets never become navigable. */
suspend fun AgentClient.resolveTab(id: String): TabDestination? = withContext(Dispatchers.IO) {
    val response = AgentClient.json.parseToJsonElement(send("GET", "/v0/surfaces/${AgentClient.escape(id)}").text) as? JsonObject
    val tab = response?.get("surface") as? JsonObject ?: return@withContext null
    val type = tab.string("type") ?: return@withContext null
    val target = tab["target"] as? JsonObject
    val name = target?.string("name") ?: tab.string("name").orEmpty()
    if (type !in listOf("bot", "task", "artifact")) return@withContext TabDestination.Content(type, name)
    if (target?.string("state") != "available") return@withContext null
    val targetId = target.string(type + "Id") ?: return@withContext null
    if (type == "artifact") return@withContext TabDestination.Artifact(targetId, name)
    val snapshot = AgentClient.json.parseToJsonElement(send("GET", "/v0/bootstrap/desktop").text) as? JsonObject
    val owners = snapshot?.get(type + "s") as? JsonArray
    val owner = owners?.filterIsInstance<JsonObject>()?.firstOrNull { it.string("id") == targetId }
    val agent = owner?.get("agent") as? JsonObject
    agent?.string("id")?.let(TabDestination::Conversation)
}