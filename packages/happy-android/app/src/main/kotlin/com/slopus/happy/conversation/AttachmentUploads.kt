package com.slopus.happy.conversation

import com.slopus.happy.chat.arr
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.BodyProgress
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.IOException
import java.io.RandomAccessFile
import java.security.MessageDigest
import kotlin.coroutines.CoroutineContext

/**
 * Whether the computer has the attachments routes, as its connection last
 * found: an older one (before happy-agent v2026.11.6-preview.4) answers the
 * first upload `404`, and its sends keep pictures inline and write files to
 * the workspace from then on.
 */
class AttachmentRoute {
    @Volatile var missing: Boolean = false
}

/** The first request of an upload answered `404` (or `405`, `501`): the computer has no attachments route. */
class AttachmentRouteMissing : Exception("This computer doesn't take attachments.")

/**
 * Uploads a message's files as the agent's attachments (API.md
 * "Attachments", as iOS sends them). A file is named by its SHA-256, hashed
 * first. Up to [DIRECT] it goes in one request, checked against that name;
 * a larger one asks where its upload stands (`bytes *` + `/size`) and sends
 * the first range missing, [CHUNK] at a time, until the answer is the
 * attachment. A broken connection or a `5xx` waits, asks again and goes on
 * from what the computer holds; [MAX_FAILURES] in a row without a range
 * taken give up this try, and the message's Retry resumes it. An upload past
 * its request limit (`400`) is cancelled and started again once; bytes that
 * don't hash to the name (`409 hash_mismatch`) fail.
 */
class AttachmentUploads(
    private val request: AgentFileRequest,
    private val retryDelayMillis: Long = 1_000,
    /** Where the file is hashed and read. */
    private val io: CoroutineContext = Dispatchers.IO,
) {
    /** [file] uploaded to [agentId]; its attachment ID. [sent] hears how many of its bytes the computer has, or is being written. */
    suspend fun upload(agentId: String, file: OutgoingFile, sent: (Long) -> Unit = {}): String {
        val id = file.digest ?: withContext(io) { digest(file.file) }.also { file.digest = it }
        // As it is on the disk: a picked file's stated size may be missing.
        val size = withContext(io) { file.file.length() }
        val path = path(agentId, id)
        val named = "$path?name=${ConversationApi.escape(file.name)}"
        val headers = mapOf("Content-Type" to file.mimeType.ifBlank { "application/octet-stream" })
        var restarted = false
        while (true) {
            try {
                return if (size <= DIRECT) whole(named, headers, file, size, id, sent) else chunks(named, headers, file, size, id, sent)
            } catch (e: ConversationApiException) {
                // Past the upload's request limit: it is cancelled and sent once more from the start.
                if (e.status != 400 || e.code != "invalid_request" || restarted) throw e
                restarted = true
                try {
                    answer(request("DELETE", path, ByteArray(0), emptyMap()))
                } catch (gone: ConversationApiException) {
                    if (gone.status != 404) throw gone
                }
            }
        }
    }

    private suspend fun whole(path: String, headers: Map<String, String>, file: OutgoingFile, size: Long, id: String, sent: (Long) -> Unit): String {
        val bytes = withContext(io) { file.file.readBytes() }
        if (bytes.size.toLong() != size) throw IOException("${file.name} changed while it was read")
        var failures = 0
        while (true) {
            try {
                val body = withContext(BodyProgress { _, written -> sent(written.toLong()) }) { answer(request("PUT", path, bytes, headers)) }
                return attachmentOf(body, id) ?: throw invalid()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is ConversationApiException && e.status in MISSING_ROUTE) throw AttachmentRouteMissing()
                if (!transient(e) || ++failures >= MAX_FAILURES) throw e
                delay(retryDelayMillis * failures)
            }
        }
    }

    private suspend fun chunks(path: String, headers: Map<String, String>, file: OutgoingFile, size: Long, id: String, sent: (Long) -> Unit): String {
        /** What the computer holds; null asks. */
        var held: List<LongRange>? = null
        var asked = false
        var failures = 0
        while (true) {
            val known = held
            val start = known?.let { firstMissing(it, size) }
            val body = try {
                if (known == null || start == null) {
                    answer(request("PUT", path, ByteArray(0), headers + ("Content-Range" to "bytes */$size")))
                } else {
                    val end = minOf(nextHeld(known, start, size), start + CHUNK)
                    val bytes = withContext(io) { read(file, size, start, end) }
                    val before = heldBytes(known)
                    withContext(BodyProgress { _, written -> sent(before + written) }) {
                        answer(request("PUT", path, bytes, headers + ("Content-Range" to "bytes $start-${end - 1}/$size")))
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is ConversationApiException) {
                    if (!asked && e.status in MISSING_ROUTE) throw AttachmentRouteMissing()
                    asked = true
                }
                // Cancelled or expired meanwhile (404) is asked again too, which starts it over.
                val again = transient(e) || e is ConversationApiException && e.status == 404
                if (!again || ++failures >= MAX_FAILURES) throw e
                delay(retryDelayMillis * failures)
                held = null
                continue
            }
            asked = true
            attachmentOf(body, id)?.let { return it }
            val now = body["upload"].obj?.get("received").arr?.map { range ->
                val start = range.obj?.get("start").num?.toLong() ?: throw invalid()
                val end = range.obj?.get("end").num?.toLong() ?: throw invalid()
                start..end
            } ?: throw invalid()
            if (known != null && start != null) {
                // A range sent and taken is progress; one the answer doesn't hold was not kept.
                if (firstMissing(now, size) == start) throw IOException("The computer did not keep the uploaded bytes")
                failures = 0
            }
            held = now
            sent(heldBytes(now))
        }
    }

    /** The answer's JSON; a refusal is thrown as [ConversationApiException], whichever way the transport gave it. */
    private fun answer(response: TransportResponse) = ConversationApi.decode(response)

    /** The answer's attachment ID: the one it was named by, or the bytes were taken as another file. */
    private fun attachmentOf(body: kotlinx.serialization.json.JsonObject, id: String): String? {
        val answered = body["attachment"].obj?.get("id").str ?: return null
        if (answered != id) throw invalid()
        return answered
    }

    private fun invalid() = AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)

    companion object {
        /** A file up to this goes in one request (the TS client's `directLimit`). */
        const val DIRECT = 8L * 1024 * 1024
        /** The bytes one chunk carries (the TS client's `chunkSize`), under the 25 MiB a request may. */
        const val CHUNK = 8L * 1024 * 1024
        /** The largest attachment: 1 GiB. */
        const val MAX_SIZE = 1_073_741_824L
        /** Failures in a row, without a range taken, before this try gives up. */
        const val MAX_FAILURES = 5

        private val MISSING_ROUTE = setOf(404, 405, 501)

        fun path(agentId: String, attachment: String) = "/v0/agents/${ConversationApi.escape(agentId)}/attachments/$attachment"

        /** Lowercase hex SHA-256 of [file], read a piece at a time. */
        fun digest(file: java.io.File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(256 * 1024)
            file.inputStream().use { input ->
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    digest.update(buffer, 0, n)
                }
            }
            return WorkspaceUploads.hex(digest.digest())
        }

        /** The first byte [held] lacks, or null when it holds all [size]. */
        internal fun firstMissing(held: List<LongRange>, size: Long): Long? {
            var at = 0L
            for (range in held.sortedBy { it.first }) {
                if (range.first > at) break
                at = maxOf(at, range.last + 1)
            }
            return at.takeIf { it < size }
        }

        /** Where the next range [held] has after [start] begins: a chunk stops there. */
        internal fun nextHeld(held: List<LongRange>, start: Long, size: Long): Long =
            held.map { it.first }.filter { it > start }.minOrNull() ?: size

        private fun heldBytes(held: List<LongRange>): Long = held.sumOf { it.last - it.first + 1 }

        private fun read(file: OutgoingFile, size: Long, start: Long, end: Long): ByteArray = RandomAccessFile(file.file, "r").use { input ->
            if (input.length() != size) throw IOException("${file.name} changed while it was read")
            ByteArray((end - start).toInt()).also { input.seek(start); input.readFully(it) }
        }

        /** A broken connection, or a refusal that may pass: a `5xx`, a timeout, too many requests. */
        private fun transient(e: Exception) = Conversation.transient(e) || e is ConversationApiException && (e.status == 408 || e.status == 429)
    }
}
