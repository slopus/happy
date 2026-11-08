package com.slopus.happy.ui.artifacts

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.browser.LocalSocket
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.connection.TransportSocket
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/**
 * A live artifact (happy-agent API.md, "Live URLs") on a device: the real
 * artifact screen, WebView and BrowserProxy over a made-up agent in this
 * test's memory. Its dev server at localhost:4191 is reached only through
 * `CONNECT /v0/artifacts/:id/proxy`; a pinned version opens its own URL; the
 * page's `/api` is the site's own; and an artifact whose proxy refuses shows
 * the unavailable page. Screenshots go to the app's files, `live-artifacts/`.
 */
@RunWith(AndroidJUnit4::class)
class LiveArtifactDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val dir = File(instrumentation.targetContext.getExternalFilesDir(null), "live-artifacts").apply { mkdirs() }
    private lateinit var scope: CoroutineScope
    private lateinit var daemon: ServerSocket
    private var scenario: ActivityScenario<ComponentActivity>? = null
    private val heads = CopyOnWriteArrayList<String>()

    private val page = """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dev server</title></head>
        <body style="font:18px sans-serif;padding:24px;background:#eef4ff;color:#13233a">
        <h1>Live preview</h1><p>Served at localhost:4191 on the agent's own machine.</p><p id="api">Asking /api…</p>
        <script>fetch('/api/hello').then(r=>r.text()).then(t=>{document.getElementById('api').textContent='/api answered: '+t;document.title='Live: '+t})</script>
        </body></html>
    """.trimIndent().toByteArray()

    /** The agent's socket: the artifact's proxy, the dev server behind it, and a gone artifact's refusal. */
    private fun serve(socket: Socket) {
        val input = socket.getInputStream()
        val output = socket.getOutputStream()
        while (true) {
            val head = StringBuilder()
            while (!head.endsWith("\r\n\r\n")) {
                val byte = input.read()
                if (byte < 0) return
                head.append(byte.toChar())
            }
            val text = head.toString()
            heads += text
            val line = text.substringBefore("\r\n")
            val target = line.split(' ')[1]
            fun answer(status: String, type: String, body: ByteArray) {
                output.write("HTTP/1.1 $status\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\n\r\n".toByteArray() + body)
                output.flush()
            }
            when {
                line.startsWith("CONNECT /v0/artifacts/$LIVE/proxy ") || line.startsWith("CONNECT localhost:4191 ") -> {
                    output.write("HTTP/1.1 200 Connection Established\r\n\r\n".toByteArray())
                    output.flush()
                    continue
                }
                line.startsWith("CONNECT /v0/artifacts/$GONE/proxy ") ->
                    answer("404 Not Found", "application/json", """{"error":"Artifact is not live","code":"not_found"}""".toByteArray())
                target == "/" -> answer("200 OK", "text/html", page)
                target == "/api/hello" -> answer("200 OK", "text/plain", "hello from the site".toByteArray())
                else -> answer("404 Not Found", "text/plain", ByteArray(0))
            }
            return
        }
    }

    private inner class Agent : Transport {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            fun json(text: String) = TransportResponse(200, mapOf("content-type" to "application/json"), text.toByteArray())
            fun version(id: String, number: Int, url: String) = json(
                """{"version":{"artifactId":"$id","number":$number,"title":"Dev server","live":{"url":"$url","networkId":"c-agent1"},"entry":{"path":"index.html","mimeType":"text/html","size":10},"files":[{"path":"index.html","mimeType":"text/html","size":10}]}}""",
            )
            return when (path.substringBefore('?')) {
                "/v0/artifacts/$LIVE" -> json("""{"artifact":{"id":"$LIVE","type":"html","title":"Dev server","latestVersion":2}}""")
                // The pinned version's URL is the dev server; the latest's moved elsewhere.
                "/v0/artifacts/$LIVE/versions/1" -> version(LIVE, 1, "http://localhost:4191/")
                "/v0/artifacts/$LIVE/versions/latest" -> version(LIVE, 2, "http://localhost:4999/")
                "/v0/artifacts/$GONE/versions/latest" -> version(GONE, 1, "http://localhost:4191/")
                else -> TransportResponse(404, body = """{"error":"not in the fixture","code":"not_found"}""".toByteArray())
            }
        }

        override suspend fun socket(): TransportSocket = LocalSocket(Socket(InetAddress.getLoopbackAddress(), daemon.localPort))
        override suspend fun close() {}
    }

    @Before fun setUp() {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        daemon = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        thread(isDaemon = true) {
            while (true) {
                val socket = runCatching { daemon.accept() }.getOrNull() ?: return@thread
                thread(isDaemon = true) { runCatching { serve(socket) }; runCatching { socket.close() } }
            }
        }
    }

    @After fun tearDown() {
        scenario?.close()
        scope.cancel()
        daemon.close()
    }

    private fun open(ref: ArtifactRef) {
        val client = AgentClient(Agent(), "device-token")
        val files = ArtifactClient(client)
        scenario = ActivityScenario.launch(ComponentActivity::class.java).also {
            it.onActivity { activity ->
                activity.enableEdgeToEdge()
                activity.setContent {
                    HappyTheme {
                        val loader = androidx.compose.runtime.remember { ArtifactLoader(files, client, scope, ref).also(ArtifactLoader::load) }
                        val ui by loader.state.collectAsStateWithLifecycle()
                        ArtifactScreen(ref.title, ui, null, "Studio Mac", ArtifactActions(onBack = {}))
                    }
                }
            }
        }
    }

    @Test fun aPinnedLiveVersionOpensItsUrlThroughTheArtifactsProxy() {
        open(ArtifactRef(LIVE, 1, "html", "Dev server", followsLatest = false, pinned = true))
        assertTrue("the site's /api answered the page", device.wait(Until.hasObject(By.textContains("/api answered: hello from the site")), 30_000))
        Thread.sleep(500)
        device.takeScreenshot(File(dir, "live-artifact-loaded.png"))
        val connects = heads.filter { it.startsWith("CONNECT ") }.map { it.substringBefore("\r\n") }
        assertTrue(connects.toString(), connects.all { it == "CONNECT /v0/artifacts/$LIVE/proxy HTTP/1.1" || it == "CONNECT localhost:4191 HTTP/1.1" })
        assertTrue(heads.first { it.startsWith("CONNECT /v0/") }.contains("Authorization: Bearer device-token"))
        // The page's /api is the dev server's, with no daemon credential; no workspace, and not the latest's URL.
        val api = heads.first { it.startsWith("GET /api/hello ") }
        assertFalse(api.contains("device-token"))
        assertFalse(heads.any { it.contains("/v0/workspaces/") || it.contains("/v0/artifacts/$LIVE/api") || it.contains("4999") })
        assertEquals(heads.count { it.startsWith("CONNECT /v0/") }, heads.count { it.startsWith("CONNECT localhost:4191 ") })
    }

    @Test fun anArtifactWhoseProxyRefusesSaysItsComputerIsUnavailable() {
        open(ArtifactRef(GONE, 1, "html", "Dev server", followsLatest = true))
        assertTrue("the unavailable page", device.wait(Until.hasObject(By.text("This Page’s Computer Isn’t Available")), 30_000))
        Thread.sleep(500)
        device.takeScreenshot(File(dir, "live-artifact-unavailable.png"))
        assertFalse(heads.any { it.contains("/v0/workspaces/") || it.startsWith("CONNECT localhost") })
    }

    private companion object {
        const val LIVE = "live1"
        const val GONE = "gone1"
    }
}
