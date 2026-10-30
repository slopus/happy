package com.slopus.happy.agent

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Everything an agent connection's home is drawn from, kept as the agent
 * sent it so the journal's `changes` merge straight in (API.md, "Event
 * types"): projects, workspaces, bots, tasks, the caller's task
 * memberships, and every conversation by id. Immutable; each change is a
 * new copy. Agents embedded in their owners are also indexed in [agents],
 * where the copy with the greater `version` wins, so a delayed owner
 * snapshot never undoes a newer `agent.updated`.
 */
@Serializable
data class AgentCatalog(
    val projects: Map<String, JsonObject> = emptyMap(),
    val workspaces: Map<String, JsonObject> = emptyMap(),
    val bots: Map<String, JsonObject> = emptyMap(),
    val tasks: Map<String, JsonObject> = emptyMap(),
    /** By task id: the caller's memberships, which say which tasks are in their list and where. */
    val memberships: Map<String, JsonObject> = emptyMap(),
    val agents: Map<String, JsonObject> = emptyMap(),
    /** The journal position everything here is current to. */
    val cursor: String? = null,
    /** A snapshot has been read (or the cached one restored). */
    val loaded: Boolean = false,
) {
    /** The resources a broken version chain left behind, to read again. */
    data class Stale(val kind: String, val id: String)

    /** The result of applying one event: the new catalog and what must be refetched. */
    data class Applied(val catalog: AgentCatalog, val stale: List<Stale> = emptyList())

    fun agent(id: String): WireAgent? = agents[id]?.let(::decodeAgent)

    /** The whole snapshot from `GET /v0/bootstrap/desktop`, replacing what was here. */
    fun withBootstrap(bootstrap: WireDesktopBootstrap): AgentCatalog {
        val index = HashMap<String, JsonObject>()
        fun owners(list: List<JsonObject>) = list.mapNotNull { owner -> owner.string("id")?.let { it to indexOwner(owner, index) } }.toMap()
        // Agents read anew win over older cached copies, never over newer ones a live event left.
        agents.forEach { (id, agent) -> index[id] = agent }
        return AgentCatalog(
            projects = owners(bootstrap.projects),
            workspaces = owners(bootstrap.workspaces),
            bots = owners(bootstrap.bots),
            tasks = owners(bootstrap.tasks),
            memberships = bootstrap.taskMemberships.mapNotNull { m -> m.string("taskId")?.let { it to m } }.toMap(),
            agents = index,
            cursor = bootstrap.cursor ?: cursor,
            loaded = true,
        )
    }

    /** A task as `POST /v0/tasks` or `GET /v0/tasks/:id` answered it, with the caller's membership. */
    fun withTask(task: JsonObject, membership: JsonObject? = null): AgentCatalog {
        val id = task.string("id") ?: return this
        val index = HashMap(agents)
        if (!newer(task, tasks[id])) return this
        val kept = indexOwner(task, index)
        val joined = membership ?: memberships[id]
            ?: JsonObject(mapOf("taskId" to JsonPrimitive(id), "orderKey" to JsonPrimitive(topOrderKey())))
        return copy(tasks = tasks + (id to kept), memberships = memberships + (id to joined), agents = index)
    }

    /** One conversation as read on its own (bootstrap, `GET /v0/agents/:id`); the newer copy wins. */
    fun withAgent(agent: JsonObject): AgentCatalog {
        val index = HashMap(agents)
        putAgent(agent, index)
        return if (index == agents) this else copy(agents = index)
    }

    /** [event] applied, for the kinds home shows; anything else leaves the catalog as it is. */
    fun apply(event: AgentEvent): Applied {
        val data = event.data
        val moved = event.cursor?.let { copy(cursor = it) } ?: this
        return when (event.type) {
            "project.created" -> moved.created(data["project"], "project")
            "workspace.created" -> moved.created(data["workspace"], "workspace")
            "bot.created" -> moved.created(data["bot"], "bot")
            "task.created" -> moved.created(data["task"], "task")
            "agent.created" -> Applied(moved.agentCreated(data["agent"] as? JsonObject ?: return Applied(moved)))
            "project.updated" -> moved.updated("project", data.string("projectId"), data)
            "workspace.updated" -> moved.updated("workspace", data.string("workspaceId"), data)
            "bot.updated" -> moved.updated("bot", data.string("botId"), data)
            "task.updated" -> moved.updated("task", data.string("taskId"), data)
            "agent.updated" -> moved.updated("agent", data.string("agentId"), data)
            "task.joined", "task.reordered" -> {
                val membership = data["membership"] as? JsonObject
                val taskId = membership?.string("taskId")
                if (membership == null || taskId == null) {
                    Applied(moved)
                } else {
                    Applied(moved.copy(memberships = memberships + (taskId to membership)), if (taskId in tasks) emptyList() else listOf(Stale("task", taskId)))
                }
            }
            "task.left" -> {
                val taskId = (data["membership"] as? JsonObject)?.string("taskId")
                Applied(if (taskId == null) moved else moved.copy(memberships = memberships - taskId))
            }
            else -> Applied(moved)
        }
    }

    private fun created(value: JsonElement?, kind: String): Applied {
        val resource = value as? JsonObject ?: return Applied(this)
        val id = resource.string("id") ?: return Applied(this)
        val index = HashMap(agents)
        val map = map(kind)
        if (!newer(resource, map[id])) return Applied(this)
        val kept = indexOwner(resource, index)
        return Applied(with(kind, map + (id to kept)).copy(agents = index))
    }

    private fun agentCreated(agent: JsonObject): AgentCatalog {
        val id = agent.string("id") ?: return this
        val index = HashMap(agents)
        putAgent(agent, index)
        // A new subtask goes first among its siblings (API.md, `subtaskOrderKey`).
        val parentId = agent.string("parentAgentId")
        if (parentId != null && agent["subtask"] == JsonPrimitive(true)) {
            index[parentId]?.let { parent ->
                val siblings = (parent["subtasks"] as? JsonArray).orEmpty()
                if (siblings.none { (it as? JsonObject)?.string("id") == id }) {
                    index[parentId] = JsonObject(parent + ("subtasks" to JsonArray(listOf(agent) + siblings)))
                }
            }
        }
        return copy(agents = index)
    }

    /**
     * A version-chained `*.updated`: merged when the copy here is the one it
     * replaced; merged and read again when this copy is older but not that
     * one (an update was missed); ignored when this copy is newer.
     */
    private fun updated(kind: String, id: String?, data: JsonObject): Applied {
        if (id == null) return Applied(this)
        val version = data.string("version") ?: return Applied(this)
        val changes = data["changes"] as? JsonObject ?: JsonObject(emptyMap())
        val current = if (kind == "agent") agents[id] else map(kind)[id]
        if (current == null) return Applied(this, if (kind == "agent") emptyList() else listOf(Stale(kind, id)))
        val have = current.string("version")
        if (have != null && have >= version) return Applied(this)
        val chained = have == data.string("previousVersion")
        val merged = JsonObject(current + changes + ("version" to JsonPrimitive(version)))
        val index = HashMap(agents)
        val next = if (kind == "agent") {
            putAgent(merged, index, force = true)
            copy(agents = index)
        } else {
            with(kind, map(kind) + (id to indexOwner(merged, index))).copy(agents = index)
        }
        return Applied(next, if (chained) emptyList() else listOf(Stale(kind, id)))
    }

    private fun map(kind: String): Map<String, JsonObject> = when (kind) {
        "project" -> projects
        "workspace" -> workspaces
        "bot" -> bots
        "task" -> tasks
        else -> agents
    }

    /** [map] in place of the [kind] map; a re-read resource the same as an event one. */
    fun with(kind: String, map: Map<String, JsonObject>): AgentCatalog = when (kind) {
        "project" -> copy(projects = map)
        "workspace" -> copy(workspaces = map)
        "bot" -> copy(bots = map)
        "task" -> copy(tasks = map)
        else -> copy(agents = map)
    }

    /** A resource read again after a broken chain; the newer copy wins. */
    fun withResource(kind: String, resource: JsonObject): AgentCatalog {
        if (kind == "agent") return withAgent(resource)
        val id = resource.string("id") ?: return this
        val map = map(kind)
        if (!newer(resource, map[id])) return this
        val index = HashMap(agents)
        return with(kind, map + (id to indexOwner(resource, index))).copy(agents = index)
    }

    /** An order key before every membership's, for a task made here before its `task.joined` comes. */
    private fun topOrderKey(): String {
        val first = memberships.values.mapNotNull { it.string("orderKey") }.minOrNull() ?: return "a"
        return if (first.isEmpty()) "" else first.substring(0, first.length - 1) + (first.last() - 1)
    }

    companion object {
        /** Stores [owner]'s embedded agents (`agents`, `agent`) in [index]; the owner keeps them as sent. */
        internal fun indexOwner(owner: JsonObject, index: MutableMap<String, JsonObject>): JsonObject {
            (owner["agents"] as? JsonArray)?.forEach { (it as? JsonObject)?.let { agent -> putAgent(agent, index) } }
            (owner["agent"] as? JsonObject)?.let { putAgent(it, index) }
            return owner
        }

        /** [agent] and its subtask tree into [index], each copy kept only when newer. */
        internal fun putAgent(agent: JsonObject, index: MutableMap<String, JsonObject>, force: Boolean = false) {
            val id = agent.string("id") ?: return
            (agent["subtasks"] as? JsonArray)?.forEach { (it as? JsonObject)?.let { child -> putAgent(child, index) } }
            if (force || newer(agent, index[id])) index[id] = agent
        }

        /** Whether [candidate] is at least as new as [current] (UUIDv7 versions compare as text). */
        internal fun newer(candidate: JsonObject, current: JsonObject?): Boolean {
            val have = current?.string("version") ?: return true
            val next = candidate.string("version") ?: return false
            return next >= have
        }

        fun decodeAgent(agent: JsonObject): WireAgent? = try {
            AgentClient.json.decodeFromJsonElement(WireAgent.serializer(), agent)
        } catch (_: Exception) {
            null
        }
    }
}
