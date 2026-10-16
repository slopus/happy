package com.slopus.happy.attachments

import com.slopus.happy.attachments.AttachmentDiagnosticLeg.BlobDownload
import com.slopus.happy.attachments.AttachmentDiagnosticLeg.BlobUpload
import com.slopus.happy.attachments.AttachmentDiagnosticLeg.DecryptRender
import com.slopus.happy.attachments.AttachmentDiagnosticMethod.GET
import com.slopus.happy.attachments.AttachmentDiagnosticMethod.POST
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/** attachmentDiagnostics.test.ts: what a transfer failure may say in a log. */
class AttachmentDiagnosticsTest {
    private val storage = "https://files.cluster-fluster.com/happy/sessions/ref?X-Amz-Signature=secret&policy=secret"
    private val api = "https://api.cluster-fluster.com"

    private fun assertNone(rendered: String, vararg leaks: String) = leaks.forEach { assertFalse("leaked $it in $rendered", rendered.contains(it)) }

    @Test
    fun hostsKeepOnlyHostAndPort() {
        assertEquals("files.cluster-fluster.com", sanitizeAttachmentUrlHost("https://files.cluster-fluster.com/happy/sessions/ref?X-Amz-Signature=secret"))
        assertEquals("127.0.0.1:3005", sanitizeAttachmentUrlHost("http://127.0.0.1:3005/v1/sessions/abc?token=secret"))
        assertEquals("files.cluster-fluster.com", sanitizeAttachmentUrlHost("HTTPS://user:pw@Files.Cluster-Fluster.com:443/x"))
        assertNull(sanitizeAttachmentUrlHost(null))
        assertNull(sanitizeAttachmentUrlHost("/relative/path?token=secret"))
        assertNull(sanitizeAttachmentUrlHost("not a url with /slashes?token=secret"))
    }

    @Test
    fun targetsAreClassifiedByHost() {
        assertEquals(AttachmentTransferTarget.HappyApi, classifyAttachmentTransferTarget("$api/v1/sessions/abc/attachments/blob", api))
        assertEquals(AttachmentTransferTarget.ExternalStorage, classifyAttachmentTransferTarget("https://files.cluster-fluster.com/happy/abc?policy=secret", api))
        assertEquals(AttachmentTransferTarget.Unknown, classifyAttachmentTransferTarget("/v1/sessions/abc/attachments/blob", api))
    }

    @Test
    fun aResponseDiagnosticKeepsOnlySafeFields() {
        val diagnostic = createAttachmentDiagnostic(AttachmentDiagnosticInput(BlobUpload, POST, storage, api, 403, "Forbidden"))
        assertEquals(
            AttachmentDiagnostic(BlobUpload, POST, "files.cluster-fluster.com", AttachmentTransferTarget.ExternalStorage, 403, "Forbidden"),
            diagnostic,
        )
        val rendered = diagnostic.forLog(platform = "android", client = "android/1.2.3")
        assertEquals("blob-upload", rendered["leg"])
        assertEquals("external-storage", rendered["target"])
        assertEquals("android", rendered["platform"])
        assertEquals("android/1.2.3", rendered["client"])
        assertNone(rendered.toString(), "/happy/sessions/ref", "X-Amz-Signature", "policy", "secret")
    }

    @Test
    fun networkMessagesStayButNotUrls() {
        assertEquals(
            AttachmentDiagnostic(BlobDownload, GET, "files.cluster-fluster.com", AttachmentTransferTarget.ExternalStorage, message = "Failed to fetch"),
            createAttachmentDiagnostic(AttachmentDiagnosticInput(BlobDownload, GET, storage, api, message = "Failed to fetch")),
        )
        val dirty = createAttachmentDiagnostic(AttachmentDiagnosticInput(BlobDownload, url = "https://X-Amz-Signature=secret", serverUrl = api))
        assertNull(dirty.host)
        assertNone(dirty.toString().lowercase(), "x-amz-signature", "secret")
    }

    @Test
    fun messagesAndReasonsAreRedacted() {
        val diagnostic = createAttachmentDiagnostic(
            AttachmentDiagnosticInput(
                BlobDownload, GET, storage, api,
                message = "Fetch failed for $storage using Bearer secret-token",
                reason = "Read failed from file:///Users/devdvlive/Projects/happy/local.bin and /Users/devdvlive/Projects/happy/other.bin",
            ),
        )
        assertTrue(diagnostic.message!!.contains("[url:files.cluster-fluster.com]"))
        assertTrue(diagnostic.reason!!.contains("[local-file]"))
        assertNone(diagnostic.toString(), "X-Amz-Signature", "policy", "Bearer", "/happy/", "/Users/devdvlive", "local.bin", "other.bin")
    }

    @Test
    fun otherSchemesAndDataUrisAreRedacted() {
        val s3 = createAttachmentDiagnostic(AttachmentDiagnosticInput(BlobDownload, GET, message = "Fetch failed for s3://bucket/happy/ref?X-Amz-Signature=secret", reason = "missing-blob-key"))
        assertTrue(s3.message!!.contains("[url:bucket]"))
        assertEquals("missing-blob-key", s3.reason)
        assertNone(s3.toString(), "/happy/ref", "X-Amz-Signature", "secret")

        listOf(
            "Preview failed for data:image/png;base64,iVBORw0KGgoSECRET",
            "Preview failed for data:text/plain,hello world SECRET",
            "Preview failed for data:text/plain,hello\nSECRET",
        ).forEach { reason ->
            val d = createAttachmentDiagnostic(AttachmentDiagnosticInput(DecryptRender, message = "Failed to fetch", reason = reason))
            assertEquals("Failed to fetch", d.message)
            assertTrue(d.reason!!.contains("[data-uri]"))
            assertNone(d.toString(), "data:", "base64", "SECRET", "hello")
        }

        assertEquals("[url:blob]", errorMessageFromUnknown(IOException("blob:secret-payload")))
        assertEquals("[url:mailto]", errorMessageFromUnknown(IOException("mailto:user@example.com")))
        assertEquals("Failed to fetch", errorMessageFromUnknown(IOException("Failed to fetch")))
    }

    @Test
    fun localPathsAreRedacted() {
        listOf(
            "Read failed from /Users/devdvlive/My Projects/happy/blob.bin",
            "Read failed from file:///Users/devdvlive/My Projects/happy/blob.bin",
            "Read failed from C:\\Users\\devdvlive\\My Projects\\happy\\blob.bin",
            "Read failed from C:/Users/devdvlive/My Projects/happy/blob.bin",
            "Read failed from D:\\Photos\\Private Album\\secret.jpg",
            "Read failed from D:/Photos/Private Album/secret.jpg",
            "Read failed from /data/data/com.happy/cache/blob.bin",
            "Read failed from /data/user/0/com.happy/cache/blob.bin",
            "Missing file at /storage/emulated/0/Download/photo.png and /sdcard/Pictures/photo.png",
        ).forEach { source ->
            val rendered = createAttachmentDiagnostic(AttachmentDiagnosticInput(DecryptRender, reason = source)).toString() +
                errorMessageFromUnknown(IOException(source))
            assertTrue(source, rendered.contains("[local-file]"))
            assertNone(rendered, "/Users", "C:\\Users", "C:/Users", "D:\\Photos", "D:/Photos", "My Projects", "Private Album",
                "blob.bin", "secret.jpg", "/data/data", "/data/user/0", "/storage/emulated/0", "/sdcard", "photo.png", "com.happy")
        }
        listOf(
            "path=/Users/dev/My Projects/blob.bin",
            "path=/data/user/0/com.happy/cache/blob.bin",
            "path=C:\\Users\\dev\\My Projects\\blob.bin",
            "path=C:/Users/dev/My Projects/blob.bin",
        ).forEach { source ->
            val rendered = createAttachmentDiagnostic(AttachmentDiagnosticInput(DecryptRender, message = "Failed to fetch", reason = source)).toString()
            assertTrue(source, rendered.contains("path=[local-file]"))
            assertNone(rendered, "/Users", "/data/user/0", "My Projects", "blob.bin")
        }
    }

    @Test
    fun refsAreRedacted() {
        val diagnostic = createAttachmentDiagnostic(
            AttachmentDiagnosticInput(
                DecryptRender,
                message = "Render failed for ref: happy/session-1/ref and ref happy/session-1/ref",
                reason = "missing blob key (ref=sessions/abc/attachments/secret-ref)",
            ),
        )
        assertTrue(diagnostic.toString().contains("[attachment-ref]"))
        assertNone(diagnostic.toString(), "sessions/abc/attachments/secret-ref", "happy/session-1/ref")

        val standalone = createAttachmentDiagnostic(AttachmentDiagnosticInput(DecryptRender, message = "happy/session-1/ref", reason = "missing-blob-key happy/session-1/ref"))
        assertTrue(standalone.toString().contains("[attachment-ref]"))
        assertNone(standalone.toString(), "happy/session-1/ref")

        val leading = createAttachmentDiagnostic(AttachmentDiagnosticInput(DecryptRender, message = "missing /happy/session-1/ref?X-Amz-Signature=secret", reason = "ref=/happy/session-1/ref"))
        assertTrue(leading.toString().contains("[attachment-ref]"))
        assertNone(leading.toString(), "/happy/session-1/ref", "X-Amz-Signature")
    }

    @Test
    fun aLocalDecryptHasNoTarget() {
        assertEquals(
            AttachmentDiagnostic(DecryptRender, reason = "missing-blob-key"),
            createAttachmentDiagnostic(AttachmentDiagnosticInput(DecryptRender, reason = "missing-blob-key")),
        )
    }

    @Test
    fun logFormattingReSanitizesEveryField() {
        val rendered = AttachmentDiagnostic(
            BlobDownload, GET,
            host = "https://files.cluster-fluster.com/happy/ref?X-Amz-Signature=secret",
            target = AttachmentTransferTarget.ExternalStorage,
            status = 403,
            statusText = "Forbidden from https://files.cluster-fluster.com/happy/ref?X-Amz-Signature=secret",
            message = "Failed to fetch",
            reason = "missing-blob-key",
        ).forLog(platform = "android happy/session-1/ref", client = "android/1.2.3 Bearer secret-token /data/data/com.happy/cache/blob.bin")
        assertEquals("files.cluster-fluster.com", rendered["host"])
        assertEquals("Failed to fetch", rendered["message"])
        assertEquals("missing-blob-key", rendered["reason"])
        assertNone(rendered.toString(), "X-Amz-Signature", "/happy/ref", "Bearer", "/data/data", "com.happy", "blob.bin", "happy/session-1/ref")

        listOf(
            "X-Amz-Signature=secret&policy=secret",
            "C:\\Users\\devdvlive\\My Projects\\happy\\blob.bin",
            "data:,SECRET",
            "user:secret@files.cluster-fluster.com",
            "file:///Users/devdvlive/My Projects/happy/blob.bin",
            "https://X-Amz-Signature=secret",
        ).forEach { host -> assertNull(host, AttachmentDiagnostic(BlobDownload, host = host).forLog()["host"]) }
        assertEquals("files.cluster-fluster.com", AttachmentDiagnostic(BlobDownload, host = "https://user:secret@files.cluster-fluster.com/path").forLog()["host"])
        listOf("files.cluster-fluster.com", "api.cluster-fluster.com:3005", "127.0.0.1:3005", "localhost:3005").forEach {
            assertEquals(it, AttachmentDiagnostic(BlobDownload, host = it).forLog()["host"])
        }
    }

    @Test
    fun errorsCarryTheirDiagnostic() {
        val error = createAttachmentDiagnosticError(
            "Blob upload (POST) failed: 403 Forbidden",
            AttachmentDiagnosticInput(BlobUpload, POST, "https://files.cluster-fluster.com/happy/ref?X-Amz-Signature=secret", api, 403, "Forbidden"),
        )
        assertEquals("Blob upload (POST) failed: 403 Forbidden", error.message)
        assertEquals(
            AttachmentDiagnostic(BlobUpload, POST, "files.cluster-fluster.com", AttachmentTransferTarget.ExternalStorage, 403, "Forbidden"),
            getAttachmentDiagnostic(error),
        )

        val unsafe = createAttachmentDiagnosticError(
            "Blob upload failed for https://files.cluster-fluster.com/happy/ref?X-Amz-Signature=secret using Bearer secret-token at /data/user/0/com.happy/cache/blob.bin",
            AttachmentDiagnosticInput(BlobUpload, POST),
        )
        assertTrue(unsafe.message!!.contains("files.cluster-fluster.com"))
        assertEquals(unsafe.message, errorMessageFromUnknown(unsafe))
        assertNone(unsafe.message!!, "X-Amz-Signature", "Bearer", "/happy/ref", "/data/user/0", "blob.bin")

        assertNull(getAttachmentDiagnostic(IOException("plain failure")))
        assertNull(getAttachmentDiagnostic(null))
    }
}
