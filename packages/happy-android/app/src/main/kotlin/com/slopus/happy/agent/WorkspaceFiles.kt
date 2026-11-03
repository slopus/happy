package com.slopus.happy.agent

import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.RequestCategory
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

/**
 * A Happy Agent workspace's folder, read through the agent API (API.md
 * "Files"; desktop's `happyAgentClient.ts` `workspaceFileTreeRead`). Every path is relative to
 * the workspace root. Bytes move on the [RequestCategory.File] clients.
 */
class WorkspaceFiles(private val client: AgentClient, private val io: CoroutineDispatcher = Dispatchers.IO) {
    /** One entry of a directory listing: a file or a folder (symlinks read as files, as desktop's do). */
    data class Entry(val name: String, val path: String, val directory: Boolean, val size: Long)

    /** One page of a directory, by name; [nextCursor] reads the rest. */
    data class Page(val entries: List<Entry>, val nextCursor: String?)

    /** A file's bytes as the agent read them, and the hash a write would be guarded by. */
    class File(val bytes: ByteArray, val hash: String)

    /** The agent refused to send a file over its size limit (413). */
    class TooLarge : Exception()

    /**
     * `GET /v0/workspaces/:id/file-tree`: one directory level ([path] empty
     * for the root), a page of up to 500 at a time. `.git` and entries that
     * are neither files nor folders are left out, as desktop leaves them.
     */
    suspend fun tree(workspaceId: String, path: String, cursor: String? = null): Page {
        val query = buildList {
            if (path.isNotEmpty()) add("path=${AgentClient.escape(path)}")
            if (cursor != null) add("cursor=${AgentClient.escape(cursor)}")
            add("limit=500")
        }.joinToString("&")
        val body = obj(client.send("GET", "/v0/workspaces/${AgentClient.escape(workspaceId)}/file-tree?$query").text) ?: throw invalid()
        val entries = runCatching {
            body["entries"]!!.jsonArray.mapNotNull { element ->
                val entry = element.jsonObject
                val name = entry.string("name") ?: return@mapNotNull null
                val type = entry.string("type")
                if (name == ".git" || type == "other" || type == null) return@mapNotNull null
                Entry(name, entry.string("path") ?: return@mapNotNull null, type == "directory", (entry["size"] as? JsonPrimitive)?.longOrNull ?: 0)
            }
        }.getOrElse { throw invalid() }
        return Page(entries, body.string("nextCursor"))
    }

    /** `GET /v0/workspaces/:id/file`: the file's bytes; [TooLarge] past the agent's limit. */
    suspend fun read(workspaceId: String, path: String): File {
        val body = obj(fileResponse(workspaceId, path).text) ?: throw invalid()
        val content = body.string("content") ?: throw invalid()
        val bytes = withContext(io) { runCatching { java.util.Base64.getMimeDecoder().decode(content) }.getOrNull() } ?: throw invalid()
        return File(bytes, body.string("hash").orEmpty())
    }

    private suspend fun fileResponse(workspaceId: String, path: String) = try {
        client.send("GET", "/v0/workspaces/${AgentClient.escape(workspaceId)}/file?path=${AgentClient.escape(path)}", category = RequestCategory.File)
    } catch (e: AgentApiException) {
        if (e.status == 413) throw TooLarge() else throw e
    }

    private fun invalid() = AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)

    private fun obj(text: String): JsonObject? = runCatching { AgentClient.json.parseToJsonElement(text) as? JsonObject }.getOrNull()
}
