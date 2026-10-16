package com.slopus.happy.projects

import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.crypto.encryptBlob
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * sync.ts fetchProjects and projects.ts against a fake server: records of
 * the wrong shape are dropped; metadata opens with the project's data key,
 * or with the account secretbox for the legacy form; names are published
 * before artwork, which arrives as a data URI decrypted with the project's
 * blob key (the master blob key for the legacy form); a failed avatar
 * leaves the name; a changed descriptor is downloaded again and an
 * unchanged one is not; a project no session names any more is dropped.
 */
class ProjectCatalogTest {
    private val encryption = AccountEncryption.create(ByteArray(32) { it.toByte() })
    private val dataKey = AccountEncryption.generateDataKey()
    private val wrapped = encodeBase64(encryption.encryptDataEncryptionKey(dataKey))
    private val cipher = encryption.dataKeyCipher(dataKey)
    private val png = byteArrayOf(1, 2, 3)

    private fun meta(name: String) = buildJsonObject { put("name", name); put("kind", "regular") }
    private val preview = buildJsonObject { put("thumbhash", "abcd"); put("mimeType", "image/png") }

    private fun record(id: String, name: String, version: Long = 1, avatar: Boolean = true, legacy: Boolean = false): ApiProjectRecord {
        val c = if (legacy) encryption.settingsCipher() else cipher
        return ApiProjectRecord(
            id = id,
            externalId = "ext-$id",
            metadata = c.encryptToBase64(meta(name)),
            metadataVersion = 1,
            dataEncryptionKey = if (legacy) null else wrapped,
            avatar = if (avatar) ApiProjectAvatar("ref-$id", c.encryptToBase64(preview), version) else null,
            createdAt = 1,
            updatedAt = 2,
        )
    }

    @Test fun recordsOfTheWrongShapeAreDropped() {
        fun parse(text: String) = parseProjectRecord(HappyJson.parseToJsonElement(text))
        val good = """{"id":"p1","externalId":"e","metadata":"m","metadataVersion":1,"dataEncryptionKey":null,"avatar":null,"createdAt":1,"updatedAt":2}"""
        assertEquals("p1", parse(good)?.id)
        assertNull(parse(good)?.dataEncryptionKey)
        assertNull("a missing key field", parse(good.replace(""""dataEncryptionKey":null,""", "")))
        assertNull("an empty id", parse(good.replace(""""id":"p1"""", """"id":""""")))
        assertNull("a malformed avatar drops the record", parse(good.replace(""""avatar":null""", """"avatar":{"ref":"r"}""")))
        assertEquals(3L, parse(good.replace(""""avatar":null""", """"avatar":{"ref":"r","preview":"p","version":3}"""))?.avatar?.version)
    }

    @Test fun namesFirstThenArtwork() = runTest {
        val download = CompletableDeferred<ByteArray>()
        val catalog = ProjectCatalog(encryption, fetch = { listOf(record("p1", "App")) }, downloadAvatar = { download.await() })
        val refresh = async { catalog.refresh(setOf("p1")) }
        runCurrent()
        val named = catalog.projects.value.getValue("p1")
        assertEquals("App", named.name)
        assertEquals("regular", named.kind)
        assertNull("no artwork yet", named.avatar)
        download.complete(encryptBlob(png, AccountEncryption.blobKeyForDataKey(dataKey)))
        refresh.await()
        val avatar = catalog.projects.value.getValue("p1").avatar
        assertNotNull(avatar)
        assertEquals("data:image/png;base64,${encodeBase64(png)}", avatar!!.uri)
        assertEquals("abcd", avatar.thumbhash)
    }

    @Test fun theLegacyFormOpensWithTheAccountKeys() = runTest {
        val catalog = ProjectCatalog(
            encryption,
            fetch = { listOf(record("p1", "Old", legacy = true)) },
            downloadAvatar = { encryptBlob(png, encryption.masterBlobKey) },
        )
        catalog.refresh(setOf("p1"))
        assertEquals("Old", catalog.projects.value.getValue("p1").name)
        assertNotNull(catalog.projects.value.getValue("p1").avatar)
    }

    @Test fun unreadableRecordsAndFailedArtwork() = runTest {
        val foreign = record("p2", "Theirs").copy(dataEncryptionKey = encodeBase64(byteArrayOf(0, 1, 2)))
        val catalog = ProjectCatalog(encryption, fetch = { listOf(record("p1", "App"), foreign) }, downloadAvatar = { error("offline") })
        catalog.refresh(setOf("p1", "p2"))
        assertEquals(setOf("p1"), catalog.projects.value.keys)
        assertNull(catalog.projects.value.getValue("p1").avatar)
    }

    @Test fun artworkIsDownloadedOncePerDescriptor() = runTest {
        var version = 1L
        var present = true
        var downloads = 0
        val catalog = ProjectCatalog(
            encryption,
            fetch = { if (present) listOf(record("p1", "App", version)) else emptyList() },
            downloadAvatar = { downloads++; encryptBlob(png, AccountEncryption.blobKeyForDataKey(dataKey)) },
        )
        catalog.refresh(setOf("p1"))
        catalog.refresh(setOf("p1"))
        assertEquals(1, downloads)
        assertNotNull("kept across refreshes", catalog.projects.value.getValue("p1").avatar)
        version = 2
        catalog.refresh(setOf("p1"))
        assertEquals(2, downloads)
        assertEquals(2L, catalog.projects.value.getValue("p1").avatar?.version)
        present = false
        catalog.refresh(emptySet())
        assertTrue(catalog.projects.value.isEmpty())
    }

    @Test fun sameOriginCarriesTheToken() {
        assertTrue(sameOrigin("https://api.example.com/blob/1", "https://api.example.com"))
        assertEquals(false, sameOrigin("https://bucket.s3.amazonaws.com/x", "https://api.example.com"))
    }
}
