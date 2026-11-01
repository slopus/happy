package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.ConversationKeeper
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * How long a Happy Agent conversation takes from opening to its first
 * frame with messages, with and without the history kept on the phone,
 * over a synthetic agent that answers after a set delay or never. Each
 * case runs five times; the medians go to logcat (`OfflineTiming`) and to
 * `device-evidence/offline-timing.txt` in the test app's files.
 */
@RunWith(AndroidJUnit4::class)
class ConversationOpenTimingTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val app = InstrumentationRegistry.getInstrumentation().targetContext
    private val evidence = File(app.filesDir, "device-evidence").apply { mkdirs() }
    private val keptFile = File(app.cacheDir, "timing-conversation.json")

    /** Sixty runs of a question and a few paragraphs of answer, as the agent and the kept file both have them. */
    private val page: String = buildString {
        append("""{"runs":[""")
        for (n in 0 until 60) {
            if (n > 0) append(',')
            val answer = (1..4).joinToString("\\n\\n") { "Paragraph $it of answer $n, with **some** `code` and a [link](https://example.com)." }
            append("""{"id":"r$n","status":"completed","startedAt":$n,"messages":[""")
            append("""{"id":"u$n","role":"user","createdAt":$n,"content":[{"type":"text","text":"Question $n"}],"metadata":{}},""")
            append("""{"id":"a$n","role":"agent","createdAt":$n,"content":[{"type":"text","text":"$answer"}],"metadata":{}}""")
            append("]}")
        }
        append("""],"hasMore":true}""")
    }

    private val bootstrap = """{"agent":{"id":"timing","workspaceId":"w","status":"idle","title":"Timing"},"mode":null,"draft":null,"pending":[]}"""

    /** The agent: answers after [latencyMillis], or never when null (no network). */
    private fun agent(latencyMillis: Long?): AgentRequest = { _, path, _, _ ->
        if (latencyMillis == null) awaitCancellation()
        delay(latencyMillis)
        val route = path.substringBefore('?')
        val body = when {
            route.endsWith("/bootstrap") -> bootstrap
            route.endsWith("/messages") && "after=" in path -> """{"runs":[],"hasMore":false}"""
            route.endsWith("/messages") -> page
            else -> "{}"
        }
        TransportResponse(200, mapOf("content-type" to "application/json"), body.toByteArray())
    }

    private val fileKeeper = object : ConversationKeeper {
        override fun read(): JsonObject? = keptFile.takeIf { it.exists() }?.readText()?.let { Json.parseToJsonElement(it).jsonObject }
        override fun write(value: JsonObject) = keptFile.writeText(value.toString())
    }

    /** One opening: the agent's delay (null: never) and where the history is kept, if anywhere. */
    private class Trial(val latencyMillis: Long?, val keeper: ConversationKeeper?, val scope: CoroutineScope) {
        @Volatile var shownAt: Long? = null
    }

    private var trial by mutableStateOf<Trial?>(null)
    private var composed = false

    /** Milliseconds from asking for the screen to its first frame with messages; null if none within 5 s. */
    private fun open(latencyMillis: Long?, keeper: ConversationKeeper?): Long? {
        if (!composed) {
            composed = true
            rule.setContent {
                HappyTheme {
                    val current = trial ?: return@HappyTheme
                    val conversation = remember(current) {
                        Conversation(ConversationApi(agent(current.latencyMillis)), emptyFlow(), current.scope, "timing", keeper = current.keeper)
                            .also { it.start() }
                    }
                    val state by conversation.state.collectAsStateWithLifecycle()
                    ConversationScreen(state = state, connection = null, actions = remember { ConversationScreenActions() })
                    LaunchedEffect(current) {
                        snapshotFlow { state.rows.isNotEmpty() }.first { it }
                        withFrameNanos { }
                        current.shownAt = SystemClock.uptimeMillis()
                    }
                }
            }
        }
        val next = Trial(latencyMillis, keeper, CoroutineScope(SupervisorJob() + Dispatchers.Default))
        val startedAt = SystemClock.uptimeMillis()
        rule.runOnUiThread { trial = next }
        val shown = try {
            rule.waitUntil(5_000) { next.shownAt != null }
            next.shownAt!! - startedAt
        } catch (_: Throwable) {
            null
        }
        next.scope.cancel()
        rule.runOnUiThread { trial = null }
        rule.waitForIdle()
        return shown
    }

    private fun median(case: String, times: Int = 5, run: () -> Long?): String {
        open(0, null) // warm up the screen's classes and fonts
        val results = List(times) { run() }
        val shown = results.filterNotNull().sorted()
        val median = if (shown.size == times) "${shown[times / 2]} ms" else "nothing shown (${times - shown.size}/$times never)"
        val line = "$case: $median  ${results.map { it?.toString() ?: "-" }}"
        android.util.Log.i("OfflineTiming", line)
        return line
    }

    @Test
    fun openingWithAndWithoutTheKeptHistory() {
        keptFile.delete()
        // One online open writes the kept history (it is written a second after the read).
        open(0, fileKeeper)
        SystemClock.sleep(1_500)
        assertTrue("kept", keptFile.exists())

        val lines = listOf(
            median("before (agent read every open), agent answers at once") { open(0, null) },
            median("before (agent read every open), agent answers in 600 ms") { open(600, null) },
            median("before (agent read every open), no network") { open(null, null) },
            median("after (kept history first), agent answers in 600 ms") { open(600, fileKeeper) },
            median("after (kept history first), no network") { open(null, fileKeeper) },
        )
        File(evidence, "offline-timing.txt").writeText(lines.joinToString("\n", postfix = "\n"))
    }
}
