package com.slopus.happy.agent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

/** A null member list admits the whole team. An empty list admits no members. */
@Serializable
internal data class CloudZone(
    val id: String,
    val name: String,
    val description: String,
    val color: String,
    val critical: Boolean,
    val isDefault: Boolean,
    val members: List<String>?,
)

/** Only the metadata displayed in settings. No secret values are decoded or fetched. */
@Serializable
internal data class CloudSecretMetadata(
    val id: String,
    val name: String,
    val description: String? = null,
    val owner: String? = null,
)

internal suspend fun AgentClient.cloudZones(): List<CloudZone> = withContext(Dispatchers.IO) {
    metadataObject("/v0/zones").rows("zones")
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
