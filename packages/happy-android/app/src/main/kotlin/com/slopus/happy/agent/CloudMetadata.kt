package com.slopus.happy.agent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.decodeFromJsonElement

/** Someone a restricted zone admits (Zones v2): a person by their user ID, or everyone in a team. */
internal data class ZonePrincipal(val kind: Kind, val id: String) {
    enum class Kind { User, Team }
}

/** Whether a zone's agents reach the internet. */
internal enum class ZoneInternet { On, Off }

/** Which computers a zone's agents may use: any that list no zone or this one, only those that list it, or none. */
internal enum class ZoneCompute { Any, Listed, None }

/**
 * A zone as `GET /v0/zones` lists it (happy-cluster docs/zones.md): open to
 * every member, or [restricted] to the people and teams in [members]; its
 * [internet] and [compute] replace the server defaults for the agents in it
 * (null where the server doesn't say). Read tolerantly, since a server from
 * before Zones v2 sends `critical` for restricted, members as bare user IDs
 * (a list restricting the zone to them), a default zone, and no settings.
 */
internal data class CloudZone(
    val id: String,
    val name: String,
    val description: String = "",
    val color: String = "gray",
    val restricted: Boolean = false,
    val members: List<ZonePrincipal> = emptyList(),
    val internet: ZoneInternet? = null,
    val compute: ZoneCompute? = null,
) {
    companion object {
        /** [zone] as a zone; null without an ID or a name. */
        fun parse(zone: JsonObject): CloudZone? {
            val id = zone.string("id") ?: return null
            val name = zone.string("name") ?: return null
            val members = zone["members"] as? JsonArray
            val settings = zone["settings"] as? JsonObject
            return CloudZone(
                id = id,
                name = name,
                description = zone.string("description").orEmpty(),
                color = zone.string("color") ?: "gray",
                // Zones v2 made a critical zone restricted, and any other zone with a members list restricted to it.
                restricted = zone.boolean("restricted") ?: (zone.boolean("critical") == true || members != null),
                members = members.orEmpty().mapNotNull(::principal),
                internet = when (settings?.string("internet")) {
                    "on" -> ZoneInternet.On
                    "off" -> ZoneInternet.Off
                    else -> null
                },
                compute = when (settings?.string("compute")) {
                    "any" -> ZoneCompute.Any
                    "listed" -> ZoneCompute.Listed
                    "none" -> ZoneCompute.None
                    else -> null
                },
            )
        }

        /** `{ "kind": "user" | "team", "id" }`, or a bare string, a user ID; null for a kind this build doesn't know. */
        private fun principal(element: JsonElement): ZonePrincipal? {
            (element as? JsonPrimitive)?.takeIf { it.isString }?.let { return ZonePrincipal(ZonePrincipal.Kind.User, it.content) }
            val entry = element as? JsonObject ?: return null
            val id = entry.string("id") ?: return null
            return when (entry.string("kind")) {
                "user" -> ZonePrincipal(ZonePrincipal.Kind.User, id)
                "team" -> ZonePrincipal(ZonePrincipal.Kind.Team, id)
                else -> null
            }
        }

        private fun JsonObject.boolean(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
    }
}

/** Only the metadata displayed in settings. No secret values are decoded or fetched. */
@Serializable
internal data class CloudSecretMetadata(
    val id: String,
    val name: String,
    val description: String? = null,
    val owner: String? = null,
)

internal suspend fun AgentClient.cloudZones(): List<CloudZone> = withContext(Dispatchers.IO) {
    (metadataObject("/v0/zones").getValue("zones") as JsonArray).mapNotNull { (it as? JsonObject)?.let(CloudZone::parse) }
}

/** The server's teams' names by ID (`GET /v0/teams`); empty from a server before teams, or one that can't list them. */
internal suspend fun AgentClient.cloudTeamNames(): Map<String, String> = withContext(Dispatchers.IO) {
    try {
        TeamMembers.teams(this@cloudTeamNames).associate { it.id to it.name }
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        emptyMap()
    }
}

internal suspend fun AgentClient.cloudSecretMetadata(): List<CloudSecretMetadata> = withContext(Dispatchers.IO) {
    val path = "/v0/cluster/secrets?limit=100"
    val secrets = mutableListOf<CloudSecretMetadata>()
    val cursors = mutableSetOf<String>()
    var cursor: String? = null
    do {
        ensureActive()
        val page = metadataObject(path + (cursor?.let { "&cursor=${AgentClient.escape(it)}" } ?: ""))
        secrets += page.rows<CloudSecretMetadata>("secrets")
        cursor = page.string("nextCursor")
        check(cursor == null || cursors.add(cursor)) { "Repeated secrets cursor" }
    } while (cursor != null)
    secrets
}

internal suspend fun AgentClient.cloudZoneMemberNames(ids: Set<String>, known: Map<String, String>): Map<String, String> = withContext(Dispatchers.IO) {
    buildMap {
        putAll(known)
        for (chunk in (ids - known.keys).sorted().chunked(100)) {
            ensureActive()
            try {
                val answer = metadataObject("/v0/users?ids=" + chunk.joinToString(",") { AgentClient.escape(it) })
                TeamUser.parse(answer["users"] as? JsonArray).forEach { if (it.name.isNotBlank()) put(it.id, it.name) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Unresolved users keep their IDs; a names lookup cannot hide the zone.
            }
        }
    }
}

private suspend fun AgentClient.metadataObject(path: String): JsonObject = decode(JsonObject.serializer(), "GET", path)

private inline fun <reified T> JsonObject.rows(key: String): List<T> = (getValue(key) as JsonArray).mapNotNull {
    runCatching { AgentClient.json.decodeFromJsonElement<T>(it) }.getOrNull()
}
