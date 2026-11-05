package com.slopus.happy.ui.artifacts

import android.view.View
import android.view.inspector.WindowInspector
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactPageMode
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.browser.LocalSocket
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.connection.TransportSocket
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.references.References
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.conversation.ConversationRowActions
import com.slopus.happy.ui.conversation.ConversationRowView
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * An artifact that runs as an app (task_206's fullscreen-spec.md), on a
 * device: a canvas game over a made-up agent that exists only in this
 * test's memory, its files served to the real BrowserProxy by a byte-level
 * fake daemon. Inline it is a card; opened, it is full screen with the bars
 * hidden, never scrolls or zooms, and back or the × closes it and gives the
 * bars back. Screenshots go to the app's files, `app-mode/`.
 */
@RunWith(AndroidJUnit4::class)
class ArtifactAppDeviceTest {
    // Not the Compose test rule: its clock would hold the page's frames and the ×'s fade; this one runs in real time.
    private lateinit var scenario: ActivityScenario<ComponentActivity>
    private lateinit var activity: ComponentActivity

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val paddle: String = instrumentation.context.assets.open("app-mode-game.html").use { it.readBytes() }.decodeToString()
    /** The game's `happy-app-close`, if it declares one. */
    @Volatile private var corner: String? = null
    private val game: ByteArray get() = corner?.let { paddle.replace("<title>", "<meta name=\"happy-app-close\" content=\"$it\">\n<title>") }?.toByteArray() ?: paddle.toByteArray()
    private val plain: ByteArray = instrumentation.context.assets.open("plain-page.html").use { it.readBytes() }
    /** The device's name in the screenshots' names (`-e shots android-phone`). */
    private val prefix: String = InstrumentationRegistry.getArguments().getString("shots") ?: "android"
    private val dir = File(instrumentation.targetContext.getExternalFilesDir(null), "app-mode").apply { mkdirs() }
    private lateinit var scope: CoroutineScope
    private lateinit var daemon: ServerSocket
    private var open by mutableStateOf(false)
    private var openPlain by mutableStateOf(false)
    private var closes = 0
    private lateinit var content: @Composable () -> Unit

    /** The chat, in the activity as it is now (a turn makes it again, empty). */
    private fun show() = scenario.onActivity { activity = it; it.enableEdgeToEdge(); it.setContent(content = content) }

    /** The artifact's files, as the computer serves them through the proxy. */
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
            val target = head.toString().substringBefore("\r\n").split(' ')[1]
            val body = when (target) {
                "/v0/artifacts/$ID/versions/1/files/index.html" -> game
                "/v0/artifacts/$PLAIN/versions/1/files/index.html" -> plain
                else -> null
            }
            if (body != null) {
                output.write("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.size}\r\n\r\n".toByteArray() + body)
            } else {
                output.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".toByteArray())
            }
            output.flush()
        }
    }

    private inner class Agent : Transport {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            fun json(text: String) = TransportResponse(200, mapOf("content-type" to "application/json"), text.toByteArray())
            return when (path.substringBefore('?')) {
                "/v0/artifacts/$ID" -> json("""{"artifact":{"id":"$ID","type":"html","title":"Paddle","latestVersion":1,"entry":{"path":"index.html"}}}""")
                "/v0/artifacts/$ID/versions/latest", "/v0/artifacts/$ID/versions/1" -> json(
                    """{"version":{"artifactId":"$ID","number":1,"title":"Paddle","entry":{"path":"index.html","mimeType":"text/html","size":${game.size}},"files":[{"path":"index.html","mimeType":"text/html","size":${game.size}}]}}""",
                )
                "/v0/artifacts/$ID/versions/1/files/index.html" -> TransportResponse(200, mapOf("content-type" to "text/html"), game)
                "/v0/artifacts/$PLAIN/versions/latest", "/v0/artifacts/$PLAIN/versions/1" -> json(
                    """{"version":{"artifactId":"$PLAIN","number":1,"title":"Release notes","entry":{"path":"index.html","mimeType":"text/html","size":${plain.size}},"files":[{"path":"index.html","mimeType":"text/html","size":${plain.size}}]}}""",
                )
                "/v0/artifacts/$PLAIN/versions/1/files/index.html" -> TransportResponse(200, mapOf("content-type" to "text/html"), plain)
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
        val client = AgentClient(Agent(), "device-token")
        val files = ArtifactClient(client)
        val pages = InlinePages(
            prepare = { _, _ -> error("an app is never prepared inline") },
            onOpen = {},
            mode = { id, page -> ArtifactPageMode.of(files, id, page.version, page.entry) },
        )
        scenario = ActivityScenario.launch(ComponentActivity::class.java)
        content = {
            HappyTheme {
                Box(Modifier.fillMaxSize().background(HappyTheme.colors.surface)) {
                    Column(Modifier.safeDrawingPadding().padding(top = 24.dp)) {
                        Text("A chat with an app in it", Modifier.padding(16.dp), color = HappyTheme.colors.text)
                        ConversationRowView(
                            ConversationRow.Artifact("r1", ID, "Paddle", "html", 1, "latest", page = References.Page(1, "index.html")),
                            userMessageBubblePalette(null, HappyTheme.colors.dark),
                            ConversationRowActions(legacy = MessageCallbacks(), onRetryFailure = {}, loadMedia = { ByteArray(0) }, onOpenArtifact = { open = true }, pages = pages),
                        )
                    }
                    if (open) {
                        val loader = remember {
                            ArtifactLoader(files, client, scope, ArtifactRef(ID, 1, "html", "Paddle", followsLatest = true)).also(ArtifactLoader::load)
                        }
                        val ui by loader.state.collectAsStateWithLifecycle()
                        ArtifactScreen("Paddle", ui, null, "Fixture", ArtifactActions(onBack = { closes++; open = false }))
                    }
                    if (openPlain) {
                        val loader = remember {
                            ArtifactLoader(files, client, scope, ArtifactRef(PLAIN, 1, "html", "Release notes", followsLatest = true)).also(ArtifactLoader::load)
                        }
                        val ui by loader.state.collectAsStateWithLifecycle()
                        ArtifactScreen("Release notes", ui, null, "Fixture", ArtifactActions(onBack = { openPlain = false }))
                    }
                }
            }
        }
        show()
    }

    @After fun tearDown() {
        device.setOrientationNatural()
        scenario.close()
        scope.cancel()
        daemon.close()
    }

    private fun shot(name: String) {
        device.waitForIdle()
        device.takeScreenshot(File(dir, "$prefix-$name.png"))
    }

    /** The app's WebView, in the dialog's window. */
    private fun web(): WebView? {
        var found: WebView? = null
        instrumentation.runOnMainSync {
            fun search(view: View): WebView? = when (view) {
                is WebView -> view
                is android.view.ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { search(view.getChildAt(it)) }
                else -> null
            }
            found = WindowInspector.getGlobalWindowViews().firstNotNullOfOrNull(::search)
        }
        return found
    }

    private fun js(script: String): String {
        val view = web() ?: return "no-webview"
        var result = ""
        val done = CountDownLatch(1)
        instrumentation.runOnMainSync { view.evaluateJavascript(script) { result = it; done.countDown() } }
        done.await(5, TimeUnit.SECONDS)
        return result.trim('"')
    }

    private fun waitFor(what: String, timeout: Long = 30_000, check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeout
        while (!check()) {
            if (System.currentTimeMillis() > deadline) throw AssertionError("timed out waiting for $what")
            Thread.sleep(200)
        }
    }

    /** Whether the system bars show over [window]'s content: the activity's or, with [dialog], the app's. */
    private fun barsVisible(dialog: Boolean): Boolean {
        var visible = false
        instrumentation.runOnMainSync {
            val views = WindowInspector.getGlobalWindowViews()
            val view = if (dialog) views.last() else activity.window.decorView
            visible = ViewCompat.getRootWindowInsets(view)?.isVisible(WindowInsetsCompat.Type.statusBars()) == true
        }
        return visible
    }

    /** The ×'s opacity as drawn, from its pixels' brightness against the page's ground. */
    private fun alphaOfClose(): Float {
        val bounds = device.findObject(By.desc("Close"))?.visibleBounds ?: return 0f
        val shot = instrumentation.uiAutomation.takeScreenshot() ?: return 0f
        // The ×'s strokes: the brightest pixel in its middle.
        var brightest = 0
        for (x in bounds.centerX() - 6..bounds.centerX() + 6) for (y in bounds.centerY() - 6..bounds.centerY() + 6) {
            val c = shot.getPixel(x, y)
            brightest = maxOf(brightest, (((c shr 16) and 0xFF) + ((c shr 8) and 0xFF) + (c and 0xFF)) / 3)
        }
        return if (brightest > 200) 1f else 0f
    }

    private fun openApp() {
        device.findObject(By.text("Open")).click()
        var seen = ""
        try {
            waitFor("the app's page") { js("document.documentElement.getAttribute('data-happy-page-mode') + ' ' + location.href").also { seen = it }.startsWith("app ") }
        } catch (e: AssertionError) {
            shot("failed-open")
            throw AssertionError("${e.message}: last saw $seen, open=$open, closes=$closes")
        }
        // Its first frames drawn.
        Thread.sleep(1_000)
        // The viewport units are the page's height (a WebView that wraps its content gives 0).
        assertEquals("true", js("(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;height:100dvh'; document.body.append(d); const h = d.getBoundingClientRect().height; d.remove(); return String(Math.abs(h - innerHeight) < 1); })()"))
    }

    @Test fun anAppOpensFullScreenNeverScrollsAndBackOrCloseLeaves() {
        // Inline: a card that says App and Open, never a live page.
        waitFor("the card") { device.hasObject(By.text("Open")) }
        assertTrue(device.hasObject(By.text("App")))
        assertNotNull(device.hasObject(By.text("Paddle")))
        shot("01-inline-card")
        assertTrue("bars before", barsVisible(dialog = false))

        openApp()
        assertFalse("bars hidden in the app", barsVisible(dialog = true))
        assertTrue(device.hasObject(By.desc("Close")))
        shot("02-open")

        // A drag, a fling and a pinch over the game: the page neither scrolls nor zooms.
        val (w, h) = device.displayWidth to device.displayHeight
        device.swipe(w / 2, h * 3 / 4, w / 2, h / 4, 10)
        device.swipe(w / 2, h / 4, w / 2, h * 3 / 4, 10)
        device.findObject(By.clazz("android.webkit.WebView"))?.pinchOpen(0.8f)
        device.click(w / 2, h / 2)
        Thread.sleep(150)
        device.click(w / 2, h / 2)
        Thread.sleep(500)
        assertEquals("0", js("String(window.scrollY)"))
        assertEquals("1.00", js("visualViewport.scale.toFixed(2)"))
        assertEquals("true", js("String(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--happy-app-inset-top')) >= 48)"))
        // Past 3 s, the × has faded.
        Thread.sleep(3_500)
        shot("03-faded-after-gestures")

        // A touch near it wakes it.
        val close = device.findObject(By.desc("Close")).visibleBounds
        device.click(close.right + 40, close.bottom + 40)
        Thread.sleep(500)
        shot("04-woken")

        // Back closes it and the bars come back.
        device.pressBack()
        waitFor("closed by back", 10_000) { closes == 1 }
        waitFor("bars back", 5_000) { barsVisible(dialog = false) }
        shot("05-after-back")

        // The × closes it too.
        openApp()
        device.findObject(By.desc("Close")).click()
        waitFor("closed by the ×", 10_000) { closes == 2 }
        waitFor("bars back", 5_000) { barsVisible(dialog = false) }
    }

    /**
     * The page is told the window's unsafe sides as `env(safe-area-inset-*)`
     * gives them, and on top the ×'s room as well: 8 + 32 + 8 more. Run it
     * turned on its side too (`adb shell settings put system user_rotation 1`),
     * where a cutout is on a side.
     */
    @Test fun thePageKnowsTheUnsafeSides() {
        if (InstrumentationRegistry.getArguments().getString("turn") == "left") {
            device.setOrientationLeft()
            Thread.sleep(1_000)
            show()
        }
        waitFor("the card") { device.hasObject(By.text("Open")) }
        openApp()
        fun px(script: String) = js(script).removeSuffix("px").toFloat()
        fun inset(side: String) = px("getComputedStyle(document.documentElement).getPropertyValue('--happy-app-inset-$side')")
        fun env(side: String) = px("getComputedStyle(document.getElementById('probe')).padding${side.replaceFirstChar(Char::uppercase)}")
        val sides = listOf("top", "right", "bottom", "left").associateWith { inset(it) to env(it) }
        android.util.Log.i("ArtifactAppDeviceTest", "insets (ours to env): $sides")
        assertEquals(sides.getValue("top").second + 48f, sides.getValue("top").first, 1f)
        for (side in listOf("right", "bottom", "left")) assertEquals(side, sides.getValue(side).second, sides.getValue(side).first, 1f)
        val side = if (device.displayWidth > device.displayHeight) "landscape" else "portrait"
        Thread.sleep(3_500)
        shot("$side-insets")
        device.pressBack()
        waitFor("closed by back", 10_000) { closes == 1 }
    }

    /**
     * The back gesture from the screen's side closes it at once, bars hidden
     * and all; nothing excludes it. (Hidden with SHOW_TRANSIENT_BARS_BY_SWIPE,
     * no swipe from the side would ever be back.) `-e gesture manual`: the
     * swipe comes from outside, `adb shell input swipe 2 1200 500 1200 250`.
     */
    @Test fun theBackGestureCloses() {
        waitFor("the card") { device.hasObject(By.text("Open")) }
        openApp()
        assertFalse("bars hidden", barsVisible(dialog = true))
        val (w, h) = device.displayWidth to device.displayHeight
        if (InstrumentationRegistry.getArguments().getString("gesture") != "manual") device.swipe(0, h / 2, w / 2, h / 2, 30)
        waitFor("closed by the gesture", 30_000) { closes == 1 }
        waitFor("bars back", 5_000) { barsVisible(dialog = false) }
        shot("07-after-back-gesture")
    }

    /** Steve's set: the card, the app with its × fully there, the × faded, and a normal page for comparison. */
    @Test fun screenshotSet() {
        val (w, h) = device.displayWidth to device.displayHeight
        val side = if (w > h) "landscape" else "portrait"
        waitFor("the card") { device.hasObject(By.text("Open")) }
        shot("$side-1-inline-card")
        openApp()
        assertFalse("bars hidden in the app", barsVisible(dialog = true))
        // A tap in the game, and one near the × so it is fully there whatever the page's load took.
        device.click(w * 2 / 3, h * 2 / 3)
        val close = device.findObject(By.desc("Close")).visibleBounds
        device.click(close.right + 60, close.bottom + 60)
        waitFor("the × awake", 3_000) { alphaOfClose() == 1f }
        Thread.sleep(500)
        shot("$side-2-app-open")
        Thread.sleep(3_800)
        shot("$side-3-app-close-faded")
        device.pressBack()
        waitFor("closed by back", 10_000) { closes == 1 }
        openPlain = true
        waitFor("the normal page") { js("document.readyState") == "complete" }
        Thread.sleep(1_500)
        shot("$side-4-normal-page")
        openPlain = false
    }

    /** Where the page's [selector] is on the screen, in pixels: its middle. */
    private fun centre(selector: String): Pair<Int, Int> {
        val rect = js("(() => { const r = document.querySelector('$selector').getBoundingClientRect(); return (r.left + r.width / 2) + ',' + (r.top + r.height / 2); })()")
        val (x, y) = rect.split(',').map { it.toFloat() * instrumentation.targetContext.resources.displayMetrics.density }
        return x.toInt() to y.toInt()
    }

    /** A short pull down from the screen's top edge. */
    private fun swipeDownFromTheTop() {
        val dp = instrumentation.targetContext.resources.displayMetrics.density
        device.swipe(device.displayWidth / 2, (4 * dp).toInt(), device.displayWidth / 2, (84 * dp).toInt(), 12)
    }

    private fun pageClose() = js("document.documentElement.getAttribute('data-happy-app-close') + ' ' + ['x', 'y', 'width', 'height'].map(s => getComputedStyle(document.documentElement).getPropertyValue('--happy-app-close-' + s)).join(' ')")

    /**
     * The addendum, on whatever device runs it (Steve's set is a tablet on
     * its side): the button in the corner the page asks for, the page told
     * its box, and with `none` no button until a swipe down from the top.
     * The game's own Exit calls `happyApp.close()`.
     */
    @Test fun theCloseButtonGoesWhereThePageAsks() {
        for (where in listOf("top-end", "bottom-start")) {
            corner = where
            waitFor("the card") { device.hasObject(By.text("Open")) }
            openApp()
            val told = pageClose()
            assertTrue(told, told.startsWith("$where ") && told.endsWith("48px 48px"))
            val bounds = device.findObject(By.desc("Close")).visibleBounds
            val (w, h) = device.displayWidth to device.displayHeight
            if (where == "top-end") assertTrue("$bounds", bounds.left > w / 2 && bounds.top < h / 2)
            else assertTrue("$bounds", bounds.left < w / 2 && bounds.top > h / 2)
            device.click(w / 2, h / 2)
            Thread.sleep(400)
            shot("close-$where-open")
            Thread.sleep(3_800)
            shot("close-$where-faded")
            // The game's own exit.
            val (x, y) = centre("#exit")
            device.click(x, y)
            waitFor("closed by happyApp.close()", 10_000) { !open }
        }
        corner = "none"
        waitFor("the card") { device.hasObject(By.text("Open")) }
        openApp()
        val told = pageClose()
        assertEquals("none 0px 0px 0px 0px", told)
        assertFalse("no button", device.hasObject(By.desc("Close")))
        shot("close-none-hidden")
        swipeDownFromTheTop()
        // At once, with no wait for an idle the game never has: the swipe itself spends two of the 3 s.
        device.takeScreenshot(File(dir, "$prefix-close-none-revealed.png"))
        assertTrue("the button shown by a swipe down", device.hasObject(By.desc("Close")))
        waitFor("the button gone again", 6_000) { !device.hasObject(By.desc("Close")) }
        // Back always leaves.
        device.pressBack()
        waitFor("closed by back", 10_000) { !open }
    }

    private companion object {
        const val ID = "fxgame"
        const val PLAIN = "fxplain"
    }
}
