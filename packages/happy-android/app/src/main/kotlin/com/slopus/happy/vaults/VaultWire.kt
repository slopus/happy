package com.slopus.happy.vaults

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentClient
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/*
 * A vault Surface's wire shapes (happy-agent API.md, "Vault Surfaces";
 * happy-agent-client `protocol/vaults.ts`). Read with [AgentClient.json],
 * so fields the wire adds later are skipped.
 */

/** Who made a change: a person, an agent, both, or neither (standalone). */
@Immutable
@Serializable
data class VaultActor(val userId: String? = null, val agentId: String? = null)

/** One file of an artifact version's bundle, as the artifact file object. */
@Immutable
@Serializable
data class VaultArtifactFile(val path: String, val mimeType: String? = null, val size: Long = 0, val sha256: String? = null)

/**
 * An app's kind: `html` (`index.html`) or `markdown` (`index.md`),
 * [entry] the file a client opens. [files] only on a single-version read.
 */
@Immutable
@Serializable
data class VaultArtifact(val type: String, val entry: String, val fileCount: Int = 0, val files: List<VaultArtifactFile>? = null)

/**
 * One item of a vault's tree: a folder, or a file, plain or an artifact,
 * which people know as an app (its name ends in ".artifact"). The wire's folder and file are one
 * shape here, told apart by [kind]; a folder has no content fields.
 * [version] is the resource version (UUIDv7) every change advances;
 * [latestVersion] a file's newest numbered content version.
 */
@Immutable
@Serializable
data class VaultItem(
    val id: String,
    val surfaceId: String = "",
    val parentId: String? = null,
    val name: String,
    val kind: String,
    val latestVersion: Int? = null,
    val size: Long? = null,
    val sha256: String? = null,
    val mediaType: String? = null,
    val artifact: VaultArtifact? = null,
    val createdAt: Long = 0,
    val createdBy: VaultActor = VaultActor(),
    val updatedAt: Long = 0,
    val updatedBy: VaultActor = VaultActor(),
    val deletedAt: Long? = null,
    val version: String,
) {
    val isFolder: Boolean get() = kind == FOLDER
    val isArtifact: Boolean get() = kind == ARTIFACT
    val isFile: Boolean get() = kind == FILE

    /** [name] as people read it: an app's without its ".artifact". */
    val shownName: String get() = VaultNames.shown(name)

    /** [changes] of a `vault.folder.updated` or `vault.file.updated` laid over this item, now at [version]. Null when they don't read. */
    fun changed(changes: JsonObject, version: String): VaultItem? = try {
        val held = AgentClient.json.encodeToJsonElement(serializer(), this).jsonObject
        AgentClient.json.decodeFromJsonElement(serializer(), JsonObject(held + changes + ("version" to JsonPrimitive(version))))
    } catch (_: Exception) {
        null
    }

    companion object {
        const val FOLDER = "folder"
        const val FILE = "file"
        const val ARTIFACT = "artifact"

        fun parse(value: JsonElement?): VaultItem? = decode(value)
    }
}

/**
 * The ".artifact" suffix: only an artifact's name has it, and the daemon,
 * the API and a saved `.artifact` file carry it, never the screens, where
 * an app is told apart by its icon and its live preview.
 */
object VaultNames {
    const val ARTIFACT_SUFFIX = ".artifact"

    /** Whether [name] is an artifact's: it ends in ".artifact", in any case. */
    fun isArtifact(name: String): Boolean = name.length > ARTIFACT_SUFFIX.length && name.endsWith(ARTIFACT_SUFFIX, ignoreCase = true)

    /** [name] as people read it: "launch.artifact" is "launch". */
    fun shown(name: String): String = if (isArtifact(name)) name.dropLast(ARTIFACT_SUFFIX.length) else name

    /** A path as people read it: "/Apps/launch.artifact/index.html" is "/Apps/launch/index.html". */
    fun shownPath(path: String): String = path.split('/').joinToString("/") { shown(it) }

    /** What an app [typed] as its new name is stored as: always with the suffix, which the person never sees. */
    fun appName(typed: String): String = typed.trim() + ARTIFACT_SUFFIX
}

/** `GET /folders/:folderId` or `/files/:fileId`: the item, where it is, and whether it is in the Trash. */
@Immutable
@Serializable
data class VaultLocation(
    val item: VaultItem,
    val path: String = "",
    val ancestors: List<VaultAncestor> = emptyList(),
    val inTrash: Boolean = false,
)

@Immutable
@Serializable
data class VaultAncestor(val id: String, val name: String)

/** One numbered content version of a file, plain or an artifact. */
@Immutable
@Serializable
data class VaultVersion(
    val fileId: String,
    val surfaceId: String = "",
    val number: Int,
    val size: Long = 0,
    val sha256: String? = null,
    val artifact: VaultArtifact? = null,
    val pinned: Boolean = false,
    val restoredFrom: Int? = null,
    val createdAt: Long = 0,
    val actor: VaultActor = VaultActor(),
    val source: String = "api",
)

/**
 * One record of a folder's or a file's activity log. [kind] decides which of the rest
 * are set; a kind this phone doesn't know reads as "changed".
 */
@Immutable
@Serializable
data class VaultActivity(
    val id: String,
    val itemId: String = "",
    val kind: String,
    val at: Long = 0,
    val actor: VaultActor = VaultActor(),
    val source: String = "api",
    val name: String? = null,
    val parentId: String? = null,
    val copiedFrom: String? = null,
    val fromParentId: String? = null,
    val toParentId: String? = null,
    val fromName: String? = null,
    val toName: String? = null,
    val number: Int? = null,
    val restoredFrom: Int? = null,
)

/** A Trash item and the path it was at. */
@Immutable
@Serializable
data class VaultTrashItem(val item: VaultItem, val path: String = "")

/** One search answer: a name match, or a content match with its line and snippet. */
@Immutable
@Serializable
data class VaultSearchResult(
    val item: VaultItem,
    val path: String = "",
    val match: String = NAME,
    val innerPath: String? = null,
    val line: Int? = null,
    val snippet: String? = null,
) {
    companion object {
        const val NAME = "name"
        const val CONTENT = "content"
    }
}

/** After [afterDays], one version kept in every [everyDays]. */
@Immutable
@Serializable
data class VaultRetentionTier(val afterDays: Int, val everyDays: Int)

/** A vault's retention policy, sent whole and replaced whole; the defaults are a new vault's (Time Machine, 30-day Trash). */
@Immutable
@Serializable
data class VaultRetention(
    val maxVersions: Int? = null,
    val maxAgeDays: Int? = null,
    val keepAllDays: Int = 1,
    val thinning: List<VaultRetentionTier> = listOf(VaultRetentionTier(1, 1), VaultRetentionTier(30, 7)),
    val trashDays: Int? = 30,
) {
    /** The whole policy as the settings route takes it: every field, nulls included. */
    fun json(): JsonObject = JsonObject(
        mapOf(
            "maxVersions" to (maxVersions?.let(::JsonPrimitive) ?: JsonNull),
            "maxAgeDays" to (maxAgeDays?.let(::JsonPrimitive) ?: JsonNull),
            "keepAllDays" to JsonPrimitive(keepAllDays),
            "thinning" to kotlinx.serialization.json.JsonArray(
                thinning.map { JsonObject(mapOf("afterDays" to JsonPrimitive(it.afterDays), "everyDays" to JsonPrimitive(it.everyDays))) },
            ),
            "trashDays" to (trashDays?.let(::JsonPrimitive) ?: JsonNull),
        ),
    )
}

@Immutable
@Serializable
data class VaultSettings(val surfaceId: String = "", val retention: VaultRetention, val updatedAt: Long = 0, val version: String = "")

/** A resumable upload: [received] bytes of [size] have arrived. */
@Immutable
@Serializable
data class VaultUploadState(
    val id: String,
    val size: Long,
    val received: Long = 0,
    val sha256: String? = null,
    val status: String = "receiving",
    val expiresAt: Long = 0,
) {
    val complete: Boolean get() = status == "complete"
}

/** [value] read as [T], or null when it isn't one. */
internal inline fun <reified T> decode(value: JsonElement?): T? = value?.let {
    try {
        AgentClient.json.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), it)
    } catch (_: Exception) {
        null
    }
}
