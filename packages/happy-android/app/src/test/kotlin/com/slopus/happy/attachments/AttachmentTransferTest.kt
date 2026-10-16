package com.slopus.happy.attachments

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.crypto.decryptBlob
import com.slopus.happy.crypto.encryptBlob
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.sync.RecordDecoder
import com.slopus.happy.testing.FakeHappyServer
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.Dns
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList

/**
 * apiAttachments.ts against attachmentRoutes.ts' contract (local storage and
 * S3 presigned), uploadAttachmentsForSession, useAttachmentImage's load and
 * cache, and the file event record (sync.ts sendMessage).
 */
@RunWith(AndroidJUnit4::class)
class AttachmentTransferTest {
    private lateinit var server: FakeHappyServer
    private lateinit var api: AttachmentApi
    private lateinit var store: HappyStore
    private lateinit var transfers: AttachmentTransfers
    private val storage = MockWebServer()
    private val storageRequests = CopyOnWriteArrayList<RecordedRequest>()
    private var storageRespond: (RecordedRequest) -> MockResponse = { MockResponse.Builder().code(204).build() }

    private val storageUrl get() = "http://$STORAGE_HOST:${storage.port}/bucket"
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 1, 2, 3)

    @Before
    fun setUp() {
        server = FakeHappyServer().start()
        server.addSession("s1", updatedAt = 1)
        storage.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                storageRequests += request
                return storageRespond(request)
            }
        }
        storage.start()
        // Storage on its own host name: loopback URLs would be rewritten to the server's.
        val client = OkHttpClient.Builder()
            .dns { host -> if (host == STORAGE_HOST) listOf(InetAddress.getByName("127.0.0.1")) else Dns.SYSTEM.lookup(host) }
            .build()
        api = AttachmentApi(client, serverUrl = { server.url })
        store = HappyStore(HappyDatabase(ApplicationProvider.getApplicationContext(), name = null))
        val decoder = RecordDecoder(server.encryption)
        store.upsertSessions(server.sessions.mapNotNull(decoder::session))
        val keys = SessionBlobKeys(store, server.encryption)
        transfers = AttachmentTransfers(api, keys::blobKey, token = { server.token })
    }

    @After
    fun tearDown() {
        server.close()
        storage.close()
    }

    private fun preview(name: String = "photo.jpg") = AttachmentPreview("id-$name", "file:///cache/$name", 4032, 3024, "image/jpeg", 1234, name)

    @Test
    fun localStorageRoundTrip() = runBlocking {
        val upload = api.requestUpload(server.token, "s1", "photo.jpg", 47)
        assertTrue(upload.ref.startsWith("sessions/s1/attachments/") && upload.ref.endsWith(".enc"))
        assertEquals(AttachmentDiagnosticMethod.PUT, upload.method)
        val request = server.requestsTo("/v1/sessions/s1/attachments/request-upload").single()
        assertEquals("Bearer ${server.token}", request.headers["Authorization"])
        assertEquals("application/json", request.headers["Content-Type"])
        assertEquals("""{"filename":"photo.jpg","size":47}""", request.body!!.utf8())

        api.uploadBlob(upload, byteArrayOf(9, 8, 7), server.token)
        val put = server.requests.last()
        assertEquals("PUT", put.method)
        assertEquals("application/octet-stream", put.headers["Content-Type"])
        // Our own server: the bearer token goes along.
        assertEquals("Bearer ${server.token}", put.headers["Authorization"])
        assertArrayEquals(byteArrayOf(9, 8, 7), server.attachments[upload.ref])

        assertArrayEquals(byteArrayOf(9, 8, 7), api.download(server.token, "s1", upload.ref))
        val requestDownload = server.requestsTo("/v1/sessions/s1/attachments/request-download").single()
        assertEquals("""{"ref":"${upload.ref}"}""", requestDownload.body!!.utf8())
        assertEquals("Bearer ${server.token}", server.requests.last().headers["Authorization"])
    }

    @Test
    fun loopbackUrlsAreRewrittenToTheServerTheAppReaches() = runBlocking {
        // A dev server that names itself localhost in the URLs it hands out.
        val port = server.server.port
        server.attachmentBaseUrl = "http://localhost:$port"
        val upload = api.requestUpload(server.token, "s1", "a.jpg", 3)
        assertTrue(upload.uploadUrl, upload.uploadUrl.startsWith(server.url))
        assertEquals("http://localhost:4000/x?y=1", rewriteLoopbackHost("http://localhost:4000/x?y=1", "not a url"))
        assertEquals("https://happy.example:8443/v1/x", rewriteLoopbackHost("http://127.0.0.1:3005/v1/x", "https://happy.example:8443"))
        assertEquals("https://files.example/x", rewriteLoopbackHost("https://files.example/x", "https://happy.example"))
    }

    @Test
    fun presignedStorageGetsNoHappyHeaders() = runBlocking {
        server.presignedStorageUrl = storageUrl
        val upload = api.requestUpload(server.token, "s1", "photo.jpg", 3)
        assertEquals(AttachmentDiagnosticMethod.POST, upload.method)
        assertEquals("secret-policy", upload.formFields["policy"])

        api.uploadBlob(upload, byteArrayOf(1, 2, 3), server.token)
        val post = storageRequests.single()
        assertEquals("POST", post.method)
        assertNull(post.headers["Authorization"])
        assertTrue(post.headers["Content-Type"]!!.startsWith("multipart/form-data"))
        val body = post.body!!.utf8()
        // The policy's fields first, then the file.
        val fields = listOf("name=\"key\"", "name=\"policy\"", "name=\"X-Amz-Signature\"", "name=\"file\"; filename=\"blob\"")
        assertEquals(fields, fields.sortedBy { body.indexOf(it) })
        fields.forEach { assertTrue(it, body.contains(it)) }
        assertTrue(body.contains("Content-Type: application/octet-stream"))

        storageRequests.clear()
        storageRespond = { MockResponse.Builder().code(200).body(okio.Buffer().write(byteArrayOf(5, 6))).build() }
        assertArrayEquals(byteArrayOf(5, 6), api.download(server.token, "s1", upload.ref))
        val get = storageRequests.single()
        assertNull(get.headers["Authorization"])
        assertEquals("s3-secret", get.url.queryParameter("X-Amz-Signature"))
    }

    @Test
    fun failuresSayWhichLegAndLeakNothing() = runBlocking {
        server.failAttachmentUploads += listOf(500, 413)
        val e500 = assertThrows(AttachmentDiagnosticError::class.java) { runBlocking { api.requestUpload(server.token, "s1", "a.jpg", 3) } }
        assertEquals("request-upload failed: 500", e500.message)
        assertEquals(AttachmentDiagnosticLeg.RequestUpload, e500.diagnostic.leg)
        assertEquals(500, e500.diagnostic.status)
        assertEquals(AttachmentTransferTarget.HappyApi, e500.diagnostic.target)
        assertEquals("Attachment too large (max 10MB)", assertThrows(AttachmentDiagnosticError::class.java) { runBlocking { api.requestUpload(server.token, "s1", "a.jpg", 3) } }.message)
        assertEquals("Session not found", assertThrows(AttachmentDiagnosticError::class.java) { runBlocking { api.requestUpload(server.token, "nope", "a.jpg", 3) } }.message)

        server.presignedStorageUrl = storageUrl
        storageRespond = { MockResponse.Builder().code(403).build() }
        val upload = api.requestUpload(server.token, "s1", "a.jpg", 3)
        val e403 = assertThrows(AttachmentDiagnosticError::class.java) { runBlocking { api.uploadBlob(upload, byteArrayOf(1), server.token) } }
        assertEquals("Blob upload (POST) failed: 403 Client Error", e403.message)
        assertEquals(AttachmentDiagnosticLeg.BlobUpload, e403.diagnostic.leg)
        assertEquals(AttachmentTransferTarget.ExternalStorage, e403.diagnostic.target)
        assertEquals(403, e403.diagnostic.status)

        val eGet = assertThrows(AttachmentDiagnosticError::class.java) { runBlocking { api.download(server.token, "s1", upload.ref) } }
        assertTrue(eGet.message!!.startsWith("Attachment download failed: 403"))
        assertEquals(AttachmentDiagnosticLeg.BlobDownload, eGet.diagnostic.leg)
        val leaks = listOf(server.token, "s3-secret", "secret-policy", upload.ref)
        listOf(e500, e403, eGet).forEach { error ->
            val rendered = "${error.message} ${error.diagnostic.forLog()}"
            leaks.forEach { assertFalse("$it in $rendered", rendered.contains(it)) }
        }

        val eRef = assertThrows(AttachmentDiagnosticError::class.java) { runBlocking { api.download(server.token, "s1", "sessions/other/attachments/x.enc") } }
        assertEquals("request-download failed: 400", eRef.message)

        storage.close()
        val eNetwork = assertThrows(AttachmentDiagnosticError::class.java) { runBlocking { api.uploadBlob(upload, byteArrayOf(1), server.token) } }
        assertTrue(eNetwork.message!!.startsWith("Blob upload (POST) network error"))
        assertEquals(AttachmentDiagnosticLeg.BlobUpload, eNetwork.diagnostic.leg)
    }

    @Test
    fun uploadEncryptsWithTheSessionBlobKey() = runBlocking {
        val result = transfers.upload("s1", listOf(preview("a.jpg"), preview("b.jpg"))) { png }
        assertEquals(0, result.failed)
        assertEquals(listOf("a.jpg", "b.jpg"), result.uploaded.map { it.name })
        val first = result.uploaded.first()
        assertEquals(UploadedAttachment(first.ref, "a.jpg", 1234, 4032, 3024), first)

        // Encrypted with the key the CLI derives from the session's data key.
        val blobKey = AccountEncryption.blobKeyForDataKey(server.dataKey("s1"))
        assertArrayEquals(png, decryptBlob(server.attachments.getValue(first.ref), blobKey))
        // request-upload is told the encrypted size: nonce 24 + MAC 16 + data.
        assertTrue(server.requestsTo("/v1/sessions/s1/attachments/request-upload").first().body!!.utf8().contains("\"size\":${png.size + 40}"))
    }

    @Test
    fun aFailedUploadIsSkippedNotFatal() = runBlocking {
        server.failAttachmentUploads += 500
        val result = transfers.upload("s1", listOf(preview("a.jpg"), preview("b.jpg"))) { png }
        assertEquals(1, result.failed)
        assertEquals(listOf("b.jpg"), result.uploaded.map { it.name })

        val unreadable = transfers.upload("s1", listOf(preview("c.jpg"))) { throw java.io.IOException("gone") }
        assertEquals(AttachmentUploadResult(emptyList(), 1), unreadable)

        // No blob key (a session not on the device): nothing is uploaded.
        val before = server.requests.size
        assertEquals(AttachmentUploadResult(emptyList(), 2), transfers.upload("other", listOf(preview(), preview())) { png })
        assertEquals(before, server.requests.size)
    }

    @Test
    fun loadDecryptsAndCaches() = runBlocking {
        val blobKey = AccountEncryption.blobKeyForDataKey(server.dataKey("s1"))
        val ref = "sessions/s1/attachments/x.enc"
        server.attachments[ref] = encryptBlob(png, blobKey)

        assertNull(transfers.cached(ref))
        // Concurrent loads share one download.
        val loads = (1..3).map { async { transfers.load("s1", ref) } }.awaitAll()
        loads.forEach { assertArrayEquals(png, it) }
        assertEquals(1, server.requestsTo("/v1/sessions/s1/attachments/request-download").size)
        assertArrayEquals(png, transfers.cached(ref))
        transfers.load("s1", ref)
        assertEquals(1, server.requestsTo("/v1/sessions/s1/attachments/request-download").size)

        // Undecryptable or missing: null, not an exception.
        server.attachments["sessions/s1/attachments/bad.enc"] = byteArrayOf(1, 2, 3)
        assertNull(transfers.load("s1", "sessions/s1/attachments/bad.enc"))
        assertNull(transfers.load("s1", "sessions/s1/attachments/missing.enc"))
        assertNull(transfers.load("other", ref.replace("s1", "other")))
    }

    @Test
    fun theCacheKeepsTheFiftyMostRecent() = runBlocking {
        val blobKey = AccountEncryption.blobKeyForDataKey(server.dataKey("s1"))
        (0..50).forEach { i -> server.attachments["sessions/s1/attachments/$i.enc"] = encryptBlob(byteArrayOf(i.toByte()), blobKey) }
        transfers.load("s1", "sessions/s1/attachments/0.enc")
        (1..49).forEach { transfers.load("s1", "sessions/s1/attachments/$it.enc") }
        // Touch 0, then one more pushes out the least recently used (1).
        assertNotNull(transfers.cached("sessions/s1/attachments/0.enc"))
        transfers.load("s1", "sessions/s1/attachments/50.enc")
        assertNotNull(transfers.cached("sessions/s1/attachments/0.enc"))
        assertNull(transfers.cached("sessions/s1/attachments/1.enc"))
    }

    @Test
    fun fileEventRecordIsSyncTsShape() {
        val image = fileEventRecord(UploadedAttachment("sessions/s1/attachments/a.enc", "a.jpg", 1234, 640, 480), id = "e1", time = 7)
        assertEquals(
            Json.parseToJsonElement(
                """{"role":"session","content":{"type":"session","data":{"id":"e1","time":7,"role":"user",""" +
                    """"ev":{"t":"file","ref":"sessions/s1/attachments/a.enc","name":"a.jpg","size":1234,"image":{"width":640,"height":480}}}}}""",
            ),
            image,
        )
        val withThumb = fileEventRecord(UploadedAttachment("r", "b.png", 5, 2, 1, thumbhash = "abc"), id = "e2", time = 8)
        assertEquals("""{"width":2,"height":1,"thumbhash":"abc"}""", ((((withThumb["content"] as JsonObject)["data"] as JsonObject)["ev"] as JsonObject)["image"]).toString())
        // Without dimensions there is no image block.
        val file = fileEventRecord(UploadedAttachment("r", "c.bin", 5, 0, 0), id = "e3", time = 9)
        assertFalse((((file["content"] as JsonObject)["data"] as JsonObject)["ev"] as JsonObject).containsKey("image"))
        assertEquals(2, fileEventRecords(listOf(UploadedAttachment("r", "a", 1, 1, 1), UploadedAttachment("s", "b", 1, 1, 1))).size)
    }

    private companion object {
        const val STORAGE_HOST = "files.test"
    }
}
