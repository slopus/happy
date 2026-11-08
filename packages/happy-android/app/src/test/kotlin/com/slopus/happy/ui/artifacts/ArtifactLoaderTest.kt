package com.slopus.happy.ui.artifacts

import android.graphics.Bitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.browser.BrowserPolicy
import com.slopus.happy.browser.BrowserProxy
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
                    if (route.isEmpty()) return json("""{"artifact":{"id":"a1","title":"Card","latestVersion":${versions.keys.max()}}}""")
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
        assertTrue(asked.first().endsWith("/versions/1"))
        // An older version on screen: the History banner learns the latest from its catalog entry.
        assertEquals(1, pinned.shown.value?.number)
        assertEquals(3, runBlocking { withTimeout(5_000) { pinned.latest.first { it != null } } })
        asked.clear()
        // A card from the call that made version 1 follows it to the latest.
        val created = load(files(versions), ArtifactRef("a1", 1, "", "Card", followsLatest = false))
        assertEquals(ArtifactUi.Openable(ArtifactFile("b.pdf", "application/pdf", 10)), settled(created))
        assertTrue(asked.single().endsWith("/versions/latest"))
        assertEquals("following the latest, the version read is it", 3, created.latest.value)
    }

    /** happy-agent API.md, "Live URLs": the version's URL through the artifact's own proxy, with no workspace looked up. */
    @Test fun aLiveVersionOpensItsOwnUrlThroughTheArtifactsProxy() {
        fun live(number: Int, url: String) =
            """{"artifactId":"a1","number":$number,"title":"Preview $number","live":{"url":"$url","networkId":"c-agent1"},"entry":{"path":"index.html"},"files":[{"path":"index.html","mimeType":"text/html","size":1}]}"""
        val versions = mapOf(1 to live(1, "http://localhost:4100/"), 3 to live(3, "https://preview.example.com/"))
        val agentAsked = Collections.synchronizedList(ArrayList<String>())
        val agent = AgentClient(
            object : Transport {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                    agentAsked += path
                    return json("""{"error":"no"}""", 404)
                }

                override suspend fun close() {}
            },
            "t",
        )
        fun page(ref: ArtifactRef): com.slopus.happy.ui.browser.BrowserPage {
            val ui = settled(ArtifactLoader(files(versions), agent, scope, ref, sizeWait = 2_000).also(ArtifactLoader::load)) as ArtifactUi.Page
            return runBlocking { ui.prepare() }
        }
        val pinned = page(ArtifactRef("a1", 1, "", "Preview", followsLatest = false, pinned = true))
        assertEquals("http://localhost:4100/", pinned.url)
        assertEquals("a1", pinned.artifactId)
        val through = pinned.scope as BrowserProxy.Scope.Live
        assertEquals("/v0/artifacts/a1/proxy", through.network.path)
        assertEquals(BrowserPolicy.Authority.of("http://localhost:4100/"), through.authority)
        // Following the latest, an https URL opens too: its TLS stays end to end in the tunnel.
        assertEquals("https://preview.example.com/", page(ArtifactRef("a1", 3, "", "Preview", followsLatest = true)).url)
        assertEquals(emptyList<String>(), agentAsked)
        // The artifact itself is read only for the History banner's latest; no workspace or agent is asked for a network.
        assertTrue(asked.none { it.startsWith("/v0/workspaces") || it.startsWith("/v0/agents") })
    }

    @Test fun aFreshMarkdownVersionCarriesTheOneBeforeToDiff() {
        val now = 1_793_700_000_000L
        fun md(number: Int, entry: String, createdAt: Long) =
            """{"artifactId":"a1","number":$number,"major":1,"minor":${number - 1},"title":"Plan","createdAt":$createdAt,"entry":{"path":"$entry"},"files":[{"path":"$entry","mimeType":"text/markdown","size":10}]}"""
        val bodies = mapOf("draft.md" to "# Plan\n\nOld words.".toByteArray(), "index.md" to "# Plan\n\nNew words.".toByteArray())
        fun loader(createdAt: Long) = ArtifactLoader(
            files(mapOf(1 to md(1, "draft.md", now - 3_600_000), 2 to md(2, "index.md", createdAt)), bodies), null, scope,
            ArtifactRef("a1", 2, "", "Plan", followsLatest = true), sizeWait = 2_000, now = { now },
        ).also(ArtifactLoader::load)
        val fresh = settled(loader(now - 60_000)) as ArtifactUi.Document
        assertEquals("# Plan\n\nOld words.", fresh.previous)
        assertEquals("1.0", fresh.previousLabel)
        assertEquals("# Plan\n\nNew words.", fresh.text)
        // Older than 20 minutes: just the document.
        val stale = settled(loader(now - ArtifactLoader.FRESH_DIFF_MILLIS - 1)) as ArtifactUi.Document
        assertEquals(null, stale.previous)
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

    // happy-agent's docs/DESIGN.md §1.8: the entry's head says whether it runs as an app, read before any WebView is made.
    @Test fun aPageThatDeclaresAppModeRunsAsAnApp() {
        val versions = mapOf(1 to version(1, "index.html", "index.html" to "text/html"))
        val game = """<!doctype html><html><head><meta name="viewport" content="width=device-width"><meta name="happy-page-mode" content="app"></head><body><canvas></canvas></body></html>"""
        val app = settled(load(files(versions, mapOf("index.html" to game.toByteArray())))) as ArtifactUi.Page
        assertEquals(com.slopus.happy.artifacts.AppClose.TopStart, app.app)
        assertTrue(asked.last().endsWith("/versions/1/files/index.html"))
        val page = settled(load(files(versions, mapOf("index.html" to "<html><head><title>Report</title></head></html>".toByteArray())))) as ArtifactUi.Page
        assertEquals(null, page.app)
        // An entry that can't be read is a page; the page itself says why.
        assertEquals(null, (settled(load(files(versions))) as ArtifactUi.Page).app)
    }

    @Test fun aDeletedArtifactSaysSo() {
        assertEquals(ArtifactUi.Message(deleted = true), settled(load(files(emptyMap(), status = 404))))
        assertEquals(ArtifactUi.Message(deleted = false), settled(load(files(emptyMap(), status = 500))))
    }
}
