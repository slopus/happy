package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.*
import com.slopus.happy.connection.*
import com.slopus.happy.conversation.*
import com.slopus.happy.feed.*
import com.slopus.happy.ui.connection.*
import com.slopus.happy.ui.conversation.*
import com.slopus.happy.ui.feed.*
import com.slopus.happy.ui.home.*
import com.slopus.happy.ui.call.CallFrame
import com.slopus.happy.call.CallState
import com.slopus.happy.call.CallActivity
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import com.slopus.happy.ui.artifacts.InlinePages
import com.slopus.happy.ui.browser.BrowserPage
import com.slopus.happy.browser.BrowserProxy
import com.slopus.happy.references.References
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.*
import org.junit.*
import org.junit.runner.RunWith
import java.io.File

/** Private v8 fixtures around unmodified production Compose screens. No live account. */
@RunWith(AndroidJUnit4::class)
class StoryV8DeviceShots {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dir = File(instrumentation.targetContext.filesDir, "v8-shots").apply { mkdirs() }
    private var scene by mutableStateOf("home")
    private var phase by mutableIntStateOf(-1)
    private var lines by mutableStateOf(emptyMap<String, WorkspaceLineChanges>())
    private val call = MutableStateFlow<CallState>(CallState.Idle)
    private val level = MutableStateFlow(0f)
    private fun asset(path: String) = instrumentation.context.assets.open("marketing/$path").use { it.readBytes() }
    private fun data(name: String) = asset("$name.json").toString(Charsets.UTF_8)
    private fun json(name: String): JsonObject {
        val value = Json.parseToJsonElement(data(name)).jsonObject
        if (name != "usage") return value
        val refreshed = JsonPrimitive(System.currentTimeMillis() - 8 * 60000L)
        return JsonObject(value + ("providers" to JsonArray(value["providers"]!!.jsonArray.map { entry ->
            JsonObject(entry.jsonObject + ("refreshedAt" to refreshed))
        })))
    }
    private val users get() = TeamUser.parse(json("users")["users"]?.jsonArray).associateBy { it.id }
    private val pictures = AgentPictures("fictional-v8", fetch = { path ->
        val icon = listOf("android-push", "release-checklist", "bot-1", "ios-overlay", "landing").indexOfFirst { path.contains("/$it/") }
        asset(if (path.contains("/users/")) "photos/${if (path.contains("steve")) "steve" else "kirill"}.jpg" else "icons/feed-${if (icon < 0) 2 else icon}-160.png")
    })
    private val accounts = AccountMenu(listOf(
        AccountMenuEntry("personal", "MacBook Pro", agent = true, seed = "agent:demo-personal"),
        AccountMenuEntry("home", "Smart Home Server", agent = true, seed = "agent:demo-home"),
        AccountMenuEntry("team", "Happy Engineering Team", agent = true, active = true, seed = "agent:demo-team"),
    ))
    private val request: AgentRequest = { _, path, _, _ ->
        val route = path.substringBefore('?')
        val name = when {
            route.endsWith("/bootstrap") -> if (scene == "voice") "voicebootstrap" else "bootstrap"
            route.endsWith("/messages") -> if (scene == "voice") "voicepage" else "page"
            route.endsWith("/question") -> "question"
            route == "/v0/config" -> "config"
            else -> null
        }
        TransportResponse(200, mapOf("content-type" to "application/json"), (name?.let(::data) ?: "{}").toByteArray())
    }
    private fun catalog(name: String) = AgentCatalog().withBootstrap(AgentClient.json.decodeFromString<WireDesktopBootstrap>(data(name)))
    private fun snapshotLines() = json("git")["snapshots"]!!.jsonObject.mapValues { (_, v) ->
        val o = v.jsonObject
        WorkspaceLineChanges("ready", o["insertions"]!!.jsonPrimitive.long, o["deletions"]!!.jsonPrimitive.long, true, 0.0)
    }
    private val pageClient = AgentClient(object : Transport {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String,String>, category: RequestCategory) = TransportResponse(200)
        override suspend fun socket(): TransportSocket = object : TransportSocket {
            private var response = ByteArray(0)
            override suspend fun write(bytes: ByteArray) {
                val body = asset("chart.html")
                response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray() + body
            }
            override suspend fun read(maximumBytes: Int): ByteArray = response.take(maximumBytes).toByteArray().also { response = response.drop(it.size).toByteArray() }
            override fun close() {}
        }
        override suspend fun close() {}
    }, "fictional")
    private val pages = InlinePages(prepare = { id, page -> BrowserPage.artifact({ authority -> BrowserProxy.Scope.Artifact(pageClient, id, page.version, authority, null) }, id, page.entry) }, onOpen = {})
    @Composable private fun Screens() {
        CompositionLocalProvider(LocalAgentPictures provides pictures) {
            CallFrame(call, level, onMute = {}, onEnd = {}) {
                key(scene) {
                    when (scene) {
                        "home" -> {
                            val c = remember(phase) { catalog(if (phase < 0) "home" else "video$phase") }
                            val git = if (phase < 0) snapshotLines() else snapshotLines().filterKeys { !it.startsWith("sub-") } + lines
                            val feed = AgentFeed.derive(c, git = git, feedUnread = 3, users = users)
                            AgentHomeScreen("Happy Engineering Team", feed, AgentLinkStatus.Connected, accounts,
                                AgentHomeActions({ scene = "chat" }, {}, {}, {}, {}, {}, onOpenFeed = { scene = "feed" }, onVoice = { scene = "voice" }))
                        }
                        "feed" -> {
                            val c = remember { catalog("home") }
                            val items = remember { FeedItem.list(json("feed")["items"]) }
                            val state = remember { FeedLibrary.State(available = true, items = items, unread = 3, loaded = true) }
                            val rows = remember { FeedRows.make(items, state::isUnread, c, FeedLookups.Found(), "fictional-v8", c.profilePhoto, users).map { row ->
                                val id = when(row.title) { "Android Push Fixes" -> "android-push"; "2.0 Release Checklist" -> "release-checklist"; "Release Coordinator" -> "bot-1"; "iOS Overlay Layout" -> "ios-overlay"; else -> "landing" }
                                row.copy(face = FeedFace.Mark(id, false, picture = "/v0/surfaces/$id/image"))
                            } }
                            FeedScreen(state, rows, c, FeedFollowingState(loaded = true), FeedActions(onBack = { scene = "home" }))
                        }
                        else -> {
                            val conversation = remember { Conversation(ConversationApi(request), emptyFlow(), scope, "checkout").also { it.start() } }
                            val state by conversation.state.collectAsStateWithLifecycle()
                            val shown = if (scene == "voice") state.copy(rows = state.rows.map { row -> if (row is ConversationRow.Artifact) row.copy(page = References.Page(1, "index.html")) else row }) else state
                            ConversationScreen(shown, "Happy Engineering Team", ConversationScreenActions(onBack = { scene = "home" }, onVisible = conversation::setVisible, onModeChange = conversation::setMode, pages = pages), usage = AccountUsage.project(json("usage")))
                        }
                    }
                }
            }
        }
    }
    @After fun stop() { scope.cancel() }
    private fun start() {
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"))
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent { HappyTheme(preference = ThemePreference.Light) { Screens() } }
        rule.waitForIdle()
        SystemClock.sleep(2200)
    }
    private fun capture(name: String) {
        if (scene != "voice") rule.waitForIdle()
        SystemClock.sleep(1500)
        check(device.takeScreenshot(File(dir, "$name.png")))
        File(dir, "timings.tsv").appendText("$name\t${System.currentTimeMillis()}\t${SystemClock.elapsedRealtime()}\n")
    }
    private fun show(name: String) { rule.runOnUiThread { scene = name }; SystemClock.sleep(2200); rule.waitForIdle() }
    @Test fun stills() {
        start()
        capture("01-home")
        rule.onNodeWithTag(AccountMenuTags.BUTTON, useUnmergedTree = true).performClick()
        capture("04-servers")
        device.pressBack()
        show("feed")
        capture("02-feed")
        show("chat")
        rule.onNodeWithTag(ConversationComposerTags.INPUT, useUnmergedTree = true).performClick()
        SystemClock.sleep(500); device.pressBack(); SystemClock.sleep(500)
        rule.onNodeWithTag(ConversationModeTags.MODEL, useUnmergedTree = true).performClick()
        capture("03-model-list")
        rule.onNodeWithTag(ModelPickerTags.heading("codex"), useUnmergedTree = true).performClick()
        capture("03-model-accounts")
        device.pressBack()
        voiceCapture()
    }
    private fun voiceCapture() {
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { call.value = CallState.Active(CallActivity.Listening, false, SystemClock.elapsedRealtime() - 42000); scene = "voice" }
        repeat(50) {
            rule.mainClock.advanceTimeBy(100)
            SystemClock.sleep(100)
        }
        check(pages.height("retention").value > 200f) { "Inline chart did not measure its full height" }
        rule.mainClock.advanceTimeBy(1000)
        rule.waitForIdle()
        capture("05-voice")
    }
    @Test fun voiceOnly() { start(); voiceCapture() }
    @Test fun hero() {
        phase = 0
        start()
        File(dir, "hero-ready").writeText("${System.currentTimeMillis()}")
        SystemClock.sleep(3500)
        val began = SystemClock.elapsedRealtime()
        File(dir, "hero-timing.tsv").writeText("begin\t${System.currentTimeMillis()}\t$began\n")
        fun move(p: Int) { rule.runOnUiThread { phase = p } }
        fun change(id: String, plus: Int, minus: Int) { rule.runOnUiThread { lines = lines + (id to WorkspaceLineChanges("ready", plus.toLong(), minus.toLong(), true, 0.0)) } }
        for ((i, at) in listOf(2000L,3200L,4600L,6000L,7400L,8800L,11000L).withIndex()) {
            SystemClock.sleep((began + at - SystemClock.elapsedRealtime()).coerceAtLeast(0))
            when(i) {
                0 -> move(1)
                1 -> change("sub-icons",8,0)
                2 -> { move(2); change("sub-icons",21,2) }
                3 -> { change("sub-icons",34,3); change("sub-dots",6,0) }
                4 -> change("sub-icons",47,5)
                5 -> { change("sub-icons",52,9); change("sub-dots",14,1) }
                6 -> move(3)
            }
            File(dir,"hero-timing.tsv").appendText("step$i\t${System.currentTimeMillis()}\t${SystemClock.elapsedRealtime()}\n")
        }
        SystemClock.sleep((began + 18000 - SystemClock.elapsedRealtime()).coerceAtLeast(0))
        capture("01-hero-end")
        File(dir, "hero-done").writeText("${System.currentTimeMillis()}")
    }
}