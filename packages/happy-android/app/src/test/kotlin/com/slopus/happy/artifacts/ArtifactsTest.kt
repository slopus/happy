package com.slopus.happy.artifacts

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What an artifact is read as, and how its files are fetched: iOS's `Artifact`, `ArtifactViewController.load` and `AgentClient` artifact routes. */
class ArtifactsTest {
    private fun obj(text: String) = Json.parseToJsonElement(text).jsonObject

    private fun version(files: String, entry: String, live: String = "null") =
        ArtifactVersion.parse(obj("""{"artifactId":"a1","number":3,"title":"Report","live":$live,"entry":$entry,"files":[$files]}"""))!!

    /** Answers by path; records each request with its Range header. */
    private class Routes(val answer: (path: String, range: String?) -> TransportResponse) : Transport {
        val asked = mutableListOf<Pair<String, String?>>()
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            asked += path to headers["Range"]
            return answer(path, headers["Range"])
        }

        override suspend fun close() {}
    }

    private fun json(status: Int, text: String) = TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())

    @Test fun aCardFromTheCallThatCreatedItFollowsTheLatest() {
        assertTrue(ArtifactRef("a", 1, "html", "", followsLatest = false).opensLatest)
        assertFalse(ArtifactRef("a", 1, "html", "", followsLatest = false, pinned = true).opensLatest)
        assertFalse(ArtifactRef("a", 2, "html", "", followsLatest = false).opensLatest)
        assertTrue(ArtifactRef("a", 2, "html", "", followsLatest = true).opensLatest)
        assertTrue(ArtifactRef.presented("a", 4, "html", "T", "latest").followsLatest)
        assertEquals(ArtifactRef("a", 1, "unknown", "", followsLatest = false), ArtifactRef.presented("a", null, null, null, null))
    }

    @Test fun aVersionsEntryIsTypedOrLookedUpInItsManifest() {
        val typed = version("""{"path":"index.md","mimeType":"text/markdown","size":12}""", """{"path":"index.md","mimeType":"text/markdown","size":12}""")
        assertEquals(ArtifactFile("index.md", "text/markdown", 12), typed.entry)
        assertEquals("Report", typed.title)
        assertEquals(3, typed.number)
        val bare = version("""{"path":"a.png","mimeType":"image/png","size":5}""", """{"path":"a.png"}""")
        assertEquals(ArtifactFile("a.png", "image/png", 5), bare.entry)
        // An entry that names nothing in the manifest opens nothing.
        assertNull(version("""{"path":"a.png","mimeType":"image/png","size":5}""", """{"path":"b.png"}""").entry)
        assertNull(ArtifactVersion.parse(obj("""{"title":"no number"}""")))
    }

    @Test fun whatAVersionShowsFollowsItsFile() {
        val live = version("""{"path":"index.html","mimeType":"text/html","size":1}""", """{"path":"index.html"}""", """{"url":"http://localhost:5173/"}""")
        assertEquals(ArtifactShow.Live("http://localhost:5173/"), ArtifactShow.of(live))
        // A file a link opened is that file, not the live page.
        assertEquals(ArtifactShow.Page(live.files[0]), ArtifactShow.of(live, "index.html"))

        val doc = version("""{"path":"README.md","mimeType":"text/plain","size":1},{"path":"img/a.png","mimeType":"image/png","size":1}""", """{"path":"README.md"}""")
        assertEquals(ArtifactShow.Document(doc.files[0]), ArtifactShow.of(doc))
        assertEquals(ArtifactShow.Gallery(listOf(doc.files[1])), ArtifactShow.of(doc, "img/a.png"))
        assertEquals(ArtifactShow.Unavailable, ArtifactShow.of(doc, "missing.md"))

        val series = version(
            """{"path":"1.png","mimeType":"image/png","size":1},{"path":"notes.txt","mimeType":"text/plain","size":1},{"path":"2.mp4","mimeType":"video/mp4","size":1}""",
            """{"path":"1.png"}""",
        )
        // An image series is every picture and recording of the version, in the manifest's order.
        assertEquals(ArtifactShow.Gallery(listOf(series.files[0], series.files[2])), ArtifactShow.of(series))

        val pdf = version("""{"path":"paper.pdf","mimeType":"application/pdf","size":1}""", """{"path":"paper.pdf"}""")
        assertEquals(ArtifactShow.Openable(pdf.files[0]), ArtifactShow.of(pdf))
        val svg = version("""{"path":"logo.svg","mimeType":"image/svg+xml","size":1}""", """{"path":"logo.svg"}""")
        assertEquals(ArtifactShow.Gallery(svg.files), ArtifactShow.of(svg))
        assertEquals(ArtifactShow.Unavailable, ArtifactShow.of(version("", "null")))
    }

    @Test fun aFileIsAWebPageOnlyWhenTheWebViewDrawsIt() {
        assertTrue(ArtifactFile("index.html", "text/html; charset=utf-8", 1).isWebPage)
        assertTrue(ArtifactFile("data.json", "application/octet-stream", 1).isWebPage)
        assertFalse(ArtifactFile("paper.pdf", "application/pdf", 1).isWebPage)
        assertTrue(ArtifactFile("notes.markdown", "application/octet-stream", 1).isMarkdown)
        assertTrue(ArtifactFile("clip.webm", "video/webm", 1).isVisual)
    }

    @Test fun theCatalogReadsRowsAndItsCursor() {
        val page = ArtifactListing.parse(obj("""{"artifacts":[{"id":"a1","title":"One","type":"html","latestVersion":4},{"id":"a2"},{"title":"no id"}],"nextPageCursor":"p2"}"""))
        assertEquals(listOf(ArtifactRef("a1", 4, "html", "One", true), ArtifactRef("a2", 1, "", "", true)), page.items)
        assertEquals("p2", page.next)
        assertNull(ArtifactListing.parse(obj("""{"artifacts":[]}""")).next)
    }

    @Test fun aWholeFileIsReadInRanges() = runBlocking {
        val bytes = ByteArray(ArtifactClient.RANGE_CHUNK * 2 + 10) { it.toByte() }
        val routes = Routes { _, range ->
            val (from, to) = range!!.removePrefix("bytes=").split('-').map(String::toInt)
            val end = minOf(to, bytes.size - 1)
            TransportResponse(206, mapOf("content-range" to "bytes $from-$end/${bytes.size}"), bytes.copyOfRange(from, end + 1))
        }
        val read = ArtifactClient(AgentClient(routes, "t")).bytes("a1", 2, "images/plot #1.png")
        assertArrayEquals(bytes, read)
        assertEquals(3, routes.asked.size)
        // Each segment is escaped on its own; the separators stay.
        assertEquals("/v0/artifacts/a1/versions/2/files/images/plot%20%231.png", routes.asked[0].first)
        assertEquals("bytes=0-${ArtifactClient.RANGE_CHUNK - 1}", routes.asked[0].second)
    }

    @Test fun aServerThatIgnoresRangesAndAnEmptyFile() = runBlocking {
        val whole = ArtifactClient(AgentClient(Routes { _, _ -> TransportResponse(200, body = byteArrayOf(1, 2, 3)) }, "t"))
        assertArrayEquals(byteArrayOf(1, 2, 3), whole.bytes("a1", 1, "a.bin"))
        val empty = Routes { _, range -> if (range != null) json(416, """{"error":"range"}""") else TransportResponse(200, body = ByteArray(0)) }
        assertArrayEquals(ByteArray(0), ArtifactClient(AgentClient(empty, "t")).bytes("a1", 1, "empty.txt"))
        assertEquals(listOf<String?>("bytes=0-${ArtifactClient.RANGE_CHUNK - 1}", null), empty.asked.map { it.second })
    }

    @Test fun aDeletedArtifactIsGone() = runBlocking {
        val missing = ArtifactClient(AgentClient(Routes { _, _ -> json(404, """{"error":"not found"}""") }, "t"))
        assertTrue(runCatching { missing.version("a1", null) }.exceptionOrNull() is ArtifactGoneException)
        // Refused another way, but its entry is a tombstone.
        val tombstone = ArtifactClient(
            AgentClient(
                Routes { path, _ ->
                    if (path == "/v0/artifacts/a1") json(200, """{"artifact":{"id":"a1","status":"deleted"}}""") else json(409, """{"error":"deleted"}""")
                },
                "t",
            ),
        )
        assertTrue(runCatching { tombstone.version("a1", 2) }.exceptionOrNull() is ArtifactGoneException)
        assertTrue(ArtifactClient.isDeleted(obj("""{"deletedAt":1700000000}""")))
        assertFalse(ArtifactClient.isDeleted(obj("""{"status":"active","deletedAt":null}""")))
    }

    @Test fun theLatestOrANumberedVersion() = runBlocking {
        val routes = Routes { _, _ -> json(200, """{"version":{"number":5,"title":"T","entry":{"path":"a.md"},"files":[{"path":"a.md","mimeType":"text/markdown","size":1}]}}""") }
        val client = ArtifactClient(AgentClient(routes, "t"))
        assertEquals(5, client.version("a1", null).number)
        client.version("a1", 2)
        assertEquals(listOf("/v0/artifacts/a1/versions/latest", "/v0/artifacts/a1/versions/2"), routes.asked.map { it.first })
    }
}
