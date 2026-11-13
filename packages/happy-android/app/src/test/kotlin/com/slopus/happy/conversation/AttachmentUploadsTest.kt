package com.slopus.happy.conversation

import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/**
 * A computer's attachments routes from memory (API.md "Attachments"):
 * whole files and chunked uploads named by their SHA-256, with the faults a
 * test asks for. Records each request as its method and `Content-Range`.
 */
internal class FakeAttachments {
    class Upload(val size: Long, var limit: Int) {
        val bytes = ByteArray(size.toInt())
        val held = ArrayList<LongRange>()
        var requests = 0
    }

    val requests = ArrayList<Pair<String, String?>>()
    val stored = LinkedHashMap<String, ByteArray>()
    val uploads = HashMap<String, Upload>()
    /** An older computer: every attachments route is unknown. */
    var missing = false
    /** The next requests carrying bytes break off before an answer. */
    var drops = 0
    /** The next requests answer `503`. */
    var busy = 0
    /** The next requests carrying bytes find their upload cancelled under them (`404`). */
    var gone = 0
    /** Completed bytes hash to another name. */
    var corrupt = false
    /** The request limit of the next upload started (the API's 4,096). */
    var nextLimit = 4096
    /** Runs after each answered request carrying bytes: a test's way to expire an upload. */
    var after: () -> Unit = {}

    val request: AgentFileRequest = { method, path, body, headers ->
        val range = headers["Content-Range"]
        requests += method to range
        val route = path.substringBefore('?')
        val id = route.substringAfterLast('/')
        when {
            missing || !route.contains("/attachments/") -> error(404, "not_found")
            method == "DELETE" -> if (uploads.remove(id) != null) ok("{}") else error(404, "not_found")
            stored.containsKey(id) -> attachment(id)
            busy > 0 -> { busy--; error(503, "unavailable") }
            body.isNotEmpty() && drops > 0 -> { drops--; throw AgentConnectionException(AgentConnectionException.Reason.Unavailable) }
            body.isNotEmpty() && gone > 0 -> { gone--; uploads.remove(id); error(404, "not_found") }
            range == null -> complete(id, body)
            else -> chunk(id, range, body).also { if (body.isNotEmpty()) after() }
        }
    }

    private fun chunk(id: String, range: String, body: ByteArray): TransportResponse {
        val (span, total) = range.removePrefix("bytes ").split('/')
        val size = total.toLong()
        val upload = uploads.getOrPut(id) { Upload(size, nextLimit).also { nextLimit = 4096 } }
        if (span == "*") return view(id, upload)
        if (++upload.requests > upload.limit) return error(400, "invalid_request")
        val start = span.substringBefore('-').toLong()
        val end = span.substringAfter('-').toLong()
        if (end >= size || body.size.toLong() != end - start + 1) return error(400, "invalid_request")
        body.copyInto(upload.bytes, start.toInt())
        upload.held += start..end
        if (AttachmentUploads.firstMissing(upload.held, size) != null) return view(id, upload)
        uploads.remove(id)
        return complete(id, upload.bytes)
    }

    private fun complete(id: String, bytes: ByteArray): TransportResponse {
        if (corrupt || hex(bytes) != id) return error(409, "hash_mismatch")
        stored[id] = bytes
        return attachment(id)
    }

    /** An upload begun elsewhere, holding [held]. */
    fun holding(id: String, size: Long, vararg held: LongRange) {
        uploads[id] = Upload(size, 4096).also { it.held += held }
    }

    private fun view(id: String, upload: Upload): TransportResponse {
        val merged = upload.held.sortedBy { it.first }.fold(ArrayList<LongRange>()) { all, range ->
            val last = all.lastOrNull()
            if (last != null && range.first <= last.last + 1) all[all.lastIndex] = last.first..maxOf(last.last, range.last) else all += range
            all
        }
        val received = merged.joinToString(",") { """{"start":${it.first},"end":${it.last}}""" }
        return TransportResponse(200, body = """{"upload":{"id":"$id","name":"f","size":${upload.size},"received":[$received],"expiresAt":1}}""".toByteArray())
    }

    private fun attachment(id: String) =
        TransportResponse(201, body = """{"attachment":{"id":"$id","name":"f","mimeType":"image/jpeg","size":${stored[id]!!.size}}}""".toByteArray())

    private fun ok(text: String) = TransportResponse(200, body = text.toByteArray())

    private fun error(status: Int, code: String) = TransportResponse(status, body = """{"error":"$code","code":"$code"}""".toByteArray())

    /** Every byte-carrying request's range, in order: what went over the wire. */
    fun sent(): List<String?> = requests.filter { it.first == "PUT" && it.second?.startsWith("bytes */") != true }.map { it.second }

    companion object {
        fun hex(bytes: ByteArray): String = WorkspaceUploads.hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    }
}

class AttachmentUploadsTest {
    private val daemon = FakeAttachments()
    private val uploads = AttachmentUploads(daemon.request, retryDelayMillis = 1, io = Dispatchers.IO)
    private val dir = kotlin.io.path.createTempDirectory("attachments").toFile()

    private fun file(size: Int, name: String = "IMG_0042.jpg"): OutgoingFile {
        val bytes = ByteArray(size) { (it * 31 + it / 7).toByte() }
        val file = File(dir, name).apply { writeBytes(bytes) }
        return OutgoingFile(file, name, "image/jpeg", size.toLong(), path = "")
    }

    private fun range(start: Long, end: Long, size: Long) = "bytes $start-$end/$size"

    private val mib = 1024L * 1024

    @Test fun `a small file goes whole in one request named by its digest`() = runTest {
        val file = file(2 * 1024 * 1024)
        val id = uploads.upload("a1", file)
        assertEquals(FakeAttachments.hex(file.file.readBytes()), id)
        assertEquals(listOf("PUT" to null), daemon.requests)
        assertArrayEquals(file.file.readBytes(), daemon.stored[id])
    }

    @Test fun `a large file asks where it stands, then goes in 8 MiB chunks`() = runTest {
        val size = 20 * mib
        val file = file(size.toInt())
        val heard = ArrayList<Long>()
        val id = uploads.upload("a1", file) { heard += it }
        assertEquals(
            listOf("bytes */$size", range(0, 8 * mib - 1, size), range(8 * mib, 16 * mib - 1, size), range(16 * mib, size - 1, size)),
            daemon.requests.map { it.second },
        )
        assertArrayEquals(file.file.readBytes(), daemon.stored[id])
        assertEquals(16 * mib, heard.last())
    }

    @Test fun `a chunk starts at the first byte missing and stops where held bytes begin`() = runTest {
        val size = 20 * mib
        val file = file(size.toInt())
        val id = FakeAttachments.hex(file.file.readBytes())
        daemon.holding(id, size, 0..10 * mib - 1, 16 * mib..18 * mib - 1)
        // What the computer holds came from this file before: it is the file's own.
        file.file.readBytes().copyInto(daemon.uploads[id]!!.bytes)
        uploads.upload("a1", file)
        assertEquals(listOf(range(10 * mib, 16 * mib - 1, size), range(18 * mib, size - 1, size)), daemon.sent())
        assertTrue(daemon.stored.containsKey(id))
    }

    @Test fun `a file the computer already holds sends no bytes`() = runTest {
        val file = file((9 * mib).toInt())
        val id = FakeAttachments.hex(file.file.readBytes())
        daemon.stored[id] = file.file.readBytes()
        assertEquals(id, uploads.upload("a1", file))
        assertEquals(listOf("PUT" to "bytes */${9 * mib}"), daemon.requests)
    }

    @Test fun `a dropped connection asks again and goes on from what is held`() = runTest {
        val size = 20 * mib
        val file = file(size.toInt())
        var chunks = 0
        daemon.after = { if (++chunks == 1) daemon.drops = 1 }
        uploads.upload("a1", file)
        assertEquals(
            listOf("bytes */$size", range(0, 8 * mib - 1, size), range(8 * mib, 16 * mib - 1, size), "bytes */$size", range(8 * mib, 16 * mib - 1, size), range(16 * mib, size - 1, size)),
            daemon.requests.map { it.second },
        )
    }

    @Test fun `five failures in a row give up, and the next try resumes from what is held`() = runTest {
        val size = 20 * mib
        val file = file(size.toInt())
        var chunks = 0
        daemon.after = { if (++chunks == 1) daemon.busy = 5 }
        try {
            uploads.upload("a1", file)
            fail("gave up")
        } catch (e: ConversationApiException) {
            assertEquals(503, e.status)
        }
        val first = range(0, 8 * mib - 1, size)
        val second = range(8 * mib, 16 * mib - 1, size)
        assertEquals(listOf(first, second), daemon.sent())
        daemon.after = {}
        // The message's Retry: its digest kept, the first chunk not sent again.
        val digest = file.digest
        uploads.upload("a1", file)
        assertEquals(digest, file.digest)
        assertEquals(listOf(first, second, second, range(16 * mib, size - 1, size)), daemon.sent())
    }

    @Test fun `a small file is sent again after a broken connection`() = runTest {
        val file = file(1000)
        daemon.drops = 2
        val id = uploads.upload("a1", file)
        assertEquals(3, daemon.sent().size)
        assertTrue(daemon.stored.containsKey(id))
    }

    @Test fun `bytes that do not match their name fail`() = runTest {
        daemon.corrupt = true
        for (size in listOf(1000L, 9 * mib)) {
            try {
                uploads.upload("a1", file(size.toInt(), "f$size"))
                fail("mismatch")
            } catch (e: ConversationApiException) {
                assertEquals(409 to "hash_mismatch", e.status to e.code)
            }
        }
        assertTrue(daemon.stored.isEmpty())
    }

    @Test fun `an upload past its request limit is cancelled and sent again once`() = runTest {
        val size = 20 * mib
        val file = file(size.toInt())
        daemon.nextLimit = 2
        val id = uploads.upload("a1", file)
        assertTrue(daemon.stored.containsKey(id))
        assertEquals(1, daemon.requests.count { it.first == "DELETE" })
        // Twice past the limit is given up.
        val again = file(size.toInt(), "other.jpg").also { it.file.appendBytes(byteArrayOf(1)) }
        daemon.nextLimit = 1
        daemon.after = { daemon.uploads.values.forEach { it.limit = 1 } }
        try {
            uploads.upload("a1", again)
            fail("limit")
        } catch (e: ConversationApiException) {
            assertEquals(400, e.status)
        }
    }

    @Test fun `an upload that expired on its way is filled in again from what the new one holds`() = runTest {
        val size = 20 * mib
        val file = file(size.toInt())
        var chunks = 0
        // The next chunk starts a new upload, which then lacks the first.
        daemon.after = { if (++chunks == 1) daemon.uploads.clear() }
        val id = uploads.upload("a1", file)
        assertEquals(
            listOf(range(0, 8 * mib - 1, size), range(8 * mib, 16 * mib - 1, size), range(0, 8 * mib - 1, size), range(16 * mib, size - 1, size)),
            daemon.sent(),
        )
        assertTrue(daemon.stored.containsKey(id))
    }

    @Test fun `an upload cancelled under a chunk is asked again and started over`() = runTest {
        val size = 20 * mib
        val file = file(size.toInt())
        var chunks = 0
        daemon.after = { if (++chunks == 1) daemon.gone = 1 }
        val id = uploads.upload("a1", file)
        val first = range(0, 8 * mib - 1, size)
        val second = range(8 * mib, 16 * mib - 1, size)
        assertEquals(listOf(first, second, first, second, range(16 * mib, size - 1, size)), daemon.sent())
        assertTrue(daemon.stored.containsKey(id))
    }

    @Test fun `a computer without the route says so on the first request`() = runTest {
        daemon.missing = true
        for (size in listOf(1000L, 9 * mib)) {
            try {
                uploads.upload("a1", file(size.toInt(), "f$size"))
                fail("missing")
            } catch (_: AttachmentRouteMissing) {
            }
        }
        // The large one asked before sending anything.
        assertEquals(listOf("PUT" to null, "PUT" to "bytes */${9 * mib}"), daemon.requests)
    }

    @Test fun `the first missing byte and where the next held range begins`() {
        val held = listOf(0L..9L, 20L..29L)
        assertEquals(10L, AttachmentUploads.firstMissing(held, 40))
        assertEquals(20L, AttachmentUploads.nextHeld(held, 10, 40))
        assertEquals(40L, AttachmentUploads.nextHeld(held, 30, 40))
        assertEquals(0L, AttachmentUploads.firstMissing(listOf(5L..9L), 10))
        assertNull(AttachmentUploads.firstMissing(listOf(0L..4L, 5L..9L), 10))
    }
}
