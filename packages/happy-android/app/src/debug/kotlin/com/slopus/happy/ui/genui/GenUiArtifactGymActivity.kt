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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Debug builds only: a bundled render fixture opened as a `gen_ui` artifact,
 * through the real [ArtifactLoader] and [ArtifactScreen] (pictures, viewer,
 * actions), over an in-memory computer that serves the version's files,
 * made by agent `gym`. Links are only logged (tag `GenUiArtifactGym`). The
 * computer also runs the secret form (health says `artifactSecretActions`): `GET /v0/secrets/:id` from what it
 * holds (`genui.stored`, comma-separated names, to open in change mode), and
 * the actions route, logging the element and variable names, never a value.
 * ```
 * adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.genui.GenUiArtifactGymActivity \
 *     -e genui.fixture 05-gallery-grid [-e genui.theme dark] [-e genui.stored stripe]
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
        val version = """{"artifactId":"gym","number":1,"title":"$fixture","entry":{"path":"index.genui.json","mimeType":"application/json"},"files":[$files],"createdBy":{"kind":"agent","agentId":"gym"}}"""
        val held = intent.getStringExtra("genui.stored").orEmpty().split(",").filter { it.isNotBlank() }
            .associateWith { listOf("STRIPE_SECRET_KEY", "LEGACY_KEY") }.toMutableMap()
        fun safe(id: String) = held.getValue(id).let { names ->
            """{"id":"$id","description":"Stripe keys, stored","environmentVariables":[${names.sorted().joinToString(",") { "\"$it\"" }}],"managed":false,"availableToAgents":true,"version":"v${names.size}","createdAt":1,"updatedAt":1}"""
        }
        val computer = object : Transport {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                val json = mapOf("content-type" to "application/json")
                if (path == "/v0/health") return TransportResponse(200, json, """{"status":"ok","capabilities":{"artifactSecretActions":true}}""".toByteArray())
                if (path.startsWith("/v0/secrets/")) {
                    val id = path.removePrefix("/v0/secrets/")
                    return if (id in held) TransportResponse(200, json, """{"secret":${safe(id)}}""".toByteArray())
                    else TransportResponse(404, json, """{"error":"Not found","code":"not_found"}""".toByteArray())
                }
                if (path.endsWith("/actions")) {
                    val form = Json.parseToJsonElement(String(body ?: ByteArray(0))).jsonObject
                    val secret = form.getValue("secret").jsonObject
                    val id = secret.getValue("id").jsonPrimitive.content
                    val patch = secret.getValue("environment").jsonObject
                    val created = id !in held
                    val names = (held[id].orEmpty().toSet() - patch.filterValues { it is JsonNull }.keys + patch.filterValues { it !is JsonNull }.keys).toList()
                    held[id] = names
                    Log.i("GenUiArtifactGym", "save ${form["element"]} $id ifMatch=${form["ifMatch"]} set=${patch.filterValues { it !is JsonNull }.keys} removed=${patch.filterValues { it is JsonNull }.keys}")
                    return TransportResponse(200, json, """{"secret":${safe(id)},"outcome":"${if (created) "created" else "updated"}"}""".toByteArray())
                }
                if ("/files/" !in path) return TransportResponse(200, json, """{"version":$version}""".toByteArray())
                val file = path.substringAfter("/files/")
                val asset = if (file == ".genui/render.json") "genui/fixtures/$fixture.json" else "genui/$file"
                return runCatching { TransportResponse(200, body = assets.open(asset).use { it.readBytes() }) }.getOrElse { TransportResponse(404, body = "{}".toByteArray()) }
            }

            override suspend fun close() {}
        }
        val client = AgentClient(computer, "gym")
        val loader = ArtifactLoader(ArtifactClient(client), null, lifecycleScope, ArtifactRef("gym", 1, "gen_ui", fixture, followsLatest = true))
        loader.load()
        val actions = ArtifactActions(onBack = ::finish, onOpenWeb = { Log.i("GenUiArtifactGym", "open $it") }, genUiSecrets = GenUiSecretApi(client))
        setContent {
            HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) {
                val title by loader.title.collectAsState()
                val state by loader.state.collectAsState()
                ArtifactScreen(title, state, loader.media, "Gym", actions)
            }
        }
    }
}
