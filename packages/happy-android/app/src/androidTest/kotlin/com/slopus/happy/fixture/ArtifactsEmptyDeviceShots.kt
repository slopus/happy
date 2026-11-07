package com.slopus.happy.fixture

import android.graphics.BitmapFactory
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactCatalogFeed
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.ui.artifacts.ArtifactsScreen
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.emptyFlow
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The empty Artifacts list on a device: the real ArtifactCatalogFeed over a
 * made-up daemon in this test's memory that keeps no artifacts, so the
 * yellow ticket plays over the note. Shot while it plays and once it holds
 * its last frame: the two differ, and the held frame stays. Captured to the
 * test app's files under `device-evidence/artifacts-empty-*.png`.
 */
@RunWith(AndroidJUnit4::class)
class ArtifactsEmptyDeviceShots {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val evidence = File(instrumentation.targetContext.filesDir, "device-evidence").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var scenario: ActivityScenario<ComponentActivity>? = null

    @After fun tearDown() {
        instrumentation.runOnMainSync { scope.cancel() }
        scenario?.close()
    }

    @Test fun capture() = show(dark = false)

    @Test fun captureDark() = show(dark = true)

    // Deliberately no Compose test rule: its synthetic clock stands still while the test sleeps, and so would the ticket.
    private fun show(dark: Boolean) {
        val suffix = if (dark) "-dark" else ""
        val files = ArtifactClient(AgentClient(EmptyDaemon, "fixture"))
        val catalog = ArtifactCatalogFeed(scope, { files.catalog(it) }, { files.artifact(it) }, kept = { null }, keep = {})
        scenario = ActivityScenario.launch(ComponentActivity::class.java).also {
            it.onActivity { activity ->
                activity.enableEdgeToEdge()
                catalog.start(emptyFlow())
                activity.setContent {
                    HappyTheme(preference = if (dark) ThemePreference.Dark else ThemePreference.Light) {
                        ProvideWindowLayout {
                            val state by catalog.state.collectAsState()
                            ArtifactsScreen(state, {}, {})
                        }
                    }
                }
            }
        }
        assertTrue("the note shows", device.wait(Until.hasObject(By.text("No artifacts yet. Ask an agent to make one.")), 10_000))
        // The screen between the bars: nothing but the ticket moves there.
        fun frame(name: String): IntArray {
            val shot = File(evidence, "artifacts-empty-$name$suffix.png")
            device.takeScreenshot(shot)
            val bitmap = BitmapFactory.decodeFile(shot.path)
            val top = bitmap.height / 10
            val height = bitmap.height / 2
            return IntArray(bitmap.width * height).also { bitmap.getPixels(it, 0, bitmap.width, 0, top, bitmap.width, height) }
        }
        SystemClock.sleep(1_000)
        val playing = frame("playing")
        // Three seconds from its in-point to its out-point; then it holds.
        SystemClock.sleep(3_500)
        val held = frame("held")
        val yellow = held.count { (it shr 16 and 0xff) > 200 && (it shr 8 and 0xff) > 180 && (it and 0xff) < 150 }
        assertTrue("the ticket is drawn ($yellow yellow pixels)", yellow > 5_000)
        assertFalse("it moved between the two", playing.contentEquals(held))
        SystemClock.sleep(1_000)
        assertTrue("it holds its last frame", held.contentEquals(frame("held-again")))
    }

    /** A daemon that keeps no artifacts. */
    private object EmptyDaemon : Transport {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse =
            when (path.substringBefore('?')) {
                "/v0/artifacts" -> TransportResponse(200, mapOf("content-type" to "application/json"), """{"artifacts":[],"nextPageCursor":null}""".toByteArray())
                else -> TransportResponse(404, body = """{"error":"not in the fixture","code":"not_found"}""".toByteArray())
            }

        override suspend fun close() {}
    }
}
