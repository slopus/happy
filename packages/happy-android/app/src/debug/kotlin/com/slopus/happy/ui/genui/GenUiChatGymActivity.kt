package com.slopus.happy.ui.genui

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.layout.LazyLayoutCacheWindow
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.Presentation
import com.slopus.happy.conversation.ToolUse
import com.slopus.happy.genui.GenUi
import com.slopus.happy.references.References
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.conversation.ConversationRowActions
import com.slopus.happy.ui.conversation.ConversationRowView
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference

/**
 * Debug builds only: a transcript of [ROWS] rows, each an answer and a Gen
 * UI artifact under its card, drawn by the chat's own [ConversationRowView]
 * over an in-memory computer that serves every bundled fixture as an
 * artifact version made by this conversation's agent. For scrolling and
 * frame timing on a device; `message` and `open` are only logged (tag
 * `GenUiChatGym`).
 * ```
 * adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.genui.GenUiChatGymActivity [-e genui.theme dark] [--ez genui.plain true] [--ef genui.window 1]
 * ```
 * `genui.plain` draws the same rows with each artifact as its card alone and
 * its document's fallback as the answer's words: the control for timing.
 */
@OptIn(ExperimentalFoundationApi::class)
class GenUiChatGymActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val dark = intent.getStringExtra("genui.theme") == "dark"
        val fixtures = assets.list("genui/fixtures").orEmpty().map { it.removeSuffix(".json") }.sorted()
        val pictures = assets.list("genui/assets").orEmpty().map { "assets/$it" }
        val computer = object : Transport {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                val fixture = path.substringAfter("/artifacts/").substringBefore('/')
                if ("/files/" in path) {
                    val file = path.substringAfter("/files/")
                    val asset = if (file == ".genui/render.json") "genui/fixtures/$fixture.json" else "genui/$file"
                    return runCatching { TransportResponse(200, body = assets.open(asset).use { it.readBytes() }) }.getOrElse { TransportResponse(404, body = "{}".toByteArray()) }
                }
                val files = (listOf(".genui/render.json") + pictures).joinToString(",") { p ->
                    """{"path":"$p","mimeType":"${if (p.endsWith(".jpg")) "image/jpeg" else "application/json"}","size":1}"""
                }
                val version = """{"artifactId":"$fixture","number":1,"title":"$fixture","entry":{"path":"index.genui.json"},"files":[$files],"createdBy":{"kind":"agent","agentId":"gym"}}"""
                return TransportResponse(200, mapOf("content-type" to "application/json"), """{"version":$version}""".toByteArray())
            }

            override suspend fun close() {}
        }
        val client = AgentClient(computer, "gym")
        val plain = intent.getBooleanExtra("genui.plain", false)
        val window = intent.getFloatExtra("genui.window", 0f)
        val fallbacks = fixtures.associateWith { name -> GenUi.parse(assets.open("genui/fixtures/$name.json").bufferedReader().use { it.readText() }).fallback.orEmpty() }
        val rows = (0 until ROWS).flatMap { i ->
            val fixture = fixtures[i % fixtures.size]
            val words = "Here is $fixture, take $i." + if (plain) "\n\n" + fallbacks.getValue(fixture) else ""
            val tool = ToolUse("create_artifact", "completed", Presentation.Artifact(fixture, "gen_ui", fixture, 1, "latest"))
            listOf(
                ConversationRow.Text("t$i", words, parseMarkdown(words)),
                ConversationRow.Artifact("a$i", fixture, fixture, "gen_ui", 1, "latest", tool, References.Page(1, "index.genui.json", genUi = true).takeIf { !plain }),
            )
        }
        setContent {
            HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) {
                val actions = remember {
                    ConversationRowActions(
                        MessageCallbacks(),
                        onRetryFailure = {},
                        loadMedia = { ByteArray(0) },
                        onOpenArtifact = { Log.i("GenUiChatGym", "open artifact ${it.artifactId}") },
                        genUi = GenUiInline(client, null, "gym", onMessage = { Log.i("GenUiChatGym", "message $it") }, onOpenWeb = { Log.i("GenUiChatGym", "open $it") }),
                    )
                }
                val bubble = userMessageBubblePalette(null, dark)
                // `genui.window`: rows composed ahead of the viewport (and kept behind it), as fractions of it.
                val state = if (window > 0f) rememberLazyListState(LazyLayoutCacheWindow(aheadFraction = window, behindFraction = window / 2)) else rememberLazyListState()
                LazyColumn(
                    state = state,
                    modifier = Modifier.fillMaxSize().background(HappyTheme.colors.surface).windowInsetsPadding(WindowInsets.safeDrawing).testTag("genui.chat"),
                ) {
                    items(rows, key = { it.key }) { row -> ConversationRowView(row, bubble, actions) }
                }
            }
        }
    }

    private companion object {
        const val ROWS = 100
    }
}
