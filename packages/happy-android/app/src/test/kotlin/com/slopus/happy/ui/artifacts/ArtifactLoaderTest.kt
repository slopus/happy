package com.slopus.happy.ui.artifacts

import android.graphics.Bitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactFile
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.artifacts.Extent
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.media.DownloadPhase
import com.slopus.happy.media.MediaLibrary
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.util.Collections

/**
 * The artifact screen's reads, as iOS's `ArtifactViewController.load`
 * makes them: which version, what it shows as, where a link leads; and the
 * artifacts list's, as `ArtifactsViewController`'s.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ArtifactLoaderTest {
    @get:Rule val folder = TemporaryFolder()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val asked: MutableList<String> = Collections.synchronizedList(ArrayList())

    @After fun tearDown() = scope.cancel()

    private val png: ByteArray by lazy {
        val bitmap = Bitmap.createBitmap(120, 80, Bitmap.Config.ARGB_8888)
        ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    private fun json(text: String, status: Int = 200) = TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())

    /** An agent that has [versions] by number (and its latest as the highest) and [bodies] by path. */
    private fun files(versions: Map<Int, String>, bodies: Map<String, ByteArray> = emptyMap(), status: Int? = null) = ArtifactClient(
        AgentClient(
            object : Transport {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                    asked += path
                    status?.let { return json("""{"error":"no"}""", it) }
                    val route = path.removePrefix("/v0/artifacts/a1")
                    if (route.startsWith("/versions/") && "/files/" !in route) {
                        val number = route.removePrefix("/versions/").let { if (it == "latest") versions.keys.max() else it.toInt() }
                        return versions[number]?.let { json("""{"version":$it}""") } ?: json("""{"error":"gone"}""", 404)
                    }
                    val file = route.substringAfter("/files/")
                    return bodies[file]?.let { TransportResponse(200, body = it) } ?: json("""{"error":"missing"}""", 404)
                }

                override suspend fun close() {}
            },
            "t",
        ),
    )

    private fun version(number: Int, entry: String, vararg files: Pair<String, String>) =
        """{"artifactId":"a1","number":$number,"title":"Version $number","entry":{"path":"$entry"},"files":[${files.joinToString(",") { (path, type) -> """{"path":"$path","mimeType":"$type","size":${if (type.startsWith("image")) png.size else 10}}""" }}]}"""

    private fun load(files: ArtifactClient, ref: ArtifactRef = ArtifactRef("a1", 1, "", "Card", followsLatest = true), opened: Pair<Int, String>? = null): ArtifactLoader =
        ArtifactLoader(files, null, scope, ref, opened, sizeWait = 2_000).also(ArtifactLoader::load)

    private fun settled(loader: ArtifactLoader): ArtifactUi = runBlocking { withTimeout(10_000) { loader.state.first { it != ArtifactUi.Loading } } }

    @Test fun aDocumentShowsWithItsPicturesSized() {
        val doc = "# Notes\n\nSee ![chart](img/chart.png) and ![again](./img/chart.png) and ![gone](nope.png)."
        val loader = load(
            files(
                mapOf(2 to version(2, "README.md", "README.md" to "text/markdown", "img/chart.png" to "image/png", "other.md" to "text/markdown", "paper.pdf" to "application/pdf")),
                mapOf("README.md" to doc.toByteArray(), "img/chart.png" to png),
            ),
        )
        val ui = settled(loader) as ArtifactUi.Document
        assertEquals("README.md", ui.path)
        assertEquals("Version 2", loader.title.value)
        // Two spellings of one file are one picture; a file the version lacks is none.
        assertEquals(1, ui.order.size)
        assertEquals(Extent(120.0, 80.0), loader.media!!.sizes[ui.order[0].key])
        assertTrue(asked.first().endsWith("/versions/latest"))

        // Where links lead, against the document's own folder.
        assertTrue(loader.link("img/chart.png", "README.md") is ArtifactLink.View)
        assertEquals(ArtifactLink.File(2, "other.md"), loader.link("other.md#part", "README.md"))
        assertEquals(ArtifactLink.File(2, "paper.pdf"), loader.link("paper.pdf", "README.md"))
        assertEquals(ArtifactLink.Missing, loader.link("missing.md", "README.md"))
        assertEquals(ArtifactLink.Web("https://example.com/x"), loader.link("https://example.com/x", "README.md"))
        assertEquals(ArtifactLink.External("mailto:a@example.com"), loader.link("mailto:a@example.com", "README.md"))
        assertEquals(ArtifactLink.Nothing, loader.link("#top", "README.md"))
        assertEquals(ArtifactLink.Nothing, loader.link("../escape.md", "README.md"))
    }

    @Test fun anImageSeriesIsAllItsPictures() {
        val loader = load(
            files(
                mapOf(1 to version(1, "1.png", "1.png" to "image/png", "2.png" to "image/png", "notes.txt" to "text/plain")),
                mapOf("1.png" to png, "2.png" to png),
            ),
        )
        val ui = settled(loader) as ArtifactUi.Gallery
        assertEquals(listOf("artifact/a1/1/1.png", "artifact/a1/1/2.png"), ui.items.map { it.key })
        assertFalse(ui.items.any { it.isVideo })
    }

    // iOS ba7b68346: a numbered version's files are read into the connection's library once and kept.
    @Test fun aGallerysPicturesAreKeptAndReadFromThePhoneNextTime() {
        val library = MediaLibrary(folder.newFolder("media"))
        val versions = mapOf(1 to version(1, "1.png", "1.png" to "image/png"))
        val first = ArtifactLoader(files(versions, mapOf("1.png" to png)), null, scope, ArtifactRef("a1", 1, "", "Card", followsLatest = true), sizeWait = 2_000, library = library)
            .also(ArtifactLoader::load)
        val ui = settled(first) as ArtifactUi.Gallery
        val media = first.media!!
        val key = ui.items.single().key
        assertTrue(runBlocking { media.data(key) }!!.contentEquals(png))
        assertTrue(library.store.isComplete("artifact/a1/1/1.png"))
        // The board hears the finish on the downloads' own lane, after the bytes are read: its terminal phase, not one on the way.
        val phase = runBlocking {
            withTimeout(5_000) {
                while (media.phase(key) !is DownloadPhase.Complete) kotlinx.coroutines.delay(10)
                media.phase(key)
            }
        }
        assertEquals(DownloadPhase.Complete(png.size.toLong()), phase)

        // The computer no longer has the file: the phone does.
        val again = ArtifactLoader(files(versions), null, scope, ArtifactRef("a1", 1, "", "Card", followsLatest = true), sizeWait = 2_000, library = library)
            .also(ArtifactLoader::load)
        settled(again)
        asked.clear()
        assertTrue(runBlocking { again.media!!.data(key) }!!.contentEquals(png))
        assertTrue(asked.none { "/files/" in it })
    }

    @Test fun aPinnedVersionOpensThatVersion() {
        val versions = mapOf(1 to version(1, "a.pdf", "a.pdf" to "application/pdf"), 3 to version(3, "b.pdf", "b.pdf" to "application/pdf"))
        val pinned = load(files(versions), ArtifactRef("a1", 1, "", "Card", followsLatest = false, pinned = true))
        assertEquals(ArtifactUi.Openable(ArtifactFile("a.pdf", "application/pdf", 10)), settled(pinned))
        assertTrue(asked.single().endsWith("/versions/1"))
        asked.clear()
        // A card from the call that made version 1 follows it to the latest.
        val created = load(files(versions), ArtifactRef("a1", 1, "", "Card", followsLatest = false))
        assertEquals(ArtifactUi.Openable(ArtifactFile("b.pdf", "application/pdf", 10)), settled(created))
        assertTrue(asked.single().endsWith("/versions/latest"))
    }

    @Test fun aLinkedFileOpensInItsVersionUnderItsName() {
        val loader = load(
            files(mapOf(2 to version(2, "index.md", "index.md" to "text/markdown", "docs/guide.md" to "text/markdown")), mapOf("docs/guide.md" to "Guide".toByteArray())),
            opened = 2 to "docs/guide.md",
        )
        assertEquals("guide.md", loader.title.value)
        val ui = settled(loader) as ArtifactUi.Document
        assertEquals("docs/guide.md", ui.path)
        // The bar keeps the file's name, not the version's title.
        assertEquals("guide.md", loader.title.value)
    }

    @Test fun webFilesArePagesAndAMissingEntryIsUnavailable() {
        assertTrue(settled(load(files(mapOf(1 to version(1, "index.html", "index.html" to "text/html"))))) is ArtifactUi.Page)
        assertEquals(ArtifactUi.Message(deleted = false), settled(load(files(mapOf(1 to version(1, "index.html"))))))
    }

    @Test fun aDeletedArtifactSaysSo() {
        assertEquals(ArtifactUi.Message(deleted = true), settled(load(files(emptyMap(), status = 404))))
        assertEquals(ArtifactUi.Message(deleted = false), settled(load(files(emptyMap(), status = 500))))
    }

    @Test fun theCatalogShowsWhatWasKeptThenPagesAndDedupes() {
        var kept: JsonObject? = buildJsonObject { put("artifacts", kotlinx.serialization.json.JsonArray(listOf(buildJsonObject { put("id", "old"); put("title", "Kept") }))) }
        val pages = mapOf(
            null to """{"artifacts":[{"id":"a1","title":"One"},{"id":"a2","title":"Two"}],"nextPageCursor":"p2"}""",
            "p2" to """{"artifacts":[{"id":"a2","title":"Two"},{"id":"a3"}],"nextPageCursor":null}""",
        )
        val catalog = object : ArtifactClient(AgentClient(object : Transport {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory) = error("unused")
            override suspend fun close() {}
        }, "t")) {
            override suspend fun catalog(pageCursor: String?): JsonObject {
                asked += "catalog ${pageCursor ?: "first"}"
                if (pageCursor == null) kotlinx.coroutines.delay(300)
                return kotlinx.serialization.json.Json.parseToJsonElement(pages.getValue(pageCursor)) as JsonObject
            }
        }
        val reader = ArtifactCatalogReader(catalog, scope, cached = { kept }, keep = { kept = it })
        reader.start()
        runBlocking {
            // The kept page shows first, while the fresh read is under way.
            assertEquals(listOf("old"), withTimeout(5_000) { reader.state.first { it.items.isNotEmpty() } }.items.map { it.id })
            assertEquals(listOf("a1", "a2"), withTimeout(5_000) { reader.state.first { it.next == "p2" } }.items.map { it.id })
            reader.read(append = true)
            val all = withTimeout(5_000) { reader.state.first { it.next == null && it.items.size == 3 } }
            assertEquals(listOf("a1", "a2", "a3"), all.items.map { it.id })
            assertEquals("", all.items[2].title)
        }
        // Only the first page is kept offline.
        assertEquals("a1", kept!!["artifacts"].toString().substringAfter("\"id\":\"").substringBefore('"'))
        // At the end, asking for more asks nothing.
        reader.read(append = true)
        Thread.sleep(100)
        assertEquals(listOf("catalog first", "catalog p2"), asked.toList())
    }

    @Test fun aCatalogThatCantBeReadSaysSoOnlyWithNothingShown() {
        var fail = true
        val catalog = object : ArtifactClient(AgentClient(object : Transport {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory) = error("unused")
            override suspend fun close() {}
        }, "t")) {
            override suspend fun catalog(pageCursor: String?): JsonObject {
                if (fail) throw java.io.IOException("offline")
                return kotlinx.serialization.json.Json.parseToJsonElement("""{"artifacts":[{"id":"a1"}]}""") as JsonObject
            }
        }
        val reader = ArtifactCatalogReader(catalog, scope)
        reader.start()
        runBlocking { withTimeout(5_000) { reader.state.first { it.failed } } }
        fail = false
        reader.retry()
        val shown = runBlocking { withTimeout(5_000) { reader.state.first { it.items.isNotEmpty() } } }
        assertFalse(shown.failed)
        fail = true
        reader.read()
        Thread.sleep(100)
        assertEquals(listOf("a1"), reader.state.value.items.map { it.id })
        assertFalse(reader.state.value.failed)
    }
}
