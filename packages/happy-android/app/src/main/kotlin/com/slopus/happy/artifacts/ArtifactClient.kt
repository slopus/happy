package com.slopus.happy.artifacts

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.decode
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.JsonObject

/** The artifact was deleted: its tombstone stays, but its versions and files no longer read (API.md). */
class ArtifactGoneException : Exception("artifact deleted")

/**
 * The artifact routes a device token may use (API.md "Artifacts"), as iOS's
 * `AgentClient` reads them: a version's manifest, one file whole or a range
 * of it, and the catalog's pages.
 */
open class ArtifactClient(private val client: AgentClient) {
    /** One version, null for the latest. A 404 is [ArtifactGoneException]. */
    open suspend fun version(artifactId: String, number: Int?): ArtifactVersion {
        val answer = try {
            client.decode<JsonObject>("GET", "/v0/artifacts/${AgentClient.escape(artifactId)}/versions/${number?.toString() ?: "latest"}")
        } catch (e: AgentApiException) {
            if (e.status == 404 || e.status == 410) throw ArtifactGoneException()
            // A tombstone's versions may be refused another way: its entry says it was deleted.
            if (e.status in 400..499 && runCatching { isDeleted(artifact(artifactId)) }.getOrDefault(false)) throw ArtifactGoneException()
            throw e
        }
        return ArtifactVersion.parse(answer["version"].obj) ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
    }

    /** One page of the catalog, at most [limit] artifacts, from [pageCursor]. */
    open suspend fun catalog(pageCursor: String? = null, limit: Int = ArtifactCatalogFeed.PAGE_SIZE): JsonObject =
        client.decode("GET", "/v0/artifacts?limit=$limit" + (pageCursor?.let { "&pageCursor=${AgentClient.escape(it)}" } ?: ""))

    /** One artifact's catalog entry (`GET /v0/artifacts/:id`). */
    open suspend fun artifact(artifactId: String): JsonObject =
        client.decode<JsonObject>("GET", "/v0/artifacts/${AgentClient.escape(artifactId)}")["artifact"].obj
            ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)

    /** One file of a numbered version, whole or one [range] of it (a `Range` header). Each segment of [path] is escaped on its own. */
    open suspend fun file(artifactId: String, version: Int, path: String, range: String? = null): TransportResponse {
        val escaped = path.split('/').joinToString("/") { AgentClient.escape(it) }
        return client.send(
            "GET",
            "/v0/artifacts/${AgentClient.escape(artifactId)}/versions/$version/files/$escaped",
            headers = range?.let { mapOf("Range" to it) } ?: emptyMap(),
            category = RequestCategory.File,
        )
    }

    /** The whole file, read a range of [chunk] at a time; [progress] hears how much of how much is here after each. */
    suspend fun bytes(
        artifactId: String,
        version: Int,
        path: String,
        limit: Long = Long.MAX_VALUE,
        chunk: Int = RANGE_CHUNK,
        progress: ((done: Long, total: Long) -> Unit)? = null,
    ): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        read({ range -> file(artifactId, version, path, range?.let { "bytes=${it.first}-${it.last}" }) }, chunk) { piece, total ->
            if (total > limit) throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
            out.write(piece)
            progress?.invoke(out.size().toLong(), total)
        }
        return out.toByteArray()
    }

    companion object {
        /** A catalog entry that is a tombstone (API.md: `status: deleted`, or a `deletedAt`). */
        fun isDeleted(artifact: JsonObject): Boolean =
            artifact["status"].str == "deleted" || artifact["deletedAt"].num != null

        /** One answer holds at most 8 MiB (`HttpResponseParser`), so a whole file is read in ranges of this size. */
        const val RANGE_CHUNK = 4 * 1024 * 1024

        /** The ranges a file read for another app is read in, so its ring moves on a file of a few megabytes. */
        const val PROGRESS_CHUNK = 512 * 1024

        /**
         * Reads a file a range at a time through [fetch] (null: the whole
         * file, for one that is empty). [each] takes the pieces in order,
         * with the file's whole length. A server that ignores ranges answers
         * the first with the whole file.
         */
        suspend fun read(fetch: suspend (LongRange?) -> TransportResponse, chunk: Int = RANGE_CHUNK, each: suspend (piece: ByteArray, total: Long) -> Unit) {
            var offset = 0L
            var total = Long.MAX_VALUE
            while (offset < total) {
                currentCoroutineContext().ensureActive()
                val response = try {
                    fetch(offset until offset + chunk)
                } catch (e: AgentApiException) {
                    if (e.status == 416 && offset == 0L) {
                        val whole = fetch(null)
                        each(whole.body, whole.body.size.toLong())
                        return
                    }
                    throw e
                }
                if (response.status == 200 && offset == 0L) {
                    each(response.body, response.body.size.toLong())
                    return
                }
                val length = length(response.headers["content-range"])
                if (response.status != 206 || response.body.isEmpty() || length == null) {
                    throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
                }
                if (offset == 0L) total = length
                each(response.body, total)
                offset += response.body.size
            }
        }

        /** The whole length in a `Content-Range` such as `bytes 0-1/28560`. */
        fun length(contentRange: String?): Long? = contentRange?.substringAfterLast('/', "")?.trim()?.toLongOrNull()
    }
}
