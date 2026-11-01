package com.slopus.happy.bench

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Paint
import android.os.Debug
import android.os.SystemClock
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.InternalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.UserDisplay
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.Activity
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ComposerFocus
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Presentation
import com.slopus.happy.ui.chat.AgentMessage
import com.slopus.happy.ui.components.GlassColors
import com.slopus.happy.ui.components.glass
import com.slopus.happy.ui.components.glassSource
import com.slopus.happy.ui.components.rememberGlassSource
import com.slopus.happy.ui.chat.BubblePalette
import com.slopus.happy.ui.chat.ChatList
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.OlderPager
import com.slopus.happy.ui.conversation.ConversationRowActions
import com.slopus.happy.ui.conversation.ConversationRowView
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.conversation.ProseThread
import com.slopus.happy.ui.conversation.Typesetter
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.components.LocalGlassBlur
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Locale

private const val GLASS_DP = 120
private const val GLASS_STEPS = 40

/**
 * The chat's frame costs, for research/telegram-chat.md. Each case logs one
 * line per measurement under `ChatBench` and appends it to
 * `chat-bench.txt` in the app's external files: whole-frame and main-thread
 * p50/p90/p99, the share of frames past their deadline and past twice it
 * (FrameRecorder, what JankStats reads), main-thread CPU, and gfxinfo's own
 * summary beside them.
 *
 * The chat is big. `-e chat recorded` (the default) replays the heaviest
 * real chat on Steve's agent connection, scrambled, from the test APK's
 * assets (HeavyChat.recorded); `-e chat real` a recording pushed to the
 * app's external files as `chat-fixture.json` (real chats are private and
 * never committed); `-e chat stress` HeavyChat.stress, some 3,000 rows.
 *
 * - conversation_*: the real ConversationScreen over that chat: opening it,
 *   long flings through it, an answer streaming at the bottom, older history
 *   arriving under a reader parked at the oldest row (and how far the rows
 *   on screen moved), and the keyboard opening and closing over it.
 * - legacy_scroll: the legacy ChatList over the same messages.
 * - proto_*: 200 of the chat's answers three ways: today's AgentMessage in a
 *   LazyColumn, the prototype CanvasMessage (StaticLayouts built off the
 *   main thread, one draw) in a LazyColumn, and CanvasMessageView in a
 *   RecyclerView, Telegram's structure. proto_*_glass puts the last two
 *   under a glass bar: whether the glass sees each list, and its fling cost.
 *
 * Run from a build made with -Phappy.debuggable=false: a debuggable app runs
 * interpreted and reads two to three times slower. Nothing talks to an agent.
 */
@RunWith(AndroidJUnit4::class)
class ChatListBenchmark {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var scenario: ActivityScenario<ComponentActivity>? = null
    private lateinit var activity: ComponentActivity

    @After fun stop() {
        instrumentation.runOnMainSync { scope.cancel() }
        scenario?.close()
    }

    // ---- fixture ----

    private val now = 1_755_400_000_000L

    private val pictureBytes: ByteArray by lazy {
        val bitmap = Bitmap.createBitmap(1080, 1600, Bitmap.Config.ARGB_8888)
        android.graphics.Canvas(bitmap).apply {
            drawColor(Color.rgb(60, 110, 160))
            drawText("FIXTURE", 40f, 800f, Paint().apply { color = Color.WHITE; textSize = 160f })
        }
        ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }
    private val picture: Block.Image by lazy {
        val small = Bitmap.createScaledBitmap(BitmapFactory.decodeByteArray(pictureBytes, 0, pictureBytes.size), 480, 711, true)
        val bytes = ByteArrayOutputStream().also { small.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        Block.Image("image/png", Base64.encodeToString(bytes, Base64.NO_WRAP))
    }

    private val fixture = File(app.getExternalFilesDir(null), "chat-fixture.json")
    private val chat = InstrumentationRegistry.getArguments().getString("chat") ?: if (fixture.exists()) "real" else "recorded"

    /** `-e glass off` draws every glass as its tint alone, to tell the blur's share of a frame. */
    private val glassBlur: Boolean? = if (InstrumentationRegistry.getArguments().getString("glass") == "off") false else null

    /** `-e updates N`: how many deltas a stream case sends, 20 a second (120 by default; more for a recording). */
    private val updatesWanted = InstrumentationRegistry.getArguments().getString("updates")?.toIntOrNull() ?: 120

    /** `-e theme light` or `dark` draws in that theme whatever the device's, for recordings of both. */
    private val theme = when (InstrumentationRegistry.getArguments().getString("theme")) {
        "light" -> ThemePreference.Light
        "dark" -> ThemePreference.Dark
        else -> ThemePreference.Adaptive
    }

    /** The whole chat, oldest first. */
    private val heavy: List<Message> by lazy {
        val messages = when (chat) {
            "real" -> HeavyChat.replay(fixture)
            "recorded" -> HeavyChat.recorded(instrumentation.context)
            else -> HeavyChat.stress(picture = picture)
        }
        val blocks = messages.flatMap { it.content }
        report(
            "chat $chat: ${messages.size} messages (${messages.count { it.role == "user" }} user), ${blocks.count { it is Block.ToolCall }} tool calls, " +
                "${blocks.count { it is Block.Text }} text blocks of ${blocks.filterIsInstance<Block.Text>().sumOf { it.text.length }} chars, " +
                "${blocks.count { it is Block.Reasoning }} reasoning, ${blocks.count { it is Block.Image }} inline pictures, " +
                "${blocks.count { (it as? Block.ToolCall)?.presentation is Presentation.Media }} presented media",
        )
        messages
    }

    /** The rows' text is laid out as a conversation's lane lays it out: off the main thread, before the screen sees it. */
    private val typesetter by lazy { Typesetter.of(app) }
    private val builder by lazy { ConversationRowBuilder(typesetter = typesetter) }
    private val agent = AgentInfo("fx-agent", "fx-workspace", null, "Fixture chat", "idle", null, null, now, now, 0, 0)

    /**
     * Newest first, as the screen takes them, laid out as the lane would have
     * them (all of them, as a second or so after a chat opens).
     */
    private fun rows(messages: List<Message>): List<ConversationRow> =
        messages.flatMap { builder.rows(it, "fx-agent", null, false) }.asReversed().also(::laidOut)

    /** [rows] laid out on this (instrumentation) thread and the typesetter's lane, as Conversation does; reports the cost. */
    private fun laidOut(rows: List<ConversationRow>) {
        Runtime.getRuntime().gc()
        val native = Debug.getNativeHeapAllocatedSize()
        val heap = Runtime.getRuntime().let { it.totalMemory() - it.freeMemory() }
        val start = Debug.threadCpuTimeNanos()
        val wall = SystemClock.uptimeMillis()
        typesetter.prepare(rows)
        val first = (Debug.threadCpuTimeNanos() - start) / 1e6
        runBlocking { withContext(typesetter.lane) {} }
        val took = SystemClock.uptimeMillis() - wall
        Runtime.getRuntime().gc()
        val nativeMb = (Debug.getNativeHeapAllocatedSize() - native) / 1e6
        val heapMb = (Runtime.getRuntime().let { it.totalMemory() - it.freeMemory() } - heap) / 1e6
        report(String.format(Locale.US, "  laid out off the main thread: %d rows, first screens %.0f ms cpu, all in %d ms; +%.1f MB native, +%.1f MB heap", rows.size, first, took, nativeMb, heapMb))
    }

    private val allRows: List<ConversationRow> by lazy {
        rows(heavy).also { rows ->
            report("  rows: ${rows.size}: " + rows.groupingBy { it::class.simpleName }.eachCount().entries.sortedByDescending { it.value }.joinToString { "${it.key} ${it.value}" })
        }
    }

    /** The newest [fraction] of the chat. */
    private fun conversation(fraction: Double = 1.0, focus: Boolean = false) = ConversationState(
        created = true, loaded = true, agent = agent, hasMore = fraction < 1.0,
        rows = if (fraction >= 1.0) allRows else rows(heavy.takeLast((heavy.size * fraction).toInt())),
        composerFocus = if (focus) ComposerFocus(1, 0) else null,
    )

    private val actions by lazy { ConversationScreenActions(loadMedia = { pictureBytes }) }

    // ---- harness ----

    private fun launch() {
        scenario = ActivityScenario.launch(ComponentActivity::class.java).also {
            it.onActivity { a ->
                activity = a
                a.enableEdgeToEdge()
                a.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            }
        }
    }

    private var shown by mutableStateOf(true)

    /** Content behind a switch, so opening composes inside a frame, as a navigation push does. */
    private fun content(block: @Composable () -> Unit) {
        launch()
        instrumentation.runOnMainSync { activity.setContent { HappyTheme(theme) { CompositionLocalProvider(LocalGlassBlur provides glassBlur) { if (shown) block() } } } }
        SystemClock.sleep(1_500)
    }

    private fun main(block: () -> Unit) = instrumentation.runOnMainSync(block)
    private fun shell(command: String): String = device.executeShellCommand(command)
    private val results = File(app.getExternalFilesDir(null), "chat-bench.txt")

    private fun report(line: String) {
        android.util.Log.i("ChatBench", line)
        results.appendText(line + "\n")
    }

    /** `-e frames dump` writes every recorded frame to files/chat-frames.txt: when, how long, each part, the deadline. */
    private val dumpFrames = InstrumentationRegistry.getArguments().getString("frames") == "dump"

    private fun dump(name: String, frames: List<FrameRecorder.Frame>) {
        val start = frames.firstOrNull()?.vsyncNs ?: 0
        File(app.getExternalFilesDir(null), "chat-frames.txt").appendText(
            "# $name: at ms, total, ui, wait, render, gpu, deadline\n" + frames.joinToString("") {
                String.format(java.util.Locale.US, "%8.1f %6.1f %6.1f %5.1f %5.1f %5.1f %5.1f%s\n", (it.vsyncNs - start) / 1e6, it.totalNs / 1e6, it.uiNs / 1e6, it.waitNs / 1e6, it.renderNs / 1e6, it.gpuNs / 1e6, it.deadlineNs / 1e6, if (it.totalNs > it.deadlineNs) " MISSED" else "")
            },
        )
    }

    /** Runs [block] while recording frames, then logs both summaries. */
    private fun record(name: String, block: () -> Unit): List<FrameRecorder.Frame> {
        val builds = ProseThread.mainBuilds.get()
        shell("dumpsys gfxinfo ${app.packageName} reset")
        val recorder = FrameRecorder(activity.window)
        var mainCpu = 0L
        main {
            recorder.start()
            mainCpu = android.os.Debug.threadCpuTimeNanos()
        }
        val processCpu = android.os.Process.getElapsedCpuTime()
        block()
        main { mainCpu = android.os.Debug.threadCpuTimeNanos() - mainCpu }
        val process = android.os.Process.getElapsedCpuTime() - processCpu
        val frames = recorder.stop()
        FrameSummary(frames).let { report(it.line(name)); report(it.parts()) }
        if (dumpFrames) dump(name, frames)
        // CPU time, unlike wall time, barely moves with a loaded host: the steadier comparison.
        report(String.format(java.util.Locale.US, "  cpu: main %.0f ms (%.2f ms/frame), process %d ms", mainCpu / 1e6, mainCpu / 1e6 / frames.size.coerceAtLeast(1), process))
        val gfx = shell("dumpsys gfxinfo ${app.packageName}")
        val keep = listOf("Total frames rendered", "Janky frames", "50th percentile", "90th percentile", "99th percentile")
        report("  prose laid out on the main thread: ${ProseThread.mainBuilds.get() - builds}")
        report("  gfxinfo: " + gfx.lines().map { it.trim() }.filter { l -> keep.any { l.startsWith(it) } }.distinct().take(5).joinToString("; "))
        return frames
    }

    /** Five opens: the content switched off, then on, each recorded; the first frame is the one that composes it. */
    private fun opens(name: String) {
        val builds = ProseThread.mainBuilds.get()
        val first = ArrayList<FrameRecorder.Frame>()
        val all = ArrayList<FrameRecorder.Frame>()
        val cpu = ArrayList<Double>()
        repeat(5) {
            main { shown = false }
            SystemClock.sleep(800)
            val recorder = FrameRecorder(activity.window)
            var mainCpu = 0L
            main {
                recorder.start()
                mainCpu = android.os.Debug.threadCpuTimeNanos()
                shown = true
            }
            SystemClock.sleep(1_200)
            main { mainCpu = android.os.Debug.threadCpuTimeNanos() - mainCpu }
            cpu += mainCpu / 1e6
            val frames = recorder.stop()
            frames.firstOrNull()?.let(first::add)
            all += frames
        }
        report("  prose laid out on the main thread: ${ProseThread.mainBuilds.get() - builds}")
        report(FrameSummary(first).line("$name open/first"))
        report(FrameSummary(all).line("$name open/all"))
        report("  open main cpu ms: ${cpu.map { String.format(java.util.Locale.US, "%.0f", it) }} median ${String.format(java.util.Locale.US, "%.0f", cpu.sorted()[cpu.size / 2])}")
    }

    /** A hard fling (UiAutomator's 6 steps, about 30 ms over 55% of the screen); [settle] for it to run out. */
    private fun fling(away: Boolean, reverse: Boolean, settle: Long = 2_000) {
        val x = device.displayWidth / 2
        val low = device.displayHeight * 4 / 5
        val high = device.displayHeight / 4
        val up = away != reverse
        if (up) device.swipe(x, low, x, high, 6) else device.swipe(x, high, x, low, 6)
        SystemClock.sleep(settle)
    }

    /** [count] flings into the list, then [count] back, each run out before the next. */
    private fun flings(name: String, reverse: Boolean, count: Int = 3) {
        record("$name scroll") {
            repeat(count) { fling(away = true, reverse = reverse) }
            repeat(count) { fling(away = false, reverse = reverse) }
        }
    }

    @OptIn(InternalComposeUiApi::class)
    private fun root(): RootForTest {
        fun find(view: View): RootForTest? {
            if (view is RootForTest) return view
            if (view is ViewGroup) for (i in 0 until view.childCount) find(view.getChildAt(i))?.let { return it }
            return null
        }
        return checkNotNull(find(activity.window.decorView)) { "No Compose root" }
    }



    /** Where each text on screen sits, by its words. */
    @OptIn(InternalComposeUiApi::class)
    private fun texts(): Map<String, Float> {
        val out = HashMap<String, Float>()
        main {
            fun walk(node: SemanticsNode) {
                node.config.getOrNull(SemanticsProperties.Text)?.joinToString { it.text }?.takeIf { it.length > 20 }?.let { out[it] = node.positionInRoot.y }
                node.children.forEach(::walk)
            }
            walk(root().semanticsOwner.unmergedRootSemanticsNode)
        }
        return out
    }

    // ---- the conversation ----

    @Test fun conversation_open() {
        val state = conversation()
        content { ConversationScreen(state, null, actions) }
        opens("conversation $chat")
    }

    @Test fun conversation_scroll() {
        val state = conversation()
        content { ConversationScreen(state, null, actions) }
        flings("conversation $chat", reverse = true, count = 8)
    }

    @Test fun conversation_stream() {
        val history = allRows
        fun live(text: String) = Message("a-live", "agent", now + 1_000, listOf(Block.Text(text)))
        val lane = Dispatchers.Default.limitedParallelism(1)
        val state = ConversationState(
            created = true, loaded = true, agent = agent, working = true, activity = Activity.Working,
            rows = builder.rows(live("Starting"), "fx-agent", null, true).asReversed() + history,
        )
        content { ConversationScreen(state, null, actions) }
        // About 20 updates a second, a few words each, as an answer streams in; markdown appears as it goes.
        // As Conversation applies a delta: on its own lane, to the streaming block's LiveText alone.
        streams("conversation $chat") { text -> withContext(lane) { check(builder.grow(live(text), 0)) } }
    }

    /** The agent working with nothing streaming, for 5 s: what the bar's shimmering title, status and pulsing dot cost alone. */
    @Test fun conversation_working() {
        val state = conversation().copy(working = true, activity = Activity.Working)
        content { ConversationScreen(state, null, actions) }
        SystemClock.sleep(1_000)
        record("conversation $chat working") { SystemClock.sleep(5_000) }
    }

    /**
     * For recordings of the transcript's motion: the chat, live for `-e seconds N` (60 by default).
     * What is sent in the composer goes in as a message, and an answer arrives 1.2 s later. With
     * `-e drive on` it sends two, reads older and comes back by the jump button itself, for a
     * screen recording made beside it. Frames are summarised at the end.
     */
    @Test fun conversation_motion() {
        var state by mutableStateOf(conversation())
        var sent = 0
        val reply = "Done. The guard now waits for the session cookie before it redirects, so the login page no longer loops."
        val actions = ConversationScreenActions(loadMedia = { pictureBytes }, onSend = { text, _ ->
            val id = "sent${sent++}"
            state = state.copy(rows = listOf(ConversationRow.User("$id:user", id, text, parseMarkdown(text), emptyList(), Delivery.Sending)) + state.rows)
            scope.launch {
                delay(1_200)
                state = state.copy(rows = listOf(ConversationRow.Text("$id-answer:0", reply, parseMarkdown(reply))) + state.rows)
            }
            true
        })
        content { ConversationScreen(state, null, actions) }
        val recorder = FrameRecorder(activity.window)
        main { recorder.start() }
        if (InstrumentationRegistry.getArguments().getString("drive") == "on") {
            // Two sends, each answered; away from the newest end and back by hand; away again and the jump button.
            SystemClock.sleep(2_500)
            for (words in listOf("Ship%sit", "And%sthe%slogout%spage%stoo?")) {
                device.findObject(By.text("Message"))?.click()
                SystemClock.sleep(900)
                device.executeShellCommand("input text $words")
                SystemClock.sleep(700)
                device.findObject(By.desc("Send"))?.click()
                SystemClock.sleep(3_500)
            }
            device.pressBack()
            SystemClock.sleep(1_200)
            val x = device.displayWidth / 2
            val h = device.displayHeight
            device.swipe(x, h / 3, x, h * 2 / 3, 30)
            SystemClock.sleep(2_000)
            device.swipe(x, h * 2 / 3, x, h / 3, 30)
            SystemClock.sleep(2_000)
            device.swipe(x, h / 3, x, h * 2 / 3, 30)
            SystemClock.sleep(2_000)
            device.findObject(By.desc("Jump to latest"))?.click()
            SystemClock.sleep(3_000)
        } else {
            SystemClock.sleep((InstrumentationRegistry.getArguments().getString("seconds")?.toLongOrNull() ?: 60L) * 1_000)
        }
        report(FrameSummary(recorder.stop()).line("conversation $chat motion, $sent sent"))
    }

    @Test fun conversation_older() {
        val pages = listOf(0.34, 0.67, 1.0).map { conversation(it) }
        var state by mutableStateOf(pages[0])
        var asked = 0
        val actions = ConversationScreenActions(loadMedia = { pictureBytes }, onLoadOlder = { asked++ })
        content { ConversationScreen(state, null, actions) }
        for (page in 1 until pages.size) {
            // Into history until the list asks for more, then rest there.
            val wanted = asked + 1
            var tries = 0
            while (asked < wanted && tries++ < 60) fling(away = true, reverse = true, settle = 600)
            SystemClock.sleep(1_000)
            val before = texts()
            record("conversation $chat older page $page") {
                main { state = pages[page] }
                SystemClock.sleep(1_200)
            }
            val after = texts()
            val moved = before.keys.filter { it in after }.map { after.getValue(it) - before.getValue(it) }.sorted()
            report("  older page $page: asked after $tries flings; ${before.size} texts on screen before, ${moved.size} still there, moved px ${moved.firstOrNull()}..${moved.lastOrNull()}")
        }
    }

    @Test fun conversation_ime() {
        val state = conversation(focus = true)
        content { ConversationScreen(state, null, actions) }
        fun imeVisible(): Boolean {
            var visible = false
            main { visible = ViewCompat.getRootWindowInsets(activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true }
            return visible
        }
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (!imeVisible() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100)
        check(imeVisible()) { "The keyboard never opened" }
        SystemClock.sleep(1_000)
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        val seen = ArrayList<Boolean>()
        record("conversation $chat ime") {
            repeat(4) {
                main { controller.hide(WindowInsetsCompat.Type.ime()) }
                SystemClock.sleep(1_500)
                seen += imeVisible()
                main { controller.show(WindowInsetsCompat.Type.ime()) }
                SystemClock.sleep(1_500)
                seen += imeVisible()
            }
        }
        report("  ime visible after each step: $seen")
    }

    /**
     * The glass's steadiness, research/telegram-glass.md's method: a finger
     * held on the transcript moves it 1 px at a time, [GLASS_STEPS] steps,
     * with a screenshot after each. For each band of the bar, D is the mean
     * |frame − previous frame| in 8-bit luma: a steady blur drifts evenly (a
     * low coefficient of variation), an unsteady one sits still and jumps.
     * The first and last screenshots are written to `files/glass-steps-*.png`,
     * so two builds can be compared pixel for pixel.
     */
    @Test fun glass_steps() {
        val state = conversation()
        content { ConversationScreen(state, null, actions) }
        val density = app.resources.displayMetrics.density
        var status = 0
        main { status = ViewCompat.getRootWindowInsets(activity.window.decorView)?.getInsets(WindowInsetsCompat.Type.statusBars())?.top ?: 0 }
        val bands = listOf(
            "status" to (0 until status),
            "title" to (status until status + (32 * density).toInt()),
            "foot" to (status + (32 * density).toInt() until status + (64 * density).toInt()),
            "feather" to (status + (64 * density).toInt() until status + (88 * density).toInt()),
        )
        val x = device.displayWidth / 2f
        var y = device.displayHeight / 2f
        val start = SystemClock.uptimeMillis()
        fun touch(action: Int) = instrumentation.sendPointerSync(android.view.MotionEvent.obtain(start, SystemClock.uptimeMillis(), action, x, y, 0))
        touch(android.view.MotionEvent.ACTION_DOWN)
        // Past the touch slop, so every step after this scrolls by its pixel.
        repeat(10) { y += 6f; touch(android.view.MotionEvent.ACTION_MOVE); SystemClock.sleep(16) }
        SystemClock.sleep(500)
        fun luma(): Array<FloatArray> {
            SystemClock.sleep(250)
            val shot = instrumentation.uiAutomation.takeScreenshot()
            return bands.map { (_, rows) ->
                FloatArray(rows.count() * shot.width).also { out ->
                    var i = 0
                    for (row in rows) for (col in 0 until shot.width) {
                        val c = shot.getPixel(col, row)
                        out[i++] = 0.299f * Color.red(c) + 0.587f * Color.green(c) + 0.114f * Color.blue(c)
                    }
                }
            }.toTypedArray().also { shot.recycle() }
        }
        fun save(name: String) {
            val shot = instrumentation.uiAutomation.takeScreenshot()
            File(app.getExternalFilesDir(null), "glass-steps-$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
            shot.recycle()
        }
        save("first")
        var last = luma()
        val d = bands.map { ArrayList<Double>() }
        repeat(GLASS_STEPS) {
            y += 1f
            touch(android.view.MotionEvent.ACTION_MOVE)
            val now = luma()
            for (b in bands.indices) d[b] += now[b].indices.sumOf { kotlin.math.abs(now[b][it] - last[b][it]).toDouble() } / now[b].size.coerceAtLeast(1)
            last = now
        }
        save("last")
        touch(android.view.MotionEvent.ACTION_UP)
        bands.forEachIndexed { b, (name, rows) ->
            val v = d[b]
            val mean = v.average()
            val sd = kotlin.math.sqrt(v.sumOf { (it - mean) * (it - mean) } / v.size)
            report(String.format(Locale.US, "  glass steps %-8s y %4d-%4d: D mean %.3f max %.3f cv %.2f", name, rows.first, rows.last, mean, v.max(), if (mean > 0) sd / mean else 0.0))
        }
    }

    // ---- the legacy chat ----

    /** The same messages as the legacy reducer's rows: bubbles, answers and tool rows. */
    @Test fun legacy_scroll() {
        val rows = ArrayList<ChatRow>()
        for (message in heavy) {
            message.content.forEachIndexed { i, block ->
                val id = "${message.id}:$i"
                when {
                    block is Block.Text && message.role == "user" ->
                        rows += ChatRow.User(ChatMessage.UserText(id = id, localId = null, createdAt = message.createdAt, text = block.text), UserDisplay.Text(block.text, parseMarkdown(block.text)))
                    block is Block.Text -> rows += ChatRow.AgentText(ChatMessage.AgentText(id, message.createdAt, block.text), parseMarkdown(block.text))
                    block is Block.ToolCall -> {
                        val input = (block.presentation as? Presentation.Command)?.let { buildJsonObject { put("command", JsonPrimitive(it.command)) } } ?: block.arguments
                        rows += ChatRow.Tool(ChatMessage.ToolCallMessage(id, message.createdAt, ToolCall(name = block.name, state = ToolState.Completed, input = input, createdAt = message.createdAt)))
                    }
                }
            }
        }
        report("  legacy rows: ${rows.size}")
        val newestFirst = rows.asReversed()
        val pager = OlderPager { false }
        val bubble = BubblePalette(androidx.compose.ui.graphics.Color(0xFFF0F0F0), androidx.compose.ui.graphics.Color(0xFFDDDDDD), androidx.compose.ui.graphics.Color.Gray)
        content {
            ChatList(newestFirst, hasMoreOlder = false, isLoadingOlder = false, controlledByUser = false, bubble = bubble, callbacks = MessageCallbacks(), pager = pager)
        }
        flings("legacy $chat", reverse = true, count = 8)
    }

    // ---- the prototype ----
    //
    // The host these run on is shared and often loaded, so wall-clock frame
    // times swing run to run. Beside them each case reports main-thread CPU
    // time for a fixed amount of work (a page of fresh rows, one streamed
    // update), which a busy host barely moves.

    /** The chat's own answers, 200 of them (repeated if it has fewer). */
    private val answers by lazy {
        val texts = heavy.filter { it.role == "agent" }.flatMap { m -> m.content.filterIsInstance<Block.Text>().map { it.text } }
        (0 until 200).map { texts[it % texts.size] }
    }
    private val answerRows by lazy { answers.mapIndexed { i, text -> ChatRow.AgentText(ChatMessage.AgentText("a$i", now + i, text), parseMarkdown(text)) } }
    private val palette = CanvasPalette(text = 0xFF000000.toInt(), secondary = 0xFF8E8E93.toInt(), surfaceHighest = 0xFFF0F0F2.toInt(), divider = 0xFFEAEAEA.toInt())
    private val canvasBuilder by lazy {
        CanvasMessageBuilder(app.resources.displayMetrics.density, app.resources.configuration.fontScale, palette)
    }

    /** Every answer laid out on a background thread before the list shows, as Telegram's MessageObject is. */
    private fun canvasLayouts(): List<CanvasMessageLayout> {
        val width = app.resources.displayMetrics.widthPixels
        var layouts: List<CanvasMessageLayout> = emptyList()
        val thread = Thread {
            // Once to warm the code, once to time it.
            answerRows.take(20).forEach { canvasBuilder.build(it.blocks, width) }
            val start = Debug.threadCpuTimeNanos()
            layouts = answerRows.map { canvasBuilder.build(it.blocks, width) }
            val ms = (Debug.threadCpuTimeNanos() - start) / 1e6
            report(String.format(Locale.US, "proto layout off the main thread: %d answers, %.1f ms cpu, %.2f ms each", layouts.size, ms, ms / layouts.size))
        }
        thread.start()
        thread.join()
        return layouts
    }

    /**
     * Jumps a page at a time through the list ([jump] to each row index in
     * turn), one jump a frame's worth apart, so every jump binds rows it has
     * not shown: the cost of fresh rows, Compose's composition and text
     * measure or a View's bind, measure and draw. Reports main-thread CPU per jump.
     */
    private fun jumps(name: String, from: Int, step: Int, jump: (Int) -> Unit) {
        // Warm-up: the first pass through compiles and fills pools.
        for (i in 0 until 30) {
            main { jump(i * step) }
            SystemClock.sleep(40)
        }
        main { jump(0) }
        SystemClock.sleep(500)
        val count = 60
        var cpu = 0L
        val builds = ProseThread.mainBuilds.get()
        val recorder = FrameRecorder(activity.window)
        main { recorder.start() }
        for (i in 0 until count) {
            // Rows from [from] on were never shown in the warm-up.
            main {
                val start = Debug.threadCpuTimeNanos()
                jump(from + i * step)
                cpu += Debug.threadCpuTimeNanos() - start
            }
            // The frame the jump asks for runs here; its CPU is counted by the frame recorder's ui figure.
            SystemClock.sleep(80)
        }
        val frames = recorder.stop()
        report(FrameSummary(frames).line("$name jumps"))
        val ui = frames.sumOf { it.uiNs } / 1e6
        report("  prose laid out on the main thread: ${ProseThread.mainBuilds.get() - builds}")
        report(String.format(Locale.US, "  jumps: %d, main-thread frame work %.1f ms (%.2f ms a jump), call itself %.2f ms a jump", count, ui, ui / count, cpu / 1e6 / count))
    }

    /** An answer growing at the newest end, 20 updates a second, given to [show] each time; main-thread CPU per update. */
    private fun streams(name: String, show: suspend (String) -> Unit) {
        val words = StringBuilder("Streaming the answer")
        var updates = 0
        var mainCpu = 0L
        // The screen as it is while the agent works, before any words: the bar's shimmer and its dot run
        // every frame whatever streams, so what an update costs is what the stream adds to that.
        var idle = 0L
        main { idle = Debug.threadCpuTimeNanos() }
        SystemClock.sleep(IDLE_MILLIS)
        main { idle = Debug.threadCpuTimeNanos() - idle }
        val builds = ProseThread.mainBuilds.get()
        val recorder = FrameRecorder(activity.window)
        var started = 0L
        main {
            recorder.start()
            mainCpu = Debug.threadCpuTimeNanos()
            started = SystemClock.uptimeMillis()
        }
        val job = scope.launch {
            var tick = 0
            while (isActive && tick < updatesWanted) {
                delay(50)
                tick++
                words.append(" word").append(tick % 13)
                if (tick % 25 == 0) words.append("\n\n- a point `code` here\n- another\n\nNext paragraph")
                show(words.toString())
                updates++
            }
        }
        while (job.isActive) SystemClock.sleep(100)
        SystemClock.sleep(300)
        var elapsed = 0L
        main {
            mainCpu = Debug.threadCpuTimeNanos() - mainCpu
            elapsed = SystemClock.uptimeMillis() - started
        }
        val frames = recorder.stop()
        FrameSummary(frames).let { report(it.line("$name stream")); report(it.parts()) }
        report("  prose laid out on the main thread: ${ProseThread.mainBuilds.get() - builds}")
        report(String.format(Locale.US, "  stream: %d updates (final %d chars), main cpu %.0f ms, %.2f ms an update", updates, words.length, mainCpu / 1e6, mainCpu / 1e6 / updates))
        val working = idle / 1e6 / IDLE_MILLIS * elapsed
        report(String.format(Locale.US, "  working screen alone: %.0f ms of main a second; the stream added %.2f ms an update", idle / 1e3 / IDLE_MILLIS, (mainCpu / 1e6 - working) / updates))
    }

    private companion object {
        const val IDLE_MILLIS = 3_000L
    }

    private fun answerRow(text: String) = ChatRow.AgentText(ChatMessage.AgentText("live", now, text), parseMarkdown(text))

    /** Today's AgentMessage: Column, SelectionContainer, MarkdownView's Text per block, the copy button. */
    @Test fun proto_compose_current() {
        val callbacks = MessageCallbacks()
        val list = LazyListState()
        var live by mutableStateOf(answerRow("Starting"))
        content {
            LazyColumn(Modifier.fillMaxSize(), state = list) {
                item(key = "live", contentType = "agent") { AgentMessage(live, callbacks) }
                items(answerRows, key = { it.key }, contentType = { "agent" }) { AgentMessage(it, callbacks) }
            }
        }
        opens("proto compose current")
        jumps("proto compose current", 100, 1) { scope.launch { list.scrollToItem(it) } }
        main { scope.launch { list.scrollToItem(0) } }
        SystemClock.sleep(500)
        // Parsed off the main thread, as the feeds do; Compose measures the text on it.
        streams("proto compose current") { text -> live = withContext(Dispatchers.Default) { answerRow(text) } }
        flings("proto compose current", reverse = false)
    }

    /**
     * The same 200 answers as the conversation draws them now (ConversationRowView's
     * drawn answer: laid out on the lane by the Typesetter, one node a segment, code
     * blocks composed), for the same open, jumps, stream and flings as the two above.
     */
    @Test fun proto_compose_prose() {
        val rows = answers.mapIndexed { i, text -> ConversationRow.Text("p$i:0", text, parseMarkdown(text)) }
        laidOut(rows)
        val actions = ConversationRowActions(MessageCallbacks(), onRetryFailure = {}, loadMedia = { pictureBytes })
        val bubble = BubblePalette(androidx.compose.ui.graphics.Color(0xFFF0F0F0), androidx.compose.ui.graphics.Color(0xFFDDDDDD), androidx.compose.ui.graphics.Color.Gray)
        val list = LazyListState()
        fun liveRow(text: String) = ConversationRow.Text("live:0", text, parseMarkdown(text))
        var live by mutableStateOf(liveRow("Starting").also { laidOut(listOf(it)) })
        content {
            LazyColumn(Modifier.fillMaxSize(), state = list) {
                item(key = "live", contentType = ConversationRow.Text::class) { ConversationRowView(live, bubble, actions) }
                items(rows, key = { it.key }, contentType = { it::class }) { ConversationRowView(it, bubble, actions) }
            }
        }
        opens("proto compose prose")
        jumps("proto compose prose", 100, 1) { scope.launch { list.scrollToItem(it) } }
        main { scope.launch { list.scrollToItem(0) } }
        SystemClock.sleep(500)
        // Parsed and laid out on the lane, as a conversation's row is.
        streams("proto compose prose") { text -> live = withContext(typesetter.lane) { liveRow(text).also { typesetter.prepare(listOf(it)) } } }
        flings("proto compose prose", reverse = false)
    }

    /** The prototype as a Compose item: StaticLayouts built off the main thread, one node, one draw. */
    @Test fun proto_compose_canvas() {
        val layouts = canvasLayouts()
        val width = app.resources.displayMetrics.widthPixels
        val list = LazyListState()
        var live by mutableStateOf(canvasBuilder.build(parseMarkdown("Starting"), width))
        content {
            LazyColumn(Modifier.fillMaxSize(), state = list) {
                item(key = "live", contentType = "agent") { CanvasMessage(live) }
                items(layouts.indices.toList(), key = { it }, contentType = { "agent" }) { CanvasMessage(layouts[it]) }
            }
        }
        opens("proto compose canvas")
        jumps("proto compose canvas", 100, 1) { scope.launch { list.scrollToItem(it) } }
        main { scope.launch { list.scrollToItem(0) } }
        SystemClock.sleep(500)
        // Parsed and laid out off the main thread; the main thread reads a height and draws.
        streams("proto compose canvas") { text -> live = withContext(Dispatchers.Default) { canvasBuilder.build(parseMarkdown(text), width) } }
        flings("proto compose canvas", reverse = false)
    }

    /** The prototype as Telegram has it: a childless View cell in a RecyclerView, hosted in Compose. */
    @Test fun proto_recycler_canvas() {
        val layouts = canvasLayouts()
        val width = app.resources.displayMetrics.widthPixels
        var live = canvasBuilder.build(parseMarkdown("Starting"), width)
        lateinit var recycler: RecyclerView
        val adapter = canvasAdapter(layouts) { live }
        content { CanvasRecycler(adapter, Modifier.fillMaxSize()) { recycler = it } }
        opens("proto recycler canvas")
        jumps("proto recycler canvas", 100, 1) { (recycler.layoutManager as LinearLayoutManager).scrollToPositionWithOffset(it, 0) }
        main { recycler.scrollToPosition(0) }
        SystemClock.sleep(500)
        streams("proto recycler canvas") { text ->
            live = withContext(Dispatchers.Default) { canvasBuilder.build(parseMarkdown(text), width) }
            adapter.notifyItemChanged(0)
        }
        flings("proto recycler canvas", reverse = false)
    }

    private fun canvasAdapter(layouts: List<CanvasMessageLayout>, live: () -> CanvasMessageLayout?) =
        object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            private val first = if (live() != null) 1 else 0
            override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) = object : RecyclerView.ViewHolder(
                CanvasMessageView(parent.context).apply { layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT) },
            ) {}
            override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
                (holder.itemView as CanvasMessageView).message = if (position < first) live() else layouts[position - first]
            }
            override fun getItemCount() = layouts.size + first
        }

    @Composable
    private fun CanvasRecycler(adapter: RecyclerView.Adapter<*>, modifier: Modifier, made: (RecyclerView) -> Unit) {
        AndroidView(
            factory = { context ->
                RecyclerView(context).apply {
                    layoutManager = LinearLayoutManager(context)
                    // No change animation: a streamed update rebinds in place, as ChatListItemAnimator's setSupportsChangeAnimations(false).
                    (itemAnimator as? androidx.recyclerview.widget.SimpleItemAnimator)?.supportsChangeAnimations = false
                    this.adapter = adapter
                    made(this)
                }
            },
            modifier = modifier,
        )
    }

    /**
     * [list] (given the glassSource modifier) under a 120 dp glass bar, as the
     * conversation sits under GlassBarLayout. The tint is light (0.3) so the
     * blurred rows show through it plainly in a screenshot.
     */
    @Composable
    private fun UnderGlass(list: @Composable (Modifier) -> Unit) {
        val source = rememberGlassSource(androidx.compose.ui.graphics.Color.White)
        Box(Modifier.fillMaxSize()) {
            list(Modifier.fillMaxSize().glassSource(source))
            Box(
                Modifier.fillMaxWidth().height(GLASS_DP.dp)
                    .glass(source, RectangleShape, GlassColors(androidx.compose.ui.graphics.Color.White, androidx.compose.ui.graphics.Color.Transparent, alpha = 0.3f), blurs = true),
            )
        }
    }

    /**
     * Whether the glass shows the list under it, live: the glass band's pixels
     * after [scroll] differ from before it. A glass that sees nothing is one
     * flat tint, the same at every scroll position.
     */
    private fun glassSees(name: String, scroll: () -> Unit) {
        val density = app.resources.displayMetrics.density
        val band = (GLASS_DP * density).toInt()
        fun shot(): IntArray {
            SystemClock.sleep(600)
            val bitmap = instrumentation.uiAutomation.takeScreenshot()
            val y0 = band / 2
            return IntArray(bitmap.width) { bitmap.getPixel(it, y0) }.also { bitmap.recycle() }
        }
        val before = shot()
        main { scroll() }
        val after = shot()
        val changed = before.indices.count { before[it] != after[it] }
        val spread = before.map { Color.red(it) + Color.green(it) + Color.blue(it) }.let { it.max() - it.min() }
        report("  $name glass: ${changed * 100 / before.size}% of the band's middle row changed with the scroll; its spread before ${spread}/765 (0 is a flat tint, nothing seen)")
    }

    /** The two prototypes under the glass: whether it sees each, and what it costs a fling. */
    @Test fun proto_compose_glass() {
        val layouts = canvasLayouts()
        val list = LazyListState()
        content {
            UnderGlass { modifier ->
                LazyColumn(modifier, state = list) {
                    items(layouts.indices.toList(), key = { it }, contentType = { "agent" }) { CanvasMessage(layouts[it]) }
                }
            }
        }
        glassSees("proto compose") { scope.launch { list.scrollBy(300f) } }
        flings("proto compose glass", reverse = false)
    }

    @Test fun proto_recycler_glass() {
        val layouts = canvasLayouts()
        lateinit var recycler: RecyclerView
        val adapter = canvasAdapter(layouts) { null }
        content { UnderGlass { modifier -> CanvasRecycler(adapter, modifier) { recycler = it } } }
        glassSees("proto recycler") { recycler.scrollBy(0, 300) }
        flings("proto recycler glass", reverse = false)
    }

    /** The new-mode conversation's own rows (ConversationRowView over the fixture's mix), for the same jump cost. */
    @Test fun proto_rows_current() {
        val rows = allRows.asReversed()
        val actions = ConversationRowActions(MessageCallbacks(), onRetryFailure = {}, loadMedia = { pictureBytes })
        val bubble = BubblePalette(androidx.compose.ui.graphics.Color(0xFFF0F0F0), androidx.compose.ui.graphics.Color(0xFFDDDDDD), androidx.compose.ui.graphics.Color.Gray)
        val list = LazyListState()
        content {
            LazyColumn(Modifier.fillMaxSize(), state = list) {
                items(rows, key = ConversationRow::key, contentType = { it::class }) { ConversationRowView(it, bubble, actions) }
            }
        }
        jumps("proto rows current $chat", 120, 5) { scope.launch { list.scrollToItem(it) } }
    }
}
