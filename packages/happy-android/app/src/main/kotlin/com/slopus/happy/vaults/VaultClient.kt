package com.slopus.happy.vaults

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.chat.obj
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.TransportResponse
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** How a folder's entries are ordered; folders always come first. */
enum class VaultSortField(val wire: String) { Name("name"), Updated("updatedAt"), Size("size") }

/** One page of a paged read and where the next starts (null on the last). */
data class VaultPage<T>(val items: List<T>, val next: String?)

/**
 * A vault Surface's routes (API.md, "Vault Surfaces" › Routes), under
 * `/v0/surfaces/vault/:surfaceId`, and the global uploads. Folders live
 * under `/folders`, files (plain and artifacts) under `/files`; an item's
 * [VaultItem.kind] picks which. Changes to an existing item send its
 * `version` as `If-Match`; a stale one is a `409` [AgentApiException]
 * whose body carries the current item.
 */
class VaultClient(private val client: AgentClient) {
    fun base(surfaceId: String) = "/v0/surfaces/vault/${AgentClient.escape(surfaceId)}"

    fun folderPath(surfaceId: String, folderId: String) = "${base(surfaceId)}/folders/${AgentClient.escape(folderId)}"

    fun filePath(surfaceId: String, fileId: String) = "${base(surfaceId)}/files/${AgentClient.escape(fileId)}"

    private fun itemPath(item: VaultItem) = if (item.isFolder) folderPath(item.surfaceId, item.id) else filePath(item.surfaceId, item.id)

    private suspend fun read(path: String, category: RequestCategory = RequestCategory.Query): JsonObject =
        parse(client.send("GET", path, category = category))

    private fun parse(response: TransportResponse): JsonObject = try {
        AgentClient.json.parseToJsonElement(response.text).jsonObject
    } catch (e: Exception) {
        throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse).initCause(e)
    }

    private fun query(vararg pairs: Pair<String, Any?>): String = pairs.filter { it.second != null }
        .joinToString("&") { (key, value) -> "$key=${AgentClient.escape(value.toString())}" }
        .let { if (it.isEmpty()) "" else "?$it" }

    private inline fun <reified T> list(body: JsonObject, field: String): List<T> =
        (body[field] as? JsonArray).orEmpty().mapNotNull { decode<T>(it) }

    private fun next(body: JsonObject): String? = (body["nextPageCursor"] as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** The folder or file an answer carries. */
    private fun itemOf(body: JsonObject): VaultItem = itemIn(body)
        ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)

    /** One page of [parentId]'s live children, folders and files (the root when null). */
    suspend fun children(surfaceId: String, parentId: String?, page: String? = null, sort: VaultSortField = VaultSortField.Name, limit: Int = 500): VaultPage<VaultItem> {
        val body = read("${base(surfaceId)}/items" + query("parentId" to parentId, "sort" to sort.wire, "limit" to limit, "pageCursor" to page))
        return VaultPage(list(body, "items"), next(body))
    }

    /** Where a folder ([folder]) or a file is, and whether it is in the Trash. */
    suspend fun location(surfaceId: String, itemId: String, folder: Boolean): VaultLocation {
        val body = read(if (folder) folderPath(surfaceId, itemId) else filePath(surfaceId, itemId))
        return decode<VaultLocation>(JsonObject(body + ("item" to (body[if (folder) "folder" else "file"] ?: JsonNull))))
            ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }

    suspend fun location(item: VaultItem): VaultLocation = location(item.surfaceId, item.id, item.isFolder)

    suspend fun trash(surfaceId: String, page: String? = null): VaultPage<VaultTrashItem> {
        val body = read("${base(surfaceId)}/trash" + query("pageCursor" to page))
        return VaultPage(list(body, "items"), next(body))
    }

    suspend fun versions(surfaceId: String, fileId: String, page: String? = null): VaultPage<VaultVersion> {
        val body = read("${filePath(surfaceId, fileId)}/versions" + query("limit" to 200, "pageCursor" to page))
        return VaultPage(list(body, "versions"), next(body))
    }

    /** One version, with an artifact's whole file list; [number] null is the latest. */
    suspend fun version(surfaceId: String, fileId: String, number: Int?): VaultVersion =
        decode<VaultVersion>(read("${filePath(surfaceId, fileId)}/versions/${number ?: "latest"}")["version"])
            ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)

    suspend fun activity(surfaceId: String, itemId: String, folder: Boolean, page: String? = null): VaultPage<VaultActivity> {
        val path = if (folder) folderPath(surfaceId, itemId) else filePath(surfaceId, itemId)
        val body = read("$path/activity" + query("limit" to 200, "pageCursor" to page))
        return VaultPage(list(body, "activity"), next(body))
    }

    suspend fun settings(surfaceId: String): VaultSettings =
        decode<VaultSettings>(read("${base(surfaceId)}/settings")["settings"]) ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)

    suspend fun saveSettings(surfaceId: String, retention: VaultRetention): VaultSettings {
        val body = JsonObject(mapOf("retention" to retention.json(), "mutationId" to JsonPrimitive(AgentClient.newId())))
        return decode<VaultSettings>(parse(client.send("PATCH", "${base(surfaceId)}/settings", body))["settings"])
            ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }

    /** A new, empty folder; [id] makes a repeat of the same creation harmless. */
    suspend fun createFolder(surfaceId: String, parentId: String?, name: String, id: String = AgentClient.newId()): VaultItem =
        itemOf(parse(client.send("POST", "${base(surfaceId)}/folders", creation(parentId, name, id))))

    /**
     * A new file from an upload: an artifact when [name] ends in ".artifact"
     * (the upload a `.artifact` file), otherwise a plain file. [id] makes a
     * repeat of the same creation harmless.
     */
    suspend fun createFile(surfaceId: String, parentId: String?, name: String, uploadId: String, id: String = AgentClient.newId()): VaultItem =
        itemOf(parse(client.send("POST", "${base(surfaceId)}/files", JsonObject(creation(parentId, name, id) + ("uploadId" to JsonPrimitive(uploadId))))))

    private fun creation(parentId: String?, name: String, id: String) = JsonObject(
        mapOf(
            "parentId" to (parentId?.let(::JsonPrimitive) ?: JsonNull),
            "name" to JsonPrimitive(name),
            "id" to JsonPrimitive(id),
            "mutationId" to JsonPrimitive(AgentClient.newId()),
        ),
    )

    /** Renames and/or moves [item]; [parentId] is set only when [move] (null is the root). */
    suspend fun update(item: VaultItem, name: String? = null, move: Boolean = false, parentId: String? = null): VaultItem {
        val fields = buildMap<String, JsonElement> {
            name?.let { put("name", JsonPrimitive(it)) }
            if (move) put("parentId", parentId?.let(::JsonPrimitive) ?: JsonNull)
            put("mutationId", JsonPrimitive(AgentClient.newId()))
        }
        return itemOf(parse(client.send("PATCH", itemPath(item), JsonObject(fields), ifMatch(item))))
    }

    suspend fun delete(item: VaultItem): VaultItem =
        itemOf(parse(client.send("POST", "${itemPath(item)}/delete", mutation(), ifMatch(item))))

    suspend fun restore(item: VaultItem): VaultItem =
        itemOf(parse(client.send("POST", "${itemPath(item)}/restore", mutation(), ifMatch(item))))

    /**
     * A new version of [file] from an upload or an earlier version; the file
     * as it now is, and the version (null when nothing changed). [operationId]
     * is one per thing the person asked for, sent again unchanged on every
     * retry of it: the daemon answers a repeat with what the first one did
     * rather than making another version.
     */
    suspend fun newVersion(file: VaultItem, uploadId: String? = null, fromVersion: Int? = null, operationId: String = AgentClient.newId()): Pair<VaultItem, VaultVersion?> {
        val fields = buildMap<String, JsonElement> {
            uploadId?.let { put("uploadId", JsonPrimitive(it)) }
            fromVersion?.let { put("fromVersion", JsonPrimitive(it)) }
            put("operationId", JsonPrimitive(operationId))
            put("mutationId", JsonPrimitive(AgentClient.newId()))
        }
        val body = parse(client.send("POST", "${filePath(file.surfaceId, file.id)}/versions", JsonObject(fields), ifMatch(file)))
        return itemOf(body) to decode<VaultVersion>(body["version"])
    }

    suspend fun pin(surfaceId: String, fileId: String, number: Int, pinned: Boolean): VaultVersion {
        val path = "${filePath(surfaceId, fileId)}/versions/$number/${if (pinned) "pin" else "unpin"}"
        return decode<VaultVersion>(parse(client.send("POST", path, mutation()))["version"])
            ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }

    /** The content route of a plain file's version ([number] null: the latest). */
    fun contentPath(surfaceId: String, fileId: String, number: Int?): String = "${filePath(surfaceId, fileId)}/versions/${number ?: "latest"}/content"

    /** One file of an artifact version. */
    fun artifactFilePath(surfaceId: String, fileId: String, number: Int, path: String): String =
        "${filePath(surfaceId, fileId)}/versions/$number/artifact/" + path.split('/').joinToString("/") { AgentClient.escape(it) }

    /** A plain file version's bytes, whole or [range] (`bytes=a-b`). */
    suspend fun content(surfaceId: String, fileId: String, number: Int?, range: String? = null): TransportResponse =
        client.send("GET", contentPath(surfaceId, fileId, number), headers = range?.let { mapOf("Range" to it) }.orEmpty(), category = RequestCategory.File)

    suspend fun artifactFile(surfaceId: String, fileId: String, number: Int, path: String): ByteArray =
        client.send("GET", artifactFilePath(surfaceId, fileId, number, path), category = RequestCategory.File).body

    /**
     * A download as one file: an artifact's version as its `.artifact` file,
     * a live folder's tree as a zip, or (an empty [item] ID) the whole vault's.
     */
    suspend fun zip(item: VaultItem, artifactVersion: Int? = null): ByteArray {
        val path = when {
            item.id.isEmpty() -> "${base(item.surfaceId)}/zip"
            item.isFolder -> "${folderPath(item.surfaceId, item.id)}/zip"
            else -> "${filePath(item.surfaceId, item.id)}/versions/${artifactVersion ?: item.latestVersion ?: "latest"}/zip"
        }
        return client.send("GET", path, category = RequestCategory.File).body
    }

    suspend fun startUpload(size: Long): VaultUploadState = uploadOf(
        parse(client.send("POST", "/v0/vault-uploads", JsonObject(mapOf("size" to JsonPrimitive(size))))),
    )

    suspend fun upload(id: String): VaultUploadState = uploadOf(read("/v0/vault-uploads/${AgentClient.escape(id)}"))

    /** [bytes] at [start] of an upload of [total]; a `409` carries where it really is. */
    suspend fun append(id: String, start: Long, total: Long, bytes: ByteArray): VaultUploadState {
        val end = start + bytes.size - 1
        val headers = mapOf("Content-Type" to "application/octet-stream", "Content-Range" to "bytes $start-$end/$total")
        return uploadOf(parse(client.sendBytes("PUT", "/v0/vault-uploads/${AgentClient.escape(id)}", bytes, headers)))
    }

    suspend fun discardUpload(id: String) {
        client.send("DELETE", "/v0/vault-uploads/${AgentClient.escape(id)}")
    }

    private fun uploadOf(body: JsonObject): VaultUploadState =
        decode<VaultUploadState>(body["upload"]) ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)

    private fun mutation() = JsonObject(mapOf("mutationId" to JsonPrimitive(AgentClient.newId())))

    private fun ifMatch(item: VaultItem) = mapOf("If-Match" to item.version)

    companion object {
        /** The folder or file a body carries, as `folder`, `file` or `item`. */
        internal fun itemIn(body: JsonObject?): VaultItem? = body?.let { VaultItem.parse(it["file"] ?: it["folder"] ?: it["item"]) }

        /** The item a `409` carries: the current one after a stale `If-Match`, or the sibling with a taken name. */
        fun conflictItem(error: AgentApiException): VaultItem? = itemIn(error.body.obj)

        /** Where a refused append really is (`409` with the current upload). */
        fun conflictUpload(error: AgentApiException): VaultUploadState? = decode<VaultUploadState>(error.body.obj?.get("upload"))
    }
}
