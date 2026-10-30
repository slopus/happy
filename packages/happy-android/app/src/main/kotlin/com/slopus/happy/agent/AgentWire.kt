package com.slopus.happy.agent

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/*
 * The agent connection's catalog as happy-agent API.md defines it: the
 * fields the phone reads, everything else skipped. Conversations are
 * agents; bots, tasks, projects and workspaces own them.
 */

/** Why an agent is unread, and since when (API.md, "The agent object"). */
@Serializable
data class WireUnread(val reason: String? = null, val since: Long? = null)

/** An active scheduled wait (`wait`). */
@Serializable
data class WireWait(val startedAt: Long? = null, val dueAt: Long? = null)

/** One conversation: `GET /v0/agents/:agentId`'s `agent`. */
@Serializable
data class WireAgent(
    val id: String,
    val workspaceId: String,
    val parentAgentId: String? = null,
    val subtask: Boolean = false,
    /** The direct active subtasks, in sibling order, each with its own. */
    val subtasks: List<WireAgent> = emptyList(),
    val subtaskOrderKey: String? = null,
    /** Absent on older daemons: then a parentless agent is visible. */
    val userVisible: Boolean? = null,
    val managedByAnotherAgent: Boolean? = null,
    val canSendMessages: Boolean? = null,
    val title: String? = null,
    val titleStatus: String? = null,
    /** `idle`, `thinking`, `working`, `generating_tools` or `running_tools`. */
    val status: String = "idle",
    val wait: WireWait? = null,
    val retrying: JsonElement? = null,
    val pendingQuestionId: String? = null,
    val unread: WireUnread? = null,
    val orderKey: String? = null,
    val lastCursor: String? = null,
    val version: String,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val archivedAt: Long? = null,
) {
    val visible: Boolean get() = userVisible ?: (parentAgentId == null)
    val sendable: Boolean get() = canSendMessages ?: (parentAgentId == null && archivedAt == null)
    val working: Boolean get() = status != "idle"
}

/** A picture: `image` with a ThumbHash placeholder, or the home project's `home`. */
@Serializable
data class WireAvatar(val kind: String? = null, val thumbhash: String? = null, val source: String? = null)

@Serializable
data class WireBot(
    val id: String,
    val name: String,
    val username: String? = null,
    val systemKey: String? = null,
    val workspaceId: String? = null,
    val status: String = "active",
    val avatar: WireAvatar? = null,
    val agent: WireAgent? = null,
    val orderKey: String? = null,
    val version: String,
    val archivedAt: Long? = null,
)

@Serializable
data class WireTask(
    val id: String,
    val name: String,
    val workspaceId: String? = null,
    val ownerUserId: String? = null,
    val status: String = "active",
    val canArchive: Boolean? = null,
    val agent: WireAgent? = null,
    val version: String,
    val createdAt: Long = 0,
    val archivedAt: Long? = null,
)

/** The caller's place in a task's list. */
@Serializable
data class WireMembership(val taskId: String, val userId: String? = null, val orderKey: String? = null, val joinedAt: Long = 0)

/** A project, which is also its own root workspace. */
@Serializable
data class WireProject(
    val id: String,
    val name: String,
    val status: String = "active",
    val avatar: WireAvatar? = null,
    val agents: List<WireAgent> = emptyList(),
    val orderKey: String? = null,
    val version: String,
    val archivedAt: Long? = null,
)

@Serializable
data class WireWorkspace(
    val id: String,
    val projectId: String? = null,
    val parentId: String? = null,
    val name: String,
    val kind: String? = null,
    val status: String = "active",
    val botId: String? = null,
    val taskId: String? = null,
    val subtaskAgentId: String? = null,
    val agents: List<WireAgent> = emptyList(),
    val orderKey: String? = null,
    val version: String,
    val archivedAt: Long? = null,
)

@Serializable
data class WireProfilePhoto(val thumbhash: String? = null)

@Serializable
data class WireProfile(val userId: String? = null, val name: String? = null, val photo: WireProfilePhoto? = null, val version: String? = null)

/**
 * `GET /v0/bootstrap/desktop`, the part home reads: everything is kept as
 * sent ([JsonObject]) so the live journal can merge `changes` into it.
 */
@Serializable
data class WireDesktopBootstrap(
    val projects: List<JsonObject> = emptyList(),
    val workspaces: List<JsonObject> = emptyList(),
    val bots: List<JsonObject> = emptyList(),
    val tasks: List<JsonObject> = emptyList(),
    val taskMemberships: List<JsonObject> = emptyList(),
    val profile: JsonObject? = null,
    val cursor: String? = null,
)

/** `x` of [o] when it is a JSON string. */
internal fun JsonObject.string(key: String): String? =
    (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content

internal fun JsonElement?.isNullish(): Boolean = this == null || this is JsonNull
