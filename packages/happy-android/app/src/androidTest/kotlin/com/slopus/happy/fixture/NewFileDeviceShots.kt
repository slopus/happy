package com.slopus.happy.fixture

import android.os.SystemClock
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.WorkspaceGit
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.ui.chat.LocalToolEnvironment
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.ToolEnvironment
import com.slopus.happy.ui.chat.ToolView
import com.slopus.happy.ui.diff.DiffTags
import com.slopus.happy.ui.files.AgentChanges
import com.slopus.happy.ui.files.ChangesActions
import com.slopus.happy.ui.files.ChangesContent
import com.slopus.happy.ui.files.ChangesScreen
import com.slopus.happy.ui.files.MessageDetailEnvironment
import com.slopus.happy.ui.files.MessageDetailScreen
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * A new file on a device: a Write's tool card in the chat, its screen, and the
 * workspace's changes with an untracked file beside a modified one, over a
 * made-up workspace that exists only in this test's memory. Shots go to the
 * app's external files under `new-file/`. Run on an assigned emulator.
 */
@RunWith(AndroidJUnit4::class)
class NewFileDeviceShots {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val dir = File(instrumentation.targetContext.getExternalFilesDir(null), "new-file").apply { mkdirs() }

    private val request: AgentRequest = { _, path, _, _ ->
        val route = path.substringBefore('?')
        val body = when (route) {
            "/v0/workspaces/$WORKSPACE/git" -> GIT
            "/v0/workspaces/$WORKSPACE/file-revision" -> BASE[file(path)]?.let { """{"content":"${b64(it)}"}""" }
            "/v0/workspaces/$WORKSPACE/file" -> """{"content":"${b64(WORKING.getValue(file(path)))}","hash":"${"b".repeat(64)}"}"""
            else -> null
        }
        if (body == null) TransportResponse(404, body = """{"error":"not in the fixture","code":"not_found"}""".toByteArray())
        else TransportResponse(200, mapOf("content-type" to "application/json"), body.toByteArray())
    }

    private fun file(path: String) = java.net.URLDecoder.decode(path.substringAfter("path=").substringBefore('&'), "UTF-8")
    private fun b64(text: String) = Base64.encodeToString(text.toByteArray(), Base64.NO_WRAP)

    private fun waitFor(tag: String, count: Int = 1) =
        rule.waitUntil(15_000) { rule.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().size >= count }

    private fun capture(name: String) {
        rule.waitForIdle()
        SystemClock.sleep(1200)
        device.takeScreenshot(File(dir, "$name.png"))
    }

    private val write = ChatMessage.ToolCallMessage(
        "m1", 0,
        ToolCall(
            name = "Write",
            state = ToolState.Completed,
            input = buildJsonObject {
                put("file_path", JsonPrimitive("/repo/sources/cache/TestClock.kt"))
                put("content", JsonPrimitive(WORKING.getValue("sources/cache/TestClock.kt")))
            },
            createdAt = 0,
            result = JsonPrimitive("File created successfully."),
        ),
    )

    @Test fun writeToolCard() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            HappyTheme {
                CompositionLocalProvider(LocalToolEnvironment provides ToolEnvironment(path = "/repo")) {
                    Column(Modifier.fillMaxSize().background(HappyTheme.colors.surface).safeDrawingPadding().padding(16.dp)) {
                        ToolView(write, MessageCallbacks())
                    }
                }
            }
        }
        waitFor(DiffTags.LINE, 4)
        capture("write-tool")
    }

    @Test fun writeScreen() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            HappyTheme { MessageDetailScreen(write, loaded = true, env = MessageDetailEnvironment(path = "/repo"), onBack = {}) }
        }
        waitFor(DiffTags.LINE, 4)
        capture("write-screen")
    }

    @Test fun workspaceChanges() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            HappyTheme {
                val scope = rememberCoroutineScope()
                val changes = remember { AgentChanges(scope, WorkspaceGit(request, WORKSPACE), WORKSPACE, supported = true) }
                LaunchedEffect(changes) { changes.refresh() }
                val state by changes.state.collectAsStateWithLifecycle()
                ChangesScreen(
                    ChangesContent.Agent(state, supported = true, expandFew = true),
                    ChangesActions(onBack = {}, onRequestContent = changes::requestContent, onExpandContext = changes::expandContext),
                )
            }
        }
        waitFor(DiffTags.LINE, 8)
        capture("changes")
    }

    private companion object {
        const val WORKSPACE = "fx-workspace"

        val BASE = mapOf(
            "sources/cache/Store.kt" to "class Store(private val clock: () -> Long) {\n    fun read(key: String): Entry? {\n        val entry = entries[key] ?: return null\n        entry.touched = clock()\n        return entry\n    }\n}\n",
        )
        val WORKING = mapOf(
            "sources/cache/Store.kt" to "class Store(private val clock: Clock) {\n    fun read(key: String): Entry? {\n        val entry = entries[key] ?: return null\n        // A read keeps the entry until the next eviction.\n        entry.touched = clock.now()\n        return entry\n    }\n}\n",
            "sources/cache/TestClock.kt" to """
                |package com.example.cache
                |
                |/** A clock the tests move by hand. */
                |class TestClock(private var millis: Long = 0) : Clock {
                |    override fun now(): Long = millis
                |
                |    fun advance(by: Long) {
                |        require(by >= 0) { "time only moves forward" }
                |        millis += by
                |    }
                |
                |    companion object {
                |        const val START = 1_700_000_000_000L
                |    }
                |}
                |""".trimMargin(),
        )

        const val GIT = """{"git":{
            "facts":{"branch":"fix/cache-eviction","detached":false,"ahead":1,"behind":0},
            "comparison":"ready","base":"origin/main",
            "changedFiles":2,"insertions":17,"deletions":2,"countsExact":true,"conflicted":false,
            "files":[
              {"path":"sources/cache/Store.kt","status":"modified","staged":false,"unstaged":true,"binary":false,"insertions":2,"deletions":2},
              {"path":"sources/cache/TestClock.kt","status":"untracked","staged":false,"unstaged":true,"binary":false,"insertions":15,"deletions":0}
            ],
            "filesTruncated":false,"scannedAt":1755400000000}}"""
    }
}
