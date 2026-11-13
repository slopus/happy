package com.slopus.happy.ui.genui

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.lifecycleScope
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.ui.artifacts.ArtifactActions
import com.slopus.happy.ui.artifacts.ArtifactLoader
import com.slopus.happy.ui.artifacts.ArtifactScreen
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference

/**
 * Debug builds only: a bundled render fixture opened as a `gen_ui` artifact,
 * through the real [ArtifactLoader] and [ArtifactScreen] (pictures, viewer,
 * actions), over an in-memory computer that serves the version's files.
 * Links are only logged (tag `GenUiArtifactGym`).
 * ```
 * adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.genui.GenUiArtifactGymActivity \
 *     -e genui.fixture 05-gallery-grid [-e genui.theme dark]
 * ```
 */
class GenUiArtifactGymActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val dark = intent.getStringExtra("genui.theme") == "dark"
        val fixture = intent.getStringExtra("genui.fixture") ?: "05-gallery-grid"
        val pictures = assets.list("genui/assets").orEmpty().map { "assets/$it" }
        val files = (listOf(".genui/render.json") + pictures).joinToString(",") { path ->
            """{"path":"$path","mimeType":"${if (path.endsWith(".jpg")) "image/jpeg" else "application/json"}","size":1}"""
        }
        val version = """{"artifactId":"gym","number":1,"title":"$fixture","entry":{"path":"index.genui.json","mimeType":"application/json"},"files":[$files]}"""
        val computer = object : Transport {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                if ("/files/" !in path) return TransportResponse(200, mapOf("content-type" to "application/json"), """{"version":$version}""".toByteArray())
                val file = path.substringAfter("/files/")
                val asset = if (file == ".genui/render.json") "genui/fixtures/$fixture.json" else "genui/$file"
                return runCatching { TransportResponse(200, body = assets.open(asset).use { it.readBytes() }) }.getOrElse { TransportResponse(404, body = "{}".toByteArray()) }
            }

            override suspend fun close() {}
        }
        val loader = ArtifactLoader(ArtifactClient(AgentClient(computer, "gym")), null, lifecycleScope, ArtifactRef("gym", 1, "gen_ui", fixture, followsLatest = true))
        loader.load()
        val actions = ArtifactActions(onBack = ::finish, onOpenWeb = { Log.i("GenUiArtifactGym", "open $it") })
        setContent {
            HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) {
                val title by loader.title.collectAsState()
                val state by loader.state.collectAsState()
                ArtifactScreen(title, state, loader.media, "Gym", actions)
            }
        }
    }
}
