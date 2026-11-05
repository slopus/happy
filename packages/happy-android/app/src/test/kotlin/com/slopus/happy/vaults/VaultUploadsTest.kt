package com.slopus.happy.vaults

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.FakeAgent
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException

/** A daemon with the vault routes an upload uses, holding its uploads' bytes. */
private class VaultDaemon : Transport by FakeAgent() {
    data class Request(val method: String, val path: String, val body: ByteArray?, val headers: Map<String, String>, val category: RequestCategory) {
        val json: JsonObject? get() = body?.let { runCatching { Json.parseToJsonElement(it.decodeToString()).jsonObject }.getOrNull() }
    }

    val requests = ArrayList<Request>()
    val uploads = HashMap<String, java.io.ByteArrayOutputStream>()
    var sizes = HashMap<String, Long>()
    /** Appends that fail after keeping this many of their bytes, once each. */
    val failures = ArrayDeque<Int>()
    /** Names taken in the root, by the entry that has them. */
    val taken = HashMap<String, String>()
    val kinds = HashMap<String, String>()
    var refuseArtifacts = false
    var reply: ((Request) -> Pair<Int, String>?)? = null

    private fun upload(id: String): String {
        val received = uploads.getValue(id).size()
        val size = sizes.getValue(id)
        return """{"id":"$id","size":$size,"received":$received,"status":"${if (received.toLong() == size) "complete" else "receiving"}","expiresAt":9}"""
    }

    override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
        val request = Request(method, path, body, headers, category)
        requests += request
        val (status, json) = reply?.invoke(request) ?: answer(request)
        return TransportResponse(status, mapOf("content-type" to "application/json"), json.toByteArray())
    }

    private fun answer(request: Request): Pair<Int, String> {
        val path = request.path
        return when {
            request.method == "POST" && path == "/v0/vault-uploads" -> {
                val id = "up${uploads.size + 1}"
                uploads[id] = java.io.ByteArrayOutputStream()
                sizes[id] = request.json!!["size"]!!.jsonPrimitive.content.toLong()
                201 to """{"upload":${upload(id)}}"""
            }
            request.method == "GET" && path.startsWith("/v0/vault-uploads/") -> 200 to """{"upload":${upload(path.substringAfterLast('/'))}}"""
            request.method == "DELETE" && path.startsWith("/v0/vault-uploads/") -> 200 to "{}"
            request.method == "PUT" -> {
                val id = path.substringAfterLast('/')
                val range = request.headers.getValue("Content-Range")
                val start = range.removePrefix("bytes ").substringBefore('-').toLong()
                val held = uploads.getValue(id)
                if (start != held.size().toLong()) return 409 to """{"error":"Wrong offset","code":"upload_offset_mismatch","upload":${upload(id)}}"""
                val bytes = request.body!!
                failures.removeFirstOrNull()?.let { kept ->
                    held.write(bytes, 0, kept)
                    throw IOException("connection reset")
                }
                held.write(bytes)
                200 to """{"upload":${upload(id)}}"""
            }
            request.method == "POST" && path == "/v0/surfaces/vault/s1/files" -> {
                val fields = request.json!!
                val name = fields["name"]!!.jsonPrimitive.content
                val kind = if (name.endsWith(".artifact")) "artifact" else "file"
                taken[name]?.let { owner ->
                    return 409 to """{"error":"Taken","code":"name_taken","item":{"id":"$owner","surfaceId":"s1","parentId":null,"name":"$name","kind":"${kinds[owner] ?: "file"}","version":"v1"}}"""
                }
                if (kind == "artifact" && refuseArtifacts) return 400 to """{"error":"The .artifact file has no artifact.json at its root.","code":"invalid_request"}"""
                val id = fields["id"]!!.jsonPrimitive.content
                taken[name] = id
                kinds[id] = kind
                201 to """{"file":{"id":"$id","surfaceId":"s1","parentId":null,"name":"$name","kind":"$kind","latestVersion":1,"version":"v1"}}"""
            }
            request.method == "POST" && path.endsWith("/versions") -> {
                val id = path.removeSuffix("/versions").substringAfterLast('/')
                201 to """{"file":{"id":"$id","surfaceId":"s1","parentId":null,"name":"x","kind":"file","latestVersion":2,"version":"v2"},"version":{"number":2,"size":1,"createdAt":1,"pinned":false}}"""
            }
            else -> 404 to """{"error":"Not found","code":"not_found"}"""
        }
    }
}

private class Bytes(override val name: String, val bytes: ByteArray) : VaultUploadSource {
    var opened = 0
    override val size: Long get() = bytes.size.toLong()
    override fun open() = ByteArrayInputStream(bytes).also { opened += 1 }
}

class VaultUploadsTest {
    private fun bytes(size: Int) = ByteArray(size) { (it * 31 + 7).toByte() }

    @Test
    fun aFileIsSentInPiecesAndResumedWhereTheDaemonIs() = runBlocking {
        val daemon = VaultDaemon()
        val placed = ArrayList<VaultItem>()
        val source = Bytes("photo.jpg", bytes(3 * 1024 * 1024 + 5))
        withTimeout(10_000) {
            val uploads = VaultUploads(VaultClient(AgentClient(daemon, "t")), this, { placed += it }, retryMs = 0)
            var appends = 0
            // The second piece breaks part way, with some of it kept.
            daemon.reply = { request ->
                if (request.method == "PUT" && ++appends == 2) daemon.failures += 1000
                null
            }
            uploads.add("s1", null, source)
            uploads.tasks.first { it.isEmpty() }
        }
        assertArrayEquals(source.bytes, daemon.uploads.getValue("up1").toByteArray())
        assertEquals(listOf("photo.jpg"), placed.map { it.name })
        val puts = daemon.requests.filter { it.method == "PUT" }
        assertTrue(puts.all { it.category == RequestCategory.File })
        assertEquals("bytes 0-1048575/3145733", puts[0].headers["Content-Range"])
        // After the failure it asks where the upload is, and sends from there.
        val resumedAt = puts.drop(2).first().headers.getValue("Content-Range").removePrefix("bytes ").substringBefore('-').toLong()
        assertEquals(1048576L + 1000, resumedAt)
        assertTrue(source.opened >= 2)
        val create = daemon.requests.single { it.method == "POST" && it.path == "/v0/surfaces/vault/s1/files" }
        assertEquals("up1", create.json!!["uploadId"]!!.jsonPrimitive.content)
        assertNull(create.headers["If-Match"])
    }

    @Test
    fun aTakenNameWaitsForTheChoice() = runBlocking {
        val daemon = VaultDaemon()
        daemon.taken["notes.txt"] = "old"
        val placed = ArrayList<VaultItem>()
        withTimeout(10_000) {
            val uploads = VaultUploads(VaultClient(AgentClient(daemon, "t")), this, { placed += it }, retryMs = 0)
            val first = uploads.add("s1", null, Bytes("notes.txt", bytes(10)))
            val waiting = uploads.tasks.first { tasks -> tasks.any { it.status == VaultUploads.Status.NameTaken } }.single()
            assertEquals("old", waiting.taken?.id)
            uploads.resolve(first, VaultUploads.Choice.KeepBoth)
            uploads.tasks.first { it.isEmpty() }
            val second = uploads.add("s1", null, Bytes("notes.txt", bytes(12)))
            uploads.tasks.first { tasks -> tasks.any { it.status == VaultUploads.Status.NameTaken } }
            uploads.resolve(second, VaultUploads.Choice.Replace)
            uploads.tasks.first { it.isEmpty() }
        }
        assertEquals(listOf("notes 2.txt", "x"), placed.map { it.name })
        val version = daemon.requests.single { it.path.endsWith("/versions") }
        assertEquals("/v0/surfaces/vault/s1/files/old/versions", version.path)
        assertEquals("v1", version.headers["If-Match"])
        assertEquals("up2", version.json!!["uploadId"]!!.jsonPrimitive.content)
    }

    @Test
    fun anArtifactBundleIsKnownByItsName() = runBlocking {
        val daemon = VaultDaemon()
        daemon.taken["launch.artifact"] = "folder1"
        daemon.kinds["folder1"] = "folder"
        val placed = ArrayList<VaultItem>()
        withTimeout(10_000) {
            val uploads = VaultUploads(VaultClient(AgentClient(daemon, "t")), this, { placed += it }, retryMs = 0)
            uploads.add("s1", null, Bytes("launch.artifact", bytes(64)))
            uploads.add("s1", null, Bytes("site.zip", bytes(64)))
            uploads.tasks.first { it.isEmpty() }
        }
        // A folder has the name: an artifact doesn't replace a folder, so it is numbered without asking.
        assertEquals(listOf("launch 2.artifact", "site.zip"), placed.map { it.name })
        assertEquals(listOf(true, false), placed.map { it.isArtifact })
        val creates = daemon.requests.filter { it.method == "POST" && it.path == "/v0/surfaces/vault/s1/files" }
        // The name says what it is: a creation carries no kind.
        assertEquals(listOf("launch.artifact", "launch 2.artifact", "site.zip"), creates.map { it.json!!["name"]!!.jsonPrimitive.content })
        assertTrue(creates.none { it.json!!.containsKey("kind") })
    }

    @Test
    fun aRefusedArtifactSaysWhyInTheDaemonsWords() = runBlocking {
        val daemon = VaultDaemon()
        daemon.refuseArtifacts = true
        withTimeout(10_000) {
            val uploads = VaultUploads(VaultClient(AgentClient(daemon, "t")), this, {}, retryMs = 0)
            val id = uploads.add("s1", null, Bytes("notes.artifact", bytes(10)))
            val failed = uploads.tasks.first { tasks -> tasks.any { it.status == VaultUploads.Status.Failed } }.single()
            assertEquals(com.slopus.happy.conversation.Problem.Said("The .artifact file has no artifact.json at its root."), failed.problem)
            uploads.cancel(id)
        }
    }

    @Test
    fun anArtifactsNewVersionIsItsWholeBundle() = runBlocking {
        val daemon = VaultDaemon()
        withTimeout(10_000) {
            val uploads = VaultUploads(VaultClient(AgentClient(daemon, "t")), this, {}, retryMs = 0)
            uploads.replace(vaultItem("site1", "v5", "launch.artifact", kind = VaultItem.ARTIFACT), Bytes("launch (1).artifact", bytes(20)))
            uploads.tasks.first { it.isEmpty() }
        }
        val version = daemon.requests.single { it.path.endsWith("/versions") }
        assertEquals("/v0/surfaces/vault/s1/files/site1/versions", version.path)
        assertEquals("v5", version.headers["If-Match"])
    }

    @Test
    fun artifactsAreKnownByTheirSuffixInAnyCase() {
        assertTrue(VaultUploads.isArtifact("Launch.ARTIFACT"))
        assertEquals(false, VaultUploads.isArtifact("site.zip"))
        assertEquals(false, VaultUploads.isArtifact(".artifact"))
        assertEquals("launch 2.artifact", VaultUploads.numbered("launch.artifact", 2))
    }

    @Test
    fun copiesAreNumberedBeforeTheExtension() {
        assertEquals("report 2.pdf", VaultUploads.numbered("report.pdf", 2))
        assertEquals("archive.tar 3.gz", VaultUploads.numbered("archive.tar.gz", 3))
        assertEquals("Makefile 2", VaultUploads.numbered("Makefile", 2))
        assertEquals(".env 2", VaultUploads.numbered(".env", 2))
    }
}

class VaultClientTest {
    @Test
    fun mutationsCarryTheEntryVersionAndARetryId() = runBlocking {
        val daemon = VaultDaemon()
        daemon.reply = { 200 to """{"file":{"id":"e1","surfaceId":"s1","parentId":"f2","name":"b","kind":"file","version":"v3"}}""" }
        val routes = VaultClient(AgentClient(daemon, "t"))
        val entry = vaultItem("e1", "v2", "a", parentId = "f1")
        routes.update(entry, name = "b")
        routes.update(entry, move = true, parentId = null)
        routes.delete(entry)
        routes.restore(entry)
        routes.newVersion(entry, fromVersion = 4)
        assertEquals(
            listOf("PATCH /v0/surfaces/vault/s1/files/e1", "PATCH /v0/surfaces/vault/s1/files/e1", "POST /v0/surfaces/vault/s1/files/e1/delete", "POST /v0/surfaces/vault/s1/files/e1/restore", "POST /v0/surfaces/vault/s1/files/e1/versions"),
            daemon.requests.map { "${it.method} ${it.path}" },
        )
        assertTrue(daemon.requests.all { it.headers["If-Match"] == "v2" && it.json!!.containsKey("mutationId") })
        assertEquals(setOf("name", "mutationId"), daemon.requests[0].json!!.keys)
        assertEquals("null", daemon.requests[1].json!!["parentId"].toString())
        assertEquals("4", daemon.requests[4].json!!["fromVersion"].toString())
        // A folder's own routes, and a new folder carries no kind.
        daemon.requests.clear()
        daemon.reply = { 200 to """{"folder":{"id":"f1","surfaceId":"s1","parentId":null,"name":"Q3","kind":"folder","version":"v2"}}""" }
        val folder = routes.createFolder("s1", null, "Q3", id = "f1")
        routes.delete(folder)
        assertEquals(listOf("POST /v0/surfaces/vault/s1/folders", "POST /v0/surfaces/vault/s1/folders/f1/delete"), daemon.requests.map { "${it.method} ${it.path}" })
        assertEquals(setOf("parentId", "name", "id", "mutationId"), daemon.requests[0].json!!.keys)
        assertTrue(folder.isFolder)
    }

    @Test
    fun listsAndReadsUseTheirRoutes() = runBlocking {
        val daemon = VaultDaemon()
        daemon.reply = { request ->
            200 to when {
                "/items?" in request.path -> """{"items":[{"id":"e1","surfaceId":"s1","name":"a","kind":"folder","version":"v1"}],"nextPageCursor":"c 2"}"""
                request.path.endsWith("/files/e1") -> """{"file":{"id":"e1","surfaceId":"s1","name":"a.txt","kind":"file","version":"v1"},"path":"/R/a.txt","ancestors":[{"id":"f1","name":"R"}],"inTrash":true}"""
                "/search" in request.path -> """{"results":[{"item":{"id":"e1","surfaceId":"s1","name":"a","kind":"file","version":"v1"},"path":"/a","match":"content","snippet":"…a…","line":3}],"truncated":true}"""
                else -> "{}"
            }
        }
        val routes = VaultClient(AgentClient(daemon, "t"))
        val page = routes.children("s1", "f 1", page = "c 1", sort = VaultSortField.Updated)
        assertEquals("c 2", page.next)
        assertEquals(true, page.items.single().isFolder)
        val (results, truncated) = routes.search("s1", "a b")
        assertTrue(truncated)
        assertEquals(3, results.single().line)
        assertEquals("/v0/surfaces/vault/s1/files/e1/versions/latest/content", routes.contentPath("s1", "e1", null))
        assertEquals("/v0/surfaces/vault/s1/files/e1/versions/2/artifact/a%20b/c.js", routes.artifactFilePath("s1", "e1", 2, "a b/c.js"))
        val location = routes.location("s1", "e1", folder = false)
        assertEquals("a.txt", location.item.name)
        assertEquals(listOf("f1"), location.ancestors.map { it.id })
        assertTrue(location.inTrash)
        daemon.requests.removeAt(daemon.requests.lastIndex)
        assertEquals(
            listOf("/v0/surfaces/vault/s1/items?parentId=f%201&sort=updatedAt&limit=500&pageCursor=c%201", "/v0/surfaces/vault/s1/search?q=a%20b&kind=all&limit=50"),
            daemon.requests.map { it.path },
        )
    }
}
