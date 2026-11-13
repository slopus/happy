package com.slopus.happy.ui.genui

import android.graphics.Bitmap
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import coil3.ImageLoader
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.artifacts.Extent
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.artifacts.ArtifactActions
import com.slopus.happy.ui.artifacts.ArtifactLoader
import com.slopus.happy.ui.artifacts.ArtifactScreen
import com.slopus.happy.ui.artifacts.ArtifactUi
import com.slopus.happy.ui.components.LocalImageLoader
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.Collections

/**
 * A `gen_ui` artifact on the artifact screen: drawn from its version's
 * `.genui/render.json` (never its entry), with the version's own pictures,
 * and only the actions this screen can run enabled.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GenUiArtifactTest {
    @get:Rule val rule = createComposeRule()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val asked: MutableList<String> = Collections.synchronizedList(ArrayList())

    @After fun tearDown() = scope.cancel()

    private fun fixture(name: String) = File("src/debug/assets/genui/fixtures/$name.json").readBytes()
    private fun asset(path: String) = File("src/debug/assets/genui/$path").readBytes()

    private fun version(vararg files: Pair<String, String>) =
        """{"artifactId":"a1","number":3,"title":"Trip","entry":{"path":"index.genui.json"},"files":[${files.joinToString(",") { (path, type) -> """{"path":"$path","mimeType":"$type","size":10}""" }}]}"""

    private fun client(version: String, bodies: Map<String, ByteArray>) = ArtifactClient(
        AgentClient(
            object : Transport {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                    asked += path
                    if ("/files/" !in path) return TransportResponse(200, body = """{"version":$version}""".toByteArray())
                    return bodies[path.substringAfter("/files/")]?.let { TransportResponse(200, body = it) } ?: TransportResponse(404, body = "{}".toByteArray())
                }

                override suspend fun close() {}
            },
            "t",
        ),
    )

    private fun load(version: String, bodies: Map<String, ByteArray>, type: String = "gen_ui"): ArtifactLoader {
        val loader = ArtifactLoader(client(version, bodies), null, scope, ArtifactRef("a1", 3, type, "Trip", followsLatest = true)).also(ArtifactLoader::load)
        runBlocking { withTimeout(10_000) { loader.state.first { it != ArtifactUi.Loading } } }
        return loader
    }

    private val gallery = version(
        "index.genui.json" to "application/json",
        ".genui/render.json" to "application/json",
        "assets/coast.jpg" to "image/jpeg",
        "assets/forest.jpg" to "image/jpeg",
        "assets/dunes.jpg" to "image/jpeg",
        "assets/lake.jpg" to "image/jpeg",
        "assets/city.jpg" to "image/jpeg",
    )
    private val galleryBodies = mapOf(".genui/render.json" to fixture("05-gallery-grid")) +
        listOf("coast", "forest", "dunes", "lake", "city").associate { "assets/$it.jpg" to asset("assets/$it.jpg") }

    @Test fun aGenUiVersionIsItsRenderDocumentWithItsPicturesSized() {
        val loader = load(gallery, galleryBodies)
        val ui = loader.state.value as ArtifactUi.GenUi
        assertTrue(ui.document.drawable)
        assertEquals("card", ui.document.root)
        // The viewer group names seven pictures; the version holds five, and only those are offered.
        assertEquals(setOf("assets/coast.jpg", "assets/forest.jpg", "assets/dunes.jpg", "assets/lake.jpg", "assets/city.jpg"), ui.pictures.keys)
        assertEquals(Extent(1600.0, 1067.0), loader.media!!.sizes[ui.pictures.getValue("assets/coast.jpg").key])
        assertTrue(asked.any { it.endsWith("/versions/latest") })
        assertTrue(asked.any { it.endsWith("/files/.genui/render.json") })
        assertFalse("never the authoring entry", asked.any { "index.genui.json" in it })
    }

    @Test fun theSameFilesOfAnotherTypeAreNotGenUi() {
        val loader = load(gallery, galleryBodies, type = "html")
        assertTrue(loader.state.value is ArtifactUi.Page)
    }

    @Test fun aGenUiVersionWithoutItsRenderDocumentIsUnavailable() {
        val loader = load(version("index.genui.json" to "application/json"), emptyMap())
        assertEquals(ArtifactUi.Message(deleted = false), loader.state.value)
    }

    private fun show(loader: ArtifactLoader, actions: ArtifactActions = ArtifactActions(onBack = {})) {
        val pictures = ImageLoader.Builder(ApplicationProvider.getApplicationContext()).build()
        rule.setHappyContent {
            val state by loader.state.collectAsState()
            CompositionLocalProvider(LocalImageLoader provides pictures) { ArtifactScreen("Trip", state, loader.media, "Studio", actions) }
        }
    }

    private fun shot(name: String) {
        repeat(15) { Thread.sleep(100); rule.waitForIdle() }
        val dir = File("build/genui-artifact").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun theScreenDrawsTheBlock() {
        show(load(gallery, galleryBodies))
        rule.node(GenUiArtifactTags.SCREEN).assertExists()
        rule.node("genui").assertExists()
        shot("gallery")
    }

    @Test fun onlyWhatTheScreenCanRunIsEnabled() {
        val render = """{"genuiRender":1,"root":"card","fallback":"Links","elements":{
            "card":{"type":"box","props":{"role":"card","gap":"blocks"},"children":["web","plain","ask","run"]},
            "web":{"type":"button","props":{"label":"Docs","action":{"type":"open","url":"https://example.com/docs"}}},
            "plain":{"type":"button","props":{"label":"Insecure","action":{"type":"open","url":"http://example.com"}}},
            "ask":{"type":"button","props":{"label":"Ask","action":{"type":"message","text":"Tell me more"}}},
            "run":{"type":"button","props":{"label":"Add key","action":{"type":"teleport"}}}}}"""
        val opened = ArrayList<String>()
        val loader = load(version(".genui/render.json" to "application/json"), mapOf(".genui/render.json" to render.toByteArray()))
        show(loader, ArtifactActions(onBack = {}, onOpenWeb = { opened += it }))
        rule.onNodeWithText("Docs").assertIsEnabled().performClick()
        assertEquals(listOf("https://example.com/docs"), opened)
        // No conversation here to send to; an http address and an action this build doesn't know stay visible, disabled.
        rule.onNodeWithText("Insecure").assertIsNotEnabled()
        rule.onNodeWithText("Ask").assertIsNotEnabled()
        rule.onNodeWithText("Add key").assertIsNotEnabled()
    }

    @Test fun anotherRenderFormatShowsItsFallback() {
        val render = """{"genuiRender":2,"root":"t","fallback":"Revenue was up 18%.","elements":{"t":{"type":"text","props":{"spans":[{"text":"New"}]}}}}"""
        show(load(version(".genui/render.json" to "application/json"), mapOf(".genui/render.json" to render.toByteArray())))
        rule.onNodeWithText("Revenue was up 18%.").assertExists()
    }
}
