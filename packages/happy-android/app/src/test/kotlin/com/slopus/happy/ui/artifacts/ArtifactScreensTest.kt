package com.slopus.happy.ui.artifacts

import com.slopus.happy.connection.RequestCategory
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performFirstLinkClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import coil3.ImageLoader
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactFile
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.Todo
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.components.LocalImageLoader
import com.slopus.happy.ui.connection.AgentPlacesTags
import com.slopus.happy.ui.connection.PlaceRead
import com.slopus.happy.ui.connection.SurfaceBody
import com.slopus.happy.ui.connection.SurfaceScreen
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
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * The artifacts list, each kind of artifact screen and each kind of Surface,
 * with what they do on a tap; each rendered to build/artifact-screens for
 * review against iOS.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ArtifactScreensTest {
    @get:Rule val rule = createComposeRule()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After fun tearDown() = scope.cancel()

    /** Pictures decode off the main thread; a shot of them waits for them to land. */
    private fun settle() = repeat(15) {
        Thread.sleep(100)
        rule.waitForIdle()
    }

    private fun shot(name: String) {
        rule.waitForIdle()
        val dir = File("build/artifact-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** A made-up picture: a coloured field with a darker band, so its shape shows. */
    private fun picture(width: Int, height: Int, color: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        Canvas(bitmap).apply {
            drawColor(color)
            drawRect(0f, height * 0.6f, width.toFloat(), height.toFloat(), Paint().apply { this.color = 0x33000000 })
        }
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    private fun files(version: String, bodies: Map<String, ByteArray>) = ArtifactClient(
        AgentClient(
            object : Transport {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                    if ("/files/" !in path) return TransportResponse(200, body = """{"version":$version}""".toByteArray())
                    return bodies[path.substringAfter("/files/")]?.let { TransportResponse(200, body = it) } ?: TransportResponse(404, body = "{}".toByteArray())
                }

                override suspend fun close() {}
            },
            "t",
        ),
    )

    private fun loaded(version: String, bodies: Map<String, ByteArray>): ArtifactLoader {
        val loader = ArtifactLoader(files(version, bodies), null, scope, ArtifactRef("a1", 1, "", "", followsLatest = true), sizeWait = 5_000).also(ArtifactLoader::load)
        runBlocking { withTimeout(10_000) { loader.state.first { it != ArtifactUi.Loading } } }
        return loader
    }

    private fun showArtifact(loader: ArtifactLoader, dark: Boolean = false, actions: ArtifactActions = ArtifactActions(onBack = {}, link = loader::link)) {
        // A plain loader: the app's shared one (its disk cache and crossfade) never lands a picture under Robolectric.
        val pictures = ImageLoader.Builder(ApplicationProvider.getApplicationContext()).build()
        rule.setHappyContent(dark) {
            CompositionLocalProvider(LocalImageLoader provides pictures) { ArtifactScreen(loader.title.value, loader.state.value, loader.media, "Studio", actions) }
        }
    }

    @Test fun aDocumentWithItsPicture() {
        val doc = "# Release notes\n\nEverything that shipped this week, with the chart from the dashboard.\n\n![Weekly active people](img/chart.png)\n\n" +
            "- Faster sync on cold start\n- [The guide](guide.md) has the details\n\n```kotlin\nval ok = true\n```\n"
        val loader = loaded(
            """{"artifactId":"a1","number":3,"title":"Release notes","entry":{"path":"README.md"},"files":[{"path":"README.md","mimeType":"text/markdown","size":1},{"path":"img/chart.png","mimeType":"image/png","size":1},{"path":"guide.md","mimeType":"text/markdown","size":1}]}""",
            mapOf("README.md" to doc.toByteArray(), "img/chart.png" to picture(1200, 600, 0xFF6FA8DC.toInt())),
        )
        val files = mutableListOf<String>()
        showArtifact(loader, actions = ArtifactActions(onBack = {}, link = loader::link, onOpenFile = { _, path -> files += path }))
        rule.node(ArtifactTags.DOCUMENT).assertExists()
        rule.node(ArtifactTags.PICTURE).assertExists()
        rule.onAllNodesWithText("Release notes").assertCountEquals(2)
        settle()
        shot("artifact-document")
        rule.onNodeWithText("The guide", substring = true).performFirstLinkClick()
        assertEquals(listOf("guide.md"), files)
    }

    @Test fun aDocumentDark() {
        val loader = loaded(
            """{"artifactId":"a1","number":1,"title":"Plan","entry":{"path":"plan.md"},"files":[{"path":"plan.md","mimeType":"text/markdown","size":1}]}""",
            mapOf("plan.md" to "# Plan\n\n1. Ship it\n2. Tell people\n\n> Quietly, then loudly.".toByteArray()),
        )
        showArtifact(loader, dark = true)
        shot("artifact-document-dark")
    }

    @Test fun onePictureLarge() {
        val loader = loaded(
            """{"artifactId":"a1","number":1,"title":"Hero","entry":{"path":"hero.png"},"files":[{"path":"hero.png","mimeType":"image/png","size":1}]}""",
            mapOf("hero.png" to picture(1200, 800, 0xFFE69138.toInt())),
        )
        showArtifact(loader)
        rule.onAllNodesWithTag(ArtifactGalleryTags.TILE, useUnmergedTree = true).assertCountEquals(1)
        rule.onAllNodesWithTag(ArtifactGalleryTags.COUNT, useUnmergedTree = true).assertCountEquals(0)
        settle()
        shot("artifact-image")
    }

    @Test fun anImageSeriesUnderItsCount() {
        val names = listOf("1.png", "2.png", "3.png", "4.png", "5.png")
        val colors = listOf(0xFF6FA8DC, 0xFF93C47D, 0xFFE69138, 0xFF8E7CC3, 0xFFC27BA0).map { it.toInt() }
        val sizes = listOf(1600 to 1200, 1200 to 1600, 1600 to 900, 1000 to 1000, 1600 to 1200)
        val loader = loaded(
            """{"artifactId":"a1","number":1,"title":"Screens","entry":{"path":"1.png"},"files":[${names.joinToString(",") { """{"path":"$it","mimeType":"image/png","size":1}""" }}]}""",
            names.indices.associate { names[it] to picture(sizes[it].first, sizes[it].second, colors[it]) },
        )
        showArtifact(loader)
        rule.onAllNodesWithTag(ArtifactGalleryTags.TILE, useUnmergedTree = true).assertCountEquals(5)
        rule.onNodeWithText("5 images").assertExists()
        settle()
        shot("artifact-image-series")
        rule.onAllNodesWithTag(ArtifactGalleryTags.TILE, useUnmergedTree = true)[1].performClick()
        rule.node(ArtifactViewerTags.VIEWER).assertExists()
        settle()
        shot("artifact-viewer")
    }

    @Test fun aFileTheWebViewCantDrawIsHandedOn() {
        rule.setHappyContent { ArtifactScreen("Paper", ArtifactUi.Openable(ArtifactFile("paper.pdf", "application/pdf", 1)), null, "Studio", ArtifactActions(onBack = {})) }
        rule.node(ArtifactTags.OPEN).assertExists()
        shot("artifact-openable")
    }

    @Test fun deletedAndUnavailableSaySoInPlace() {
        var ui by androidx.compose.runtime.mutableStateOf<ArtifactUi>(ArtifactUi.Message(deleted = true))
        rule.setHappyContent { ArtifactScreen("Report", ui, null, "Studio", ArtifactActions(onBack = {})) }
        rule.onNodeWithText("This artifact was deleted.").assertExists()
        shot("artifact-deleted")
        ui = ArtifactUi.Message(deleted = false)
        rule.waitForIdle()
        assertTrue(rule.onAllNodesWithTag(PlaceTags.MESSAGE, useUnmergedTree = true).fetchSemanticsNodes().size == 1)
        shot("artifact-unavailable")
        ui = ArtifactUi.Loading
        rule.node(PlaceTags.LOADER).assertExists()
    }

    @Test fun aTodoSurfaceTakesANewOne() {
        val added = mutableListOf<String>()
        val todos = listOf(Todo("t1", "Eggs", false), Todo("t2", "Bread from the good bakery on the corner", false), Todo("t3", "Milk", true))
        rule.setHappyContent { SurfaceScreen("Groceries", PlaceRead.Ready(SurfaceBody.Todos(todos)), {}, { added += it }, {}) }
        rule.onAllNodesWithTag(AgentPlacesTags.TODO).assertCountEquals(3)
        shot("surface-todo")
        rule.node(AgentPlacesTags.TODO_FIELD).performTextInput("Butter")
        rule.node(AgentPlacesTags.TODO_FIELD).performImeAction()
        assertEquals(listOf("Butter"), added)
    }

    @Test fun anEmptyTodoSurfaceAndAWaitingOne() {
        var read by androidx.compose.runtime.mutableStateOf<PlaceRead<SurfaceBody>>(PlaceRead.Reading)
        rule.setHappyContent(dark = true) { SurfaceScreen("Groceries", read, {}, {}, {}) }
        rule.node(PlaceTags.LOADER).assertExists()
        read = PlaceRead.Ready(SurfaceBody.Todos(emptyList()))
        rule.onNodeWithText("Nothing here yet.").assertExists()
        shot("surface-todo-empty-dark")
    }

    @Test fun aDocumentSurfaceIsReadOnly() {
        rule.setHappyContent {
            SurfaceScreen("Launch plan", PlaceRead.Ready(SurfaceBody.Document("# Launch plan\n\nWhat ships, and when.\n\n- **Monday**: preview\n- **Thursday**: everyone")), {}, {}, {})
        }
        rule.node(AgentPlacesTags.DOCUMENT).assertExists()
        rule.onAllNodesWithTag(AgentPlacesTags.TODO_FIELD).assertCountEquals(0)
        shot("surface-document")
    }

    @Test fun anEmptyDocumentAndAnotherKind() {
        var body by androidx.compose.runtime.mutableStateOf<SurfaceBody>(SurfaceBody.Document("  \n"))
        rule.setHappyContent { SurfaceScreen("Notes", PlaceRead.Ready(body), {}, {}, {}) }
        rule.onNodeWithText("This document is empty.").assertExists()
        shot("surface-document-empty")
        body = SurfaceBody.Elsewhere
        rule.onNodeWithText("Open this on your computer to use it.").assertExists()
        shot("surface-other")
    }
}
