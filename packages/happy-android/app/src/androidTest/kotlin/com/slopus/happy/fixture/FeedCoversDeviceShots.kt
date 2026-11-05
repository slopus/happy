package com.slopus.happy.fixture

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.IntentOutbox
import com.slopus.happy.agent.MemoryIntentStorage
import com.slopus.happy.agent.WireDesktopBootstrap
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.feed.AgentFeedRoutes
import com.slopus.happy.feed.FeedCovers
import com.slopus.happy.feed.FeedFilter
import com.slopus.happy.feed.FeedLibrary
import com.slopus.happy.feed.FeedLookups
import com.slopus.happy.feed.FeedRows
import com.slopus.happy.ui.feed.FeedActions
import com.slopus.happy.ui.feed.FeedFollowingState
import com.slopus.happy.ui.feed.FeedScreen
import com.slopus.happy.ui.feed.FeedTags
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Collections

/**
 * The Feed with covered artifacts on a device: the real FeedLibrary,
 * FeedLookups, FeedCovers and AgentFeedRoutes over a made-up daemon in this
 * test's memory that has `artifactCovers` and `feedSubjectFilter`. A wide
 * (16:9) and a square (1:1) cover, drawn here, become posts in All and in
 * Highlights; a markdown artifact without one keeps its row; an animated
 * WebP cover (`assets/cover-loop.webp`) moves unless animations are off.
 * The lists read the computer's still previews. Captured to the test app's
 * files under `device-evidence/feed-covers-*.png`. Every entry is synthetic.
 */
@RunWith(AndroidJUnit4::class)
class FeedCoversDeviceShots {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app = InstrumentationRegistry.getInstrumentation().targetContext
    private val evidence = File(app.filesDir, "device-evidence").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val daemon = CoverDaemon(System.currentTimeMillis())

    @After fun tearDown() = scope.cancel()

    @Test fun capture() = show(dark = false)

    @Test fun captureDark() = show(dark = true)

    @Test fun captureList() = list(dark = false)

    @Test fun captureListDark() = list(dark = true)

    /**
     * The animated cover plays: two frames apart, its pixels differ, and
     * once the app is paused they hold still. With animations off
     * (`animator_duration_scale` 0) it is the first frame throughout.
     */
    @Test fun captureMotion() {
        val still = android.provider.Settings.Global.getFloat(app.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        val name = if (still) "feed-covers-motion-still" else "feed-covers-motion"
        open(dark = false)
        rule.waitUntil(10_000) { daemon.requests.any { it.endsWith("/files/loop.webp") } }
        rule.waitForIdle()
        SystemClock.sleep(2500)
        val box = rule.onAllNodes(androidx.compose.ui.test.hasTestTag(FeedTags.COVER), useUnmergedTree = true)[0].fetchSemanticsNode().boundsInRoot
        val origin = IntArray(2).also { rule.activity.window.decorView.getLocationOnScreen(it) }
        fun frame(file: String): IntArray {
            val shot = File(evidence, file)
            device.takeScreenshot(shot)
            val bitmap = android.graphics.BitmapFactory.decodeFile(shot.path)
            val left = origin[0] + box.left.toInt() + 8
            val top = origin[1] + box.top.toInt() + 8
            val width = box.width.toInt() - 16
            val height = box.height.toInt() - 16
            return IntArray(width * height).also { bitmap.getPixels(it, 0, width, left, top, width, height) }
        }
        val first = frame("$name-a.png")
        SystemClock.sleep(450)
        val second = frame("$name-b.png")
        if (still) {
            assertTrue("with animations off the cover holds its first frame", first.contentEquals(second))
        } else {
            assertTrue("the animated cover moves", !first.contentEquals(second))
            // In the background it stops: two frames apart are the same.
            rule.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.STARTED)
            SystemClock.sleep(600)
            val paused = frame("$name-paused-a.png")
            SystemClock.sleep(450)
            assertTrue("a paused app's cover holds still", paused.contentEquals(frame("$name-paused-b.png")))
            rule.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
        }
    }

    /** The artifacts list over the same daemon: a wide cover, a square one, a picture without one, and a glyph. */
    private fun list(dark: Boolean) {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        val files = ArtifactClient(AgentClient(daemon, "fixture"))
        val catalog = com.slopus.happy.artifacts.ArtifactCatalogFeed(scope, { files.catalog(it) }, { files.artifact(it) }, kept = { null }, keep = {})
        rule.runOnUiThread { catalog.start(kotlinx.coroutines.flow.emptyFlow()) }
        val thumbnails = com.slopus.happy.ui.artifacts.ArtifactThumbnails(files, scope)
        val covers = FeedCovers.of(files, null)
        rule.setContent {
            HappyTheme(preference = if (dark) com.slopus.happy.ui.theme.ThemePreference.Dark else com.slopus.happy.ui.theme.ThemePreference.Light) {
                val state by catalog.state.collectAsState()
                com.slopus.happy.ui.artifacts.ArtifactsScreen(state, {}, {}, {}, thumbnails, covers = covers)
            }
        }
        // Two covers read whole; the animated cover and the photo through their stills.
        rule.waitUntil(10_000) { daemon.requests.count { it.contains("/files/") || it.contains("/previews/") } >= 4 }
        rule.waitForIdle()
        SystemClock.sleep(1500)
        device.takeScreenshot(File(evidence, "artifacts-list-covers${if (dark) "-dark" else ""}.png"))
        assertTrue(daemon.requests.toString(), "GET /v0/artifacts/fx-loop/versions/1/previews/loop.webp" in daemon.requests)
        assertTrue(daemon.requests.toString(), "GET /v0/artifacts/fx-photo/versions/1/previews/team.png" in daemon.requests)
        assertTrue("a previewed file isn't read whole", daemon.requests.none { it.endsWith("/files/loop.webp") || it.endsWith("/files/team.png") })
    }

    private fun show(dark: Boolean) {
        val suffix = if (dark) "-dark" else ""
        val library = open(dark)
        rule.waitUntil(10_000) { rule.onAllNodesWithText("Q3 revenue").fetchSemanticsNodes().isNotEmpty() }
        // Before the pictures land, each post already has its height, on its ground.
        device.takeScreenshot(File(evidence, "feed-covers-loading$suffix.png"))
        rule.waitUntil(10_000) { daemon.requests.count { it.endsWith("/files/cover.png") } >= 2 }
        rule.waitForIdle()
        SystemClock.sleep(3000)
        device.takeScreenshot(File(evidence, "feed-covers-all$suffix.png"))
        rule.onNodeWithTag(FeedTags.LIST).performScrollToNode(hasText("Release notes"))
        rule.waitForIdle()
        SystemClock.sleep(1000)
        device.takeScreenshot(File(evidence, "feed-covers-all-scrolled$suffix.png"))

        rule.onNodeWithTag(FeedTags.filter(FeedFilter.Highlights)).performClick()
        rule.waitUntil(10_000) { library.state.value.filter == FeedFilter.Highlights && daemon.requests.any { "subjects=artifact,task" in it } }
        rule.waitForIdle()
        SystemClock.sleep(1500)
        rule.onNodeWithText("Groceries").assertDoesNotExist()
        device.takeScreenshot(File(evidence, "feed-covers-highlights$suffix.png"))
        rule.onNodeWithTag(FeedTags.LIST).performScrollToNode(hasText("Fix the login redirect", substring = true))
        rule.waitForIdle()
        SystemClock.sleep(1000)
        device.takeScreenshot(File(evidence, "feed-covers-highlights-scrolled$suffix.png"))
        // Both covers were read through the artifact file route.
        assertTrue(daemon.requests.toString(), daemon.requests.any { it == "GET /v0/artifacts/fx-q3/versions/2/files/cover.png" })
        assertTrue(daemon.requests.toString(), daemon.requests.any { it == "GET /v0/artifacts/fx-pipeline/versions/1/files/cover.png" })
    }

    /** The Feed over [daemon], in All. */
    private fun open(dark: Boolean): FeedLibrary {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        val client = AgentClient(daemon, "fixture")
        val catalog = AgentCatalog().withBootstrap(AgentClient.json.decodeFromString(WireDesktopBootstrap.serializer(), BOOTSTRAP))
        val library = FeedLibrary(scope, AgentFeedRoutes(client), IntentOutbox(scope, MemoryIntentStorage()), kept = { null }, keep = {})
        val lookups = FeedLookups.of(scope, client) { ArtifactClient(client).artifact(it) }
        val covers = FeedCovers.of(ArtifactClient(client), null)
        rule.runOnUiThread {
            library.start()
            library.bootstrap(4, "e1")
            library.connected()
        }
        rule.setContent {
            HappyTheme(preference = if (dark) com.slopus.happy.ui.theme.ThemePreference.Dark else com.slopus.happy.ui.theme.ThemePreference.Light) {
                ProvideWindowLayout {
                    val state by library.state.collectAsState()
                    val found by lookups.found.collectAsState()
                    LaunchedEffect(state.items) { lookups.want(state.items) }
                    val rows = remember(state, found) { FeedRows.make(state.items, state::isUnread, catalog, found, "fixture") }
                    FeedScreen(
                        state, rows, catalog, FeedFollowingState(loaded = true),
                        FeedActions(onBack = {}, onFilter = library::show, onRefresh = library::refresh, onLoadMore = library::loadMore),
                        covers = covers,
                    )
                }
            }
        }
        return library
    }

    private fun androidx.compose.ui.test.junit4.ComposeTestRule.onAllNodesWithText(text: String) =
        onAllNodes(hasText(text), useUnmergedTree = true)

    /** A daemon with covers and the subject filter, in memory: every request is recorded here and nowhere else. */
    private class CoverDaemon(private val now: Long) : Transport {
        val requests: MutableList<String> = Collections.synchronizedList(ArrayList())
        private val wide by lazy { wideCover() }
        private val square by lazy { squareCover() }
        /** An animated WebP: a bar filling and a square crossing, 16 frames at 10 a second. */
        private val loop by lazy { InstrumentationRegistry.getInstrumentation().context.assets.open("cover-loop.webp").use { it.readBytes() } }
        /** The computer's still of it: its first frame. */
        private val loopStill by lazy { png(android.graphics.BitmapFactory.decodeByteArray(loop, 0, loop.size)) }
        /** A picture artifact without a cover: the computer's still of its photo fills the row's slot. */
        private val photo by lazy {
            val bitmap = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            canvas.drawColor(Color.rgb(120, 190, 230))
            canvas.drawRect(0f, 330f, 640f, 480f, Paint().apply { color = Color.rgb(70, 150, 90) })
            canvas.drawCircle(480f, 130f, 70f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(255, 214, 90) })
            png(bitmap)
        }

        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            requests += "$method $path"
            val route = path.substringBefore('?')
            return when {
                route == "/v0/artifacts" -> json(CATALOG.replace("NOW", now.toString()))
                route == "/v0/artifacts/fx-photo/versions/1/previews/team.png" -> TransportResponse(200, body = photo)
                route == "/v0/artifacts/fx-loop/versions/1/previews/loop.webp" -> TransportResponse(200, body = loopStill)
                route == "/v0/artifacts/fx-loop/versions/1/files/loop.webp" -> TransportResponse(200, body = loop)
                route == "/v0/artifacts/fx-loop" -> json(
                    """{"artifact":{"id":"fx-loop","type":"html","title":"Nightly build","status":"active","latestVersion":1,"background":"#101828",
                        "cover":{"path":"loop.webp","mimeType":"image/webp","width":640,"height":360,"aspect":"wide","thumbhash":"$LOOP_HASH","preview":{"width":640,"height":360}},
                        "summary":"The nightly build, live: the test suite is running."}}""",
                )
                route == "/v0/health" -> json("""{"capabilities":{"feed":true,"feedSubjectFilter":true,"artifactCovers":true}}""")
                route == "/v0/feed" && "subjects=artifact,task" in path -> json(page(highlights = true))
                route == "/v0/feed" -> json(page(highlights = false))
                route == "/v0/artifacts/fx-q3" -> json(
                    """{"artifact":{"id":"fx-q3","type":"html","title":"Q3 revenue","status":"active","latestVersion":2,"background":"#0b1020",
                        "cover":{"path":"cover.png","mimeType":"image/png","width":1600,"height":900,"aspect":"wide"},
                        "summary":"Revenue up 18% QoQ, driven by enterprise seats."}}""",
                )
                route == "/v0/artifacts/fx-pipeline" -> json(
                    """{"artifact":{"id":"fx-pipeline","type":"html","title":"Pipeline by stage","status":"active","latestVersion":1,"background":null,
                        "cover":{"path":"cover.png","mimeType":"image/png","width":1200,"height":1200,"aspect":"square"},
                        "summary":"42 deals in proposal, up from 31 last week."}}""",
                )
                // An artifact from before covers: none sent, and it keeps its row.
                route == "/v0/artifacts/fx-notes" -> json("""{"artifact":{"id":"fx-notes","type":"markdown","title":"Release notes","status":"active","latestVersion":3}}""")
                route == "/v0/artifacts/fx-q3/versions/2/files/cover.png" -> TransportResponse(200, body = wide)
                route == "/v0/artifacts/fx-pipeline/versions/1/files/cover.png" -> TransportResponse(200, body = square)
                method != "GET" -> json("{}")
                else -> TransportResponse(404, body = """{"error":"not in the fixture","code":"not_found"}""".toByteArray())
            }
        }

        override suspend fun close() {}

        private fun json(text: String) = TransportResponse(200, mapOf("content-type" to "application/json"), text.toByteArray())

        private fun entry(id: String, type: String, subject: String, minutes: Long, seen: Boolean, created: Boolean = false, updates: Int = 0, actor: String) =
            """{"id":"$id","version":"1","cursor":"c$id","subject":{"type":"$type","id":"$subject"},"created":$created,"updates":$updates,
                "actors":[{$actor}],"actorCount":1,"firstAt":${now - minutes * 60_000},"lastAt":${now - minutes * 60_000}${if (seen) ""","seenAt":$now""" else ""}}"""

        private fun page(highlights: Boolean): String {
            val all = listOf(
                "artifact" to entry("7", "artifact", "fx-loop", 3, seen = false, updates = 4, actor = "\"agentId\":\"at1\""),
                "artifact" to entry("6", "artifact", "fx-q3", 8, seen = false, updates = 1, actor = "\"agentId\":\"at1\""),
                "surface" to entry("5", "surface", "s1", 25, seen = false, updates = 3, actor = "\"userId\":\"u1\""),
                "artifact" to entry("4", "artifact", "fx-pipeline", 50, seen = false, created = true, actor = "\"agentId\":\"ab1\""),
                "task" to entry("3", "task", "t1", 120, seen = true, created = true, updates = 2, actor = "\"agentId\":\"at1\""),
                "artifact" to entry("2", "artifact", "fx-notes", 180, seen = true, updates = 2, actor = "\"agentId\":\"ab1\""),
                "bot" to entry("1", "bot", "b1", 26 * 60, seen = true, created = true, actor = "\"userId\":\"u1\""),
            )
            val items = all.filter { !highlights || it.first == "artifact" || it.first == "task" }.joinToString(",") { it.second }
            return """{"items":[$items],"unread":4,${if (highlights) "\"filteredUnread\":3," else ""}"hasMore":false,"cursor":"e9"}"""
        }

        /** A 16:9 title card: the headline and its number over a rising line. */
        private fun wideCover(): ByteArray {
            val bitmap = Bitmap.createBitmap(1600, 900, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            canvas.drawColor(Color.rgb(11, 16, 32))
            val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(160, 174, 210); textSize = 56f; typeface = Typeface.DEFAULT_BOLD }
            canvas.drawText("Q3 REVENUE", 96f, 170f, text)
            text.apply { color = Color.WHITE; textSize = 220f }
            canvas.drawText("+18%", 88f, 400f, text)
            text.apply { color = Color.rgb(160, 174, 210); textSize = 52f; typeface = Typeface.DEFAULT }
            canvas.drawText("quarter over quarter", 100f, 480f, text)
            val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(91, 140, 255); strokeWidth = 14f; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
            val points = listOf(780f to 700f, 920f to 640f, 1060f to 660f, 1200f to 520f, 1340f to 450f, 1480f to 300f)
            points.zipWithNext().forEach { (a, b) -> canvas.drawLine(a.first, a.second, b.first, b.second, line) }
            val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(91, 140, 255) }
            points.forEach { canvas.drawCircle(it.first, it.second, 18f, dot) }
            return png(bitmap)
        }

        /** A 1:1 chart: deals by stage. */
        private fun squareCover(): ByteArray {
            val bitmap = Bitmap.createBitmap(1200, 1200, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            canvas.drawColor(Color.rgb(248, 246, 240))
            val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(30, 30, 30); textSize = 72f; typeface = Typeface.DEFAULT_BOLD }
            canvas.drawText("Pipeline by stage", 90f, 160f, text)
            val bars = listOf("Lead" to 58, "Qualified" to 47, "Proposal" to 42, "Won" to 19)
            val colors = listOf(Color.rgb(255, 159, 67), Color.rgb(255, 120, 80), Color.rgb(235, 87, 87), Color.rgb(46, 160, 110))
            val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(90, 90, 90); textSize = 44f }
            val value = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(30, 30, 30); textSize = 56f; typeface = Typeface.DEFAULT_BOLD }
            bars.forEachIndexed { index, (name, count) ->
                val top = 280f + index * 220f
                val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = colors[index] }
                canvas.drawRoundRect(90f, top + 60f, 90f + count * 14f, top + 170f, 24f, 24f, paint)
                canvas.drawText(name, 90f, top + 40f, label)
                canvas.drawText("$count", 90f + count * 14f + 30f, top + 135f, value)
            }
            return png(bitmap)
        }

        private fun png(bitmap: Bitmap) = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    private companion object {
        /** The loop's first frame as a ThumbHash. */
        const val LOOP_HASH = "h+cFDIDPeUapeHdEVHjfifCdCA"

        val CATALOG = """{"artifacts":[
            {"id":"fx-loop","type":"html","title":"Nightly build","latestVersion":1,"createdAt":NOW,"updatedAt":NOW,"background":"#101828",
                "entry":{"path":"index.html","mimeType":"text/html","size":10},
                "cover":{"path":"loop.webp","mimeType":"image/webp","width":640,"height":360,"aspect":"wide","thumbhash":"$LOOP_HASH","preview":{"width":640,"height":360}}},
            {"id":"fx-q3","type":"html","title":"Q3 revenue","latestVersion":2,"createdAt":NOW,"updatedAt":NOW,"background":"#0b1020",
                "entry":{"path":"index.html","mimeType":"text/html","size":10},
                "cover":{"path":"cover.png","mimeType":"image/png","width":1600,"height":900,"aspect":"wide"}},
            {"id":"fx-pipeline","type":"html","title":"Pipeline by stage","latestVersion":1,"createdAt":NOW,"updatedAt":NOW,
                "entry":{"path":"index.html","mimeType":"text/html","size":10},
                "cover":{"path":"cover.png","mimeType":"image/png","width":1200,"height":1200,"aspect":"square"}},
            {"id":"fx-photo","type":"image","title":"Team offsite","latestVersion":1,"createdAt":NOW,"updatedAt":NOW,
                "entry":{"path":"team.png","mimeType":"image/png","size":10,"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI","preview":{"width":640,"height":480}}},
            {"id":"fx-notes","type":"markdown","title":"Release notes","latestVersion":3,"createdAt":NOW,"updatedAt":NOW,
                "entry":{"path":"index.md","mimeType":"text/markdown","size":10}}
        ],"nextPageCursor":null}"""

        val BOOTSTRAP = """{
            "projects":[],"workspaces":[],"taskMemberships":[],"cursor":"c0","profile":{"userId":"u1"},
            "bots":[{"id":"b1","name":"Scout","version":"01","orderKey":"1","status":"active","archivedAt":null,
                "agent":{"id":"ab1","workspaceId":"wab1","version":"01","status":"idle","parentAgentId":null,"subtask":false,"userVisible":true,"title":"Scout","titleStatus":"ready","pendingQuestionId":null,"unread":null,"subtasks":[],"orderKey":null,"archivedAt":null,"createdAt":1,"updatedAt":2}}],
            "tasks":[{"id":"t1","name":"Fix the login redirect on Safari","version":"01","status":"active","archivedAt":null,
                "agent":{"id":"at1","workspaceId":"wat1","version":"01","status":"idle","parentAgentId":null,"subtask":false,"userVisible":true,"title":"Fix the login redirect on Safari","titleStatus":"ready","pendingQuestionId":null,"unread":null,"subtasks":[],"orderKey":null,"archivedAt":null,"createdAt":1,"updatedAt":2}}],
            "surfaces":[{"id":"s1","name":"Groceries","type":"todo","status":"active","archivedAt":null,"members":[{"userId":"u1","orderKey":"1"}]}]
        }"""
    }
}
