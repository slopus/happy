package com.slopus.happy.agent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/** The permissions a Happy Cloud server's teams grant (`GET /v0/permissions`), as the apps gate their controls by them. */
object Permission {
    const val CONTENT_WRITE = "content.write"
    /** Admin bots, the Chief of Staff among them, and messages to them. */
    const val BOTS_MANAGE = "bots.manage"
    /** Adding providers to one's own connection ("My account"). */
    const val PROVIDERS_OWN = "providers.own"
    /** Adding providers to the server's connections. */
    const val PROVIDERS_MANAGE = "providers.manage"
    /** Changing the computer's configuration: the default model. */
    const val CONFIG_MANAGE = "config.manage"
    /** Using machines, and adding a private one of one's own. */
    const val COMPUTE_USE = "compute.use"
    /** Adding machines in any mode, editing any, and freeing a held one. */
    const val POOLS_MANAGE = "pools.manage"
    /** Installing, setting up and removing plugins, as MCP servers take it. */
    const val MCP_MANAGE = "mcp.manage"
    /** Changing the server's instructions and security policy ([PolicyDocument]); owners. */
    const val POLICY_EDIT = "policy.edit"

    /**
     * A server's refusal for want of a permission (`403 { "error":
     * "This needs the <id> permission.", "code": "forbidden" }`). A
     * computer's own `forbidden`, in words of its own, isn't one.
     */
    fun refused(status: Int, code: String?, message: String?): Boolean =
        status == 403 && code == "forbidden" && message != null && message.startsWith("This needs the ") && message.endsWith(" permission.")
}

/**
 * What the person may do on a connection. A Happy Cloud server [gated]s
 * its controls by the [granted] permissions of the person's teams
 * (docs/teams.md); until they are read, or when reading them failed,
 * nothing is granted, so no control shows only to be refused. Any other
 * server decides for itself: nothing gated. Controls follow [granted]
 * alone, never [owner] or [teams]: owners are granted everything.
 */
data class ServerPermissions(
    val gated: Boolean,
    val granted: Set<String> = emptySet(),
    /** Whether the person owns the server: the owner flag, or before teams the owner role. */
    val owner: Boolean = false,
    /** Every team the person is in, nested ones included (`members` always); empty from a server before teams. */
    val teams: Set<String> = emptySet(),
    /** Every permission the server has (`permissions[].id`, its catalog), granted or not: what it serves. Empty where it doesn't say. */
    val known: Set<String> = emptySet(),
) {
    fun allows(permission: String): Boolean = !gated || permission in granted

    /** Whether the server has [permission] at all, for anyone. */
    fun knows(permission: String): Boolean = permission in known

    val canWrite: Boolean get() = allows(Permission.CONTENT_WRITE)

    companion object {
        val Ungated = ServerPermissions(gated = false)
        val Unknown = ServerPermissions(gated = true)

        /**
         * `{ "granted": [id], "owner"?, "teams"?: [id], "role"?, "permissions": [{ "id" }]? }`;
         * null for anything else. A server before teams sends `role` instead of `owner` and `teams`.
         */
        fun parse(body: JsonObject): ServerPermissions? {
            val granted = body["granted"] as? JsonArray ?: return null
            return ServerPermissions(
                gated = true,
                granted = granted.strings(),
                owner = (body["owner"] as? JsonPrimitive)?.booleanOrNull ?: ((body["role"] as? JsonPrimitive)?.contentOrNull == "owner"),
                teams = (body["teams"] as? JsonArray).orEmpty().strings(),
                known = (body["permissions"] as? JsonArray).orEmpty().mapNotNull { ((it as? JsonObject)?.get("id") as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull }.toSet(),
            )
        }

        private fun List<JsonElement>.strings(): Set<String> = mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull }.toSet()
    }
}

/**
 * A Happy Cloud server's permissions for this person, read on every
 * connect and on `team.*` and `member.updated` events, and `role.*` from a
 * server before teams.
 */
internal class AgentPermissionsSource(
    private val read: suspend () -> JsonObject,
    events: SharedFlow<AgentEvent>,
    scope: CoroutineScope,
) {
    private val state = MutableStateFlow(ServerPermissions.Unknown)
    val permissions: StateFlow<ServerPermissions> = state.asStateFlow()

    init {
        // Subscribed before the link's first hello can come.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            // What a team grants, and who is in it, change with team.*; a person's own teams and owner flag with
            // member.updated. A server before teams changes a role (role.*) or gives a member another (member.updated).
            events.collect { if (it.type == AgentEvent.HELLO || it.type.startsWith("team.") || it.type.startsWith("role.") || it.type == "member.updated") reload() }
        }
    }

    private suspend fun reload() {
        state.value = try {
            ServerPermissions.parse(read()) ?: ServerPermissions.Unknown
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            ServerPermissions.Unknown
        }
    }
}
