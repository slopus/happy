package com.slopus.happy.attachments

import android.util.Log
import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.crypto.decryptBlob
import com.slopus.happy.crypto.encryptBlob
import com.slopus.happy.data.HappyStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.util.UUID

/** attachmentTypes.ts AttachmentPreview: a picked image, ready to upload. */
data class AttachmentPreview(
    /** Stable unique id, for the strip's keys and removal. */
    val id: String,
    /** Where its bytes are (a processed JPEG in the cache directory). */
    val uri: String,
    val width: Int,
    val height: Int,
    val mimeType: String,
    /** May be 0 when the system did not say. */
    val size: Long,
    val name: String,
)

/** attachmentTypes.ts UploadedAttachment: an uploaded blob, ready to become a file event. */
data class UploadedAttachment(
    val ref: String,
    val name: String,
    val size: Long,
    val width: Int,
    val height: Int,
    /** Never set on Android, as on happy-app's native builds (no thumbhash encoder). */
    val thumbhash: String? = null,
)

data class AttachmentUploadResult(val uploaded: List<UploadedAttachment>, val failed: Int)

/**
 * sync.ts's message file event for one uploaded attachment: the raw record
 * (before encryption) that goes into the outbox ahead of the message text,
 * as its own message with its own local id. Image metadata is included
 * when the dimensions are known; thumbhash only when there is one.
 *
 * ```
 * { role: "session", content: { type: "session", data: {
 *     id, time, role: "user",
 *     ev: { t: "file", ref, name, size, image?: { width, height, thumbhash? } } } } }
 * ```
 */
fun fileEventRecord(
    attachment: UploadedAttachment,
    id: String = UUID.randomUUID().toString(),
    time: Long = System.currentTimeMillis(),
): JsonObject = buildJsonObject {
    put("role", "session")
    putJsonObject("content") {
        put("type", "session")
        putJsonObject("data") {
            put("id", id)
            put("time", time)
            put("role", "user")
            putJsonObject("ev") {
                put("t", "file")
                put("ref", attachment.ref)
                put("name", attachment.name)
                put("size", attachment.size)
                if (attachment.width > 0 && attachment.height > 0) {
                    putJsonObject("image") {
                        put("width", attachment.width)
                        put("height", attachment.height)
                        attachment.thumbhash?.let { put("thumbhash", it) }
                    }
                }
            }
        }
    }
}

/** The records for [attachments], in order: enqueue them before the text. */
fun fileEventRecords(attachments: List<UploadedAttachment>): List<JsonObject> = attachments.map { fileEventRecord(it) }

/**
 * encryption.ts session blob keys: a session's blobs are encrypted with a
 * key derived from its data key ("Happy Blobs", ["session"]), so they are
 * separate from its messages. Sessions without a data key (retired
 * protocol) have none here.
 */
class SessionBlobKeys(private val store: HappyStore, private val encryption: AccountEncryption) {
    private val keys = object : LinkedHashMap<String, ByteArray>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ByteArray>) = size > 64
    }

    fun blobKey(sessionId: String): ByteArray? {
        val wrapped = store.session(sessionId)?.wrappedDataKey ?: return null
        synchronized(keys) { keys[wrapped]?.let { return it } }
        val dataKey = encryption.decryptDataEncryptionKey(wrapped) ?: return null
        val key = AccountEncryption.blobKeyForDataKey(dataKey)
        synchronized(keys) { keys[wrapped] = key }
        return key
    }
}

/**
 * The account's attachment transfers: sync.ts uploadAttachmentsForSession
 * and useAttachmentImage.ts loadAttachmentDataUri, with the decrypted-blob
 * LRU (50 entries, keyed by ref) and one download per ref at a time.
 */
class AttachmentTransfers(
    private val api: AttachmentApi,
    private val blobKeys: (sessionId: String) -> ByteArray?,
    private val token: () -> String?,
) {
    private val cache = object : LinkedHashMap<String, ByteArray>(MAX_CACHE_ENTRIES, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ByteArray>) = size > MAX_CACHE_ENTRIES
    }
    private val inFlight = mutableMapOf<String, CompletableDeferred<ByteArray?>>()

    /**
     * Reads, encrypts and uploads each attachment. One that fails is logged
     * and counted, not fatal: the rest of the message still goes.
     */
    suspend fun upload(
        sessionId: String,
        attachments: List<AttachmentPreview>,
        read: suspend (AttachmentPreview) -> ByteArray,
    ): AttachmentUploadResult {
        val auth = token() ?: return AttachmentUploadResult(emptyList(), attachments.size)
        val blobKey = withContext(Dispatchers.IO) { blobKeys(sessionId) }
        if (blobKey == null) {
            Log.e(TAG, "[attachments] No blob key for session")
            return AttachmentUploadResult(emptyList(), attachments.size)
        }
        val uploaded = mutableListOf<UploadedAttachment>()
        var failed = 0
        for (attachment in attachments) {
            try {
                val encrypted = withContext(Dispatchers.Default) { encryptBlob(read(attachment), blobKey) }
                val upload = api.requestUpload(auth, sessionId, attachment.name, encrypted.size.toLong())
                api.uploadBlob(upload, encrypted, auth)
                uploaded += UploadedAttachment(upload.ref, attachment.name, attachment.size, attachment.width, attachment.height)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val diagnostic = getAttachmentDiagnostic(e)
                    ?: createAttachmentDiagnostic(AttachmentDiagnosticInput(AttachmentDiagnosticLeg.BlobUpload, message = errorMessageFromUnknown(e)))
                Log.e(TAG, "[attachments] Failed to upload image attachment: ${diagnostic.forLog(platform = PLATFORM)}")
                failed++
            }
        }
        return AttachmentUploadResult(uploaded, failed)
    }

    /** The decrypted blob if it is in the LRU (and marks it recently used). */
    fun cached(ref: String): ByteArray? = synchronized(cache) { cache[ref] }

    /**
     * useAttachmentImage: the decrypted blob of [ref], from the LRU or
     * downloaded and decrypted. Null when it can't be had (logged, safely).
     */
    suspend fun load(sessionId: String, ref: String): ByteArray? {
        cached(ref)?.let { return it }
        var owner = false
        val deferred = synchronized(inFlight) {
            inFlight[ref] ?: CompletableDeferred<ByteArray?>().also {
                inFlight[ref] = it
                owner = true
            }
        }
        if (!owner) return deferred.await()
        try {
            val bytes = download(sessionId, ref)
            if (bytes != null) synchronized(cache) { cache[ref] = bytes }
            deferred.complete(bytes)
            return bytes
        } catch (e: Throwable) {
            deferred.completeExceptionally(e)
            throw e
        } finally {
            synchronized(inFlight) { inFlight.remove(ref) }
        }
    }

    private suspend fun download(sessionId: String, ref: String): ByteArray? {
        val auth = token() ?: return warn("no-credentials")
        val blobKey = withContext(Dispatchers.IO) { blobKeys(sessionId) } ?: return warn("missing-blob-key")
        if (blobKey.size != 32) return warn("invalid-blob-key-length", blobKey.size.toString())
        val encrypted = try {
            api.download(auth, sessionId, ref)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val diagnostic = getAttachmentDiagnostic(e)
                ?: createAttachmentDiagnostic(AttachmentDiagnosticInput(AttachmentDiagnosticLeg.BlobDownload, message = errorMessageFromUnknown(e)))
            Log.w(TAG, "[attachment-image] download failed: ${diagnostic.forLog(platform = PLATFORM)}")
            return null
        }
        return withContext(Dispatchers.Default) { decryptBlob(encrypted, blobKey) } ?: warn("decrypt-returned-null")
    }

    private fun warn(reason: String, message: String? = null): ByteArray? {
        val diagnostic = createAttachmentDiagnostic(AttachmentDiagnosticInput(AttachmentDiagnosticLeg.DecryptRender, reason = reason, message = message))
        Log.w(TAG, "[attachment-image] load failed: ${diagnostic.forLog(platform = PLATFORM)}")
        return null
    }

    companion object {
        const val MAX_CACHE_ENTRIES = 50
        private const val TAG = "Attachments"
        private const val PLATFORM = "android"
    }
}
