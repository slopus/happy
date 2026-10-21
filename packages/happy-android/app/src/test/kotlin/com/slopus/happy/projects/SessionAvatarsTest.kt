package com.slopus.happy.projects

import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.crypto.encryptBlob
import com.slopus.happy.model.ProjectAvatar
import com.slopus.happy.model.SessionAvatarDescriptor
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * sessionAvatars.ts and SessionAvatarHydrator: descriptors validated as
 * the schema says; the preview opened with the session's key, the grant
 * checked against the descriptor's ref, the bytes with its blob key; one
 * download per session, a replaced descriptor's late answer dropped.
 */
class SessionAvatarsTest {
    private val dataKey = AccountEncryption.generateDataKey()
    private val encryption = AccountEncryption.create(ByteArray(32) { 7 })
    private val cipher = encryption.dataKeyCipher(dataKey)
    private val blobKey = AccountEncryption.blobKeyForDataKey(dataKey)
    private val preview = cipher.encryptToBase64(buildJsonObject { put("thumbhash", "abcdef"); put("mimeType", "image/webp") })

    @Test fun descriptorsFollowTheSchema() {
        fun parse(text: String) = SessionAvatarDescriptor.parse(HappyJson.parseToJsonElement(text))
        assertEquals(SessionAvatarDescriptor("r", "p", 2), parse("""{"ref":"r","preview":"p","version":2}"""))
        assertNull(parse("""{"ref":"","preview":"p","version":2}"""))
        assertNull("version must be positive", parse("""{"ref":"r","preview":"p","version":0}"""))
        assertNull(parse("""{"ref":"r","preview":"p","version":"2"}"""))
    }

    @Test fun loadsAndChecksTheGrant() = runTest {
        val descriptor = SessionAvatarDescriptor("ref-1", preview, 1)
        val bytes = byteArrayOf(9, 8, 7)
        val avatar = loadSessionAvatar(descriptor, cipher, blobKey, grant = { "ref-1" to "https://cdn.example.com/a" }, download = { encryptBlob(bytes, blobKey) })
        assertEquals("data:image/webp;base64,${encodeBase64(bytes)}", avatar?.uri)
        assertEquals("abcdef", avatar?.thumbhash)
        assertNull("replaced meanwhile", loadSessionAvatar(descriptor, cipher, blobKey, grant = { "ref-2" to "https://x/a" }, download = { encryptBlob(bytes, blobKey) }))
        assertNull("credentials in the URL", loadSessionAvatar(descriptor, cipher, blobKey, grant = { "ref-1" to "https://u:p@x/a" }, download = { encryptBlob(bytes, blobKey) }))
        assertNull("wrong key", loadSessionAvatar(descriptor, cipher, blobKey, grant = { "ref-1" to "https://x/a" }, download = { encryptBlob(bytes, ByteArray(32)) }))
        val gif = cipher.encryptToBase64(buildJsonObject { put("thumbhash", "abcdef"); put("mimeType", "image/gif") })
        assertNull("only webp, png, jpeg", loadSessionAvatar(descriptor.copy(preview = gif), cipher, blobKey, grant = { "ref-1" to "https://x/a" }, download = { encryptBlob(bytes, blobKey) }))
    }

    @Test fun aReplacedDescriptorsLateAnswerIsDropped() = runTest {
        val first = CompletableDeferred<ProjectAvatar?>()
        val loads = mutableListOf<SessionAvatarDescriptor>()
        val hydrator = SessionAvatarHydrator(this) { _, descriptor ->
            loads += descriptor
            if (descriptor.version == 1L) first.await() else ProjectAvatar(descriptor.ref, descriptor.version, "image/png", "t", "data:2")
        }
        val one = SessionAvatarDescriptor("a", "p", 1)
        val two = SessionAvatarDescriptor("b", "p", 2)
        hydrator.update(mapOf("s" to one))
        hydrator.update(mapOf("s" to one))
        runCurrent()
        assertEquals("one download per descriptor", 1, loads.size)
        hydrator.update(mapOf("s" to two))
        runCurrent()
        first.complete(ProjectAvatar("a", 1, "image/png", "t", "data:1"))
        runCurrent()
        assertEquals("data:2", hydrator.avatars.value["s"]?.uri)
        hydrator.update(mapOf("s" to null))
        assertNull(hydrator.avatars.value["s"])
    }
}
