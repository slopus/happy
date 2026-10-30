package com.slopus.happy.fixture

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.SystemClock
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.InputDevice
import android.view.MotionEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.InternalComposeUiApi
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.conversation.Activity
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Presentation
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.connection.AgentHomeList
import com.slopus.happy.ui.connection.agentHomeItems
import com.slopus.happy.ui.connection.AgentHomeTags
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.conversation.ConversationScreenTags
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import kotlin.random.Random

/**
 * Hard flings over a long agent home and a long conversation while the
 * fixture keeps changing underneath, measured two ways and logged under
 * `ScrollEvidence`:
 *  - `dumpsys gfxinfo` for the app, reset before each screen's flings (janky
 *    share, 90th and 99th percentile frame time), without the motion recorder;
 *  - in a separate pass, the list's movement each frame, read from where the
 *    on-screen rows sit (the semantics tree) just before each draw. A
 *    fling should move one way, slowing; reversals and isolated still
 *    frames are logged, with the complete samples saved for analysis.
 *
 * Every row, message and picture is synthetic and in memory. Nothing here
 * talks to an agent, and no account is touched.
 * Pass `-e updates off` to keep the same initial content without fixture
 * updates. Raw gfxinfo, motion CSVs and a still are saved under the target
 * app's external files directory. Run on an explicitly assigned test AVD.
 */
@RunWith(AndroidJUnit4::class)
class ScrollFlingTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val updates = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var scenario: ActivityScenario<ComponentActivity>? = null
    private lateinit var decor: View

    @After fun stop() {
        instrumentation.runOnMainSync { updates.cancel() }
        scenario?.close()
    }

    // Deliberately no Compose test rule: its synthetic animation clock does
    // not advance with native input and makes an inertial fling look still.
    private fun content(block: @Composable () -> Unit) {
        scenario = ActivityScenario.launch(ComponentActivity::class.java).also {
            it.onActivity { activity ->
                decor = activity.window.decorView
                activity.setContent(content = block)
            }
        }
        SystemClock.sleep(1_000)
    }

    @OptIn(InternalComposeUiApi::class)
    private fun root(): RootForTest {
        fun find(view: View): RootForTest? {
            if (view is RootForTest) return view
            if (view is ViewGroup) for (i in 0 until view.childCount) find(view.getChildAt(i))?.let { return it }
            return null
        }
        return checkNotNull(find(decor)) { "No Compose root" }
    }

    private fun find(node: SemanticsNode, predicate: (SemanticsNode) -> Boolean): SemanticsNode? {
        if (predicate(node)) return node
        for (child in node.children) find(child, predicate)?.let { return it }
        return null
    }

    private fun log(line: String) = android.util.Log.i("ScrollEvidence", line)

    // ---- agent home ----

    private val now = 1_755_400_000_000L

    /** 3 bots, 12 tasks, then 6 projects of 10; one in three with subtasks, some two deep. */
    private fun feed(extra: Int, random: Random): AgentFeed {
        val rows = ArrayList<AgentFeedRow>()
        fun conversation(id: String, kind: ConversationKind, depth: Int, parent: String?, children: Int): AgentFeedRow.Conversation {
            return AgentFeedRow.Conversation(
                agentId = id, title = "Synthetic conversation $id about the login flow",
                kind = kind, detail = if (id.hashCode() % 5 == 0) "workspace-$id" else null, depth = depth, avatarId = id,
                working = random.nextInt(6) == 0, unread = random.nextInt(5) == 0, blocked = random.nextInt(17) == 0,
                activityAt = now - random.nextLong(3_600_000L * 48), parentId = parent, childCount = children,
            )
        }
        fun withSubtasks(prefix: String, kind: ConversationKind, index: Int) {
            val subtasks = if (index % 3 == 0) 2 + (if (index == 0 || index == 3) extra else 0) else 0
            val deep = if (index % 6 == 0) 1 else 0
            val parent = conversation("$prefix-$index", kind, 0, null, subtasks + deep)
            rows += parent
            repeat(subtasks) { i ->
                val child = conversation("${parent.agentId}-child-$i", ConversationKind.Subtask, 1, parent.agentId, if (i == 0) deep else 0)
                rows += child
                if (i == 0) repeat(deep) { rows += conversation("${child.agentId}-deep-$it", ConversationKind.Subtask, 2, child.agentId, 0) }
            }
        }
        rows += AgentFeedRow.Section(AgentFeedSection.Bots)
        repeat(3) { withSubtasks("bot", ConversationKind.Bot, it + 1) }
        rows += AgentFeedRow.Section(AgentFeedSection.Tasks)
        repeat(12) { withSubtasks("task", ConversationKind.Task, it) }
        repeat(6) { p ->
            rows += AgentFeedRow.Section(AgentFeedSection.Project("p$p", "Project $p", null, p == 0))
            repeat(10) { withSubtasks("project-$p", ConversationKind.Project, it) }
        }
        return AgentFeed(loaded = true, rows = rows)
    }

    @OptIn(InternalComposeUiApi::class)
    @Test fun agent_home() {
        var feed by mutableStateOf(feed(0, Random(1)))
        val accounts = AccountMenu(listOf(AccountMenuEntry("fx-connection", "Fixture", agent = true, active = true)))
        content {
            HappyTheme { AgentHomeScreen("Fixture", feed, AgentLinkStatus.Connected, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}), now = now) }
        }
        // Open the parents on the first screen, so subtasks two deep are among the rows.
        val opened = HashSet<String>()
        repeat(4) {
            instrumentation.runOnMainSync {
                find(root().semanticsOwner.unmergedRootSemanticsNode) { node ->
                    val tag = node.config.getOrNull(SemanticsProperties.TestTag)
                    tag?.startsWith("agentHome.toggle.") == true && tag !in opened
                }?.let { node ->
                    opened += node.config[SemanticsProperties.TestTag]
                    check(node.config[SemanticsActions.OnClick].action?.invoke() == true)
                }
            }
            SystemClock.sleep(300)
        }
        log("home: opened ${opened.size} parents")
        log("home: ${feed.rows.size} feed rows")
        // A stress case: every 100ms all row indicators change, every 700ms
        // expanded parents gain or lose subtasks. IDs survive those changes.
        val random = Random(7)
        val churn = churn {
            var extra = 0
            var ticks = 0
            while (isActive) {
                delay(100)
                ticks++
                if (ticks % 7 == 0) extra = (extra + 1) % 3
                feed = feed(extra, random)
            }
        }
        measure("home", AgentHomeTags.LIST, reverse = false)
        instrumentation.runOnMainSync { churn.cancel() }
    }

    // ---- conversation ----

    private fun picture(width: Int, height: Int, label: String): Block.Image {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        Canvas(bitmap).apply {
            drawColor(Color.rgb(60, 110, 160))
            drawText(label, 20f, height / 2f, Paint().apply { color = Color.WHITE; textSize = height / 6f })
        }
        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        return Block.Image("image/png", Base64.encodeToString(bytes, Base64.NO_WRAP))
    }

    private val markdown = """
        ## Step %d
        The callback rewrites the URL **before** the cookie is written, so the *next* request has no session.

        - check `setSession` runs first
        - then redirect to `next`
        - keep the [docs](https://example.invalid) in step

        ```kotlin
        suspend fun callback(token: String, next: String) {
            setSession(token)
            redirect(next)
        }
        ```

        > A quote, for the reader who skims.
    """.trimIndent()

    private fun messages(): List<Message> {
        val small = picture(480, 320, "FIXTURE")
        val large = picture(1600, 1200, "FIXTURE LARGE")
        val out = ArrayList<Message>()
        for (i in 0 until 40) {
            out += Message("u$i", "user", i * 2L, listOf(Block.Text("Synthetic question $i: why does the login page loop back to itself?")))
            val blocks = ArrayList<Block>()
            if (i % 3 == 0) blocks += Block.Reasoning("Thinking about the redirect in step $i.")
            if (i % 2 == 0) blocks += Block.ToolCall("c$i", "Bash", "completed", Presentation.Command("grep -rn redirect sources/auth", "sources/auth/callback.ts:12: redirect(next)"))
            blocks += Block.Text(markdown.format(i))
            if (i % 5 == 0) blocks += if (i % 10 == 0) large else small
            out += Message("a$i", "agent", i * 2L + 1, blocks)
        }
        return out
    }

    @Test fun conversation() {
        val builder = ConversationRowBuilder()
        val history = messages()
        val agent = AgentInfo("fx-agent", "fx-workspace", null, "Fixture chat", "working", null, null, now, now, 0, 0)
        fun state(stream: String): ConversationState {
            val streaming = Message("a-live", "agent", 1_000, listOf(Block.Text(stream)))
            val rows = (history + streaming).flatMap { builder.rows(it, "fx-agent", null, it.id == "a-live") }
            return ConversationState(created = true, loaded = true, rows = rows.asReversed(), agent = agent, working = true, activity = Activity.Working)
        }
        var state by mutableStateOf(state("Starting"))
        val actions = ConversationScreenActions()
        content { HappyTheme { ConversationScreen(state, null, actions) } }
        log("conversation: ${state.rows.size} rows")
        // While it scrolls: the newest answer streams a few words every 100ms.
        val churn = churn {
            val words = StringBuilder("Streaming")
            while (isActive) {
                delay(100)
                words.append(" word").append(words.length % 13)
                state = state(words.toString())
            }
        }
        // Newest at the bottom: into history is a swipe down.
        measure("conversation", ConversationScreenTags.LIST, reverse = true)
        instrumentation.runOnMainSync { churn.cancel() }
    }

    /** Same starting key/offset, input and timed removal for placement A/B. */
    @Test fun home_removal_during_fling() {
        val initial = feed(2, Random(1))
        val expanded = initial.conversations.filter { it.childCount > 0 }.map { it.agentId }.toSet()
        var current by mutableStateOf(initial)
        val list = LazyListState(firstVisibleItemIndex = 70, firstVisibleItemScrollOffset = 24)
        content {
            HappyTheme {
                AgentHomeList(agentHomeItems(current, expanded), list, now, {}, {}, PaddingValues(0.dp), Modifier)
            }
        }
        fun describe() = "first=${list.firstVisibleItemIndex}:${list.firstVisibleItemScrollOffset}, scrolling=${list.isScrollInProgress}, " +
            "visible=${list.layoutInfo.visibleItemsInfo.joinToString { "${it.key}@${it.offset}" }}"
        val events = ArrayList<String>()
        fun event(message: String) {
            val line = "${System.nanoTime()} $message ${describe()}"
            events += line
            log("paired: $line")
        }
        instrumentation.runOnMainSync { event("initial") }
        check(device.takeScreenshot(java.io.File(app.getExternalFilesDir(null), "scroll-home-paired-before.png")))
        val indicators = churn {
            var tick = 0
            while (isActive) {
                delay(100)
                tick++
                current = current.copy(rows = current.rows.mapIndexed { index, row ->
                    if (row is AgentFeedRow.Conversation && index % 17 == tick % 17) row.copy(working = !row.working) else row
                })
            }
        }
        lateinit var trace: FrameTrace
        instrumentation.runOnMainSync { trace = FrameTrace(AgentHomeTags.LIST, list); trace.start() }
        shell("dumpsys gfxinfo ${app.packageName} reset")
        fixedFling(trace, onReleased = {
            updates.launch {
                event("released")
                delay(300)
                val removed = current.conversations.filter { it.agentId.endsWith("-child-2") || it.agentId.endsWith("-child-3") }
                event("before-removal ids=${removed.joinToString { it.agentId }}")
                val ids = removed.map { it.agentId }.toSet()
                val counts = removed.groupingBy { it.parentId }.eachCount()
                current = current.copy(rows = current.rows.mapNotNull { row ->
                    if (row is AgentFeedRow.Conversation) {
                        if (row.agentId in ids) null else row.copy(childCount = row.childCount - (counts[row.agentId] ?: 0))
                    } else row
                })
                event("removal-published")
            }
        })
        instrumentation.runOnMainSync { trace.stop(); indicators.cancel(); event("finished") }
        trace.report("home-paired", gestureCount = 1, requireBothDirections = false)
        java.io.File(app.getExternalFilesDir(null), "scroll-home-paired-events.txt").writeText(events.joinToString("\n"))
        java.io.File(app.getExternalFilesDir(null), "scroll-home-paired-gfx.txt").writeText(shell("dumpsys gfxinfo ${app.packageName} framestats"))
        check(device.takeScreenshot(java.io.File(app.getExternalFilesDir(null), "scroll-home-paired.png")))
    }

    private fun fixedFling(trace: FrameTrace, onReleased: () -> Unit) {
        val x = device.displayWidth / 2f
        val high = device.displayHeight / 4f
        val low = device.displayHeight * 4 / 5f
        val down = SystemClock.uptimeMillis()
        val stepMillis = InstrumentationRegistry.getArguments().getString("touchStepMs")?.toLong() ?: 24L
        val touches = ArrayList<String>()
        trace.gesture(0, 1)
        for (step in 0..13) {
            val time = down + step * stepMillis
            val delay = time - SystemClock.uptimeMillis()
            if (delay > 0) SystemClock.sleep(delay)
            val action = when (step) { 0 -> MotionEvent.ACTION_DOWN; 13 -> MotionEvent.ACTION_UP; else -> MotionEvent.ACTION_MOVE }
            val y = high + (low - high) * minOf(step, 12) / 12f
            val event = MotionEvent.obtain(down, time, action, x, y, 0).apply { source = InputDevice.SOURCE_TOUCHSCREEN }
            check(instrumentation.uiAutomation.injectInputEvent(event, true))
            event.recycle()
            touches += "$time,${SystemClock.uptimeMillis()},$action,$x,$y"
        }
        trace.released()
        onReleased()
        SystemClock.sleep(2_500)
        java.io.File(app.getExternalFilesDir(null), "scroll-home-paired-touch.csv").writeText("eventUptimeMs,injectedUptimeMs,action,x,y\n" + touches.joinToString("\n"))
    }

    // ---- measuring ----

    private fun churn(block: suspend CoroutineScope.() -> Unit): Job = updates.launch {
        if (InstrumentationRegistry.getArguments().getString("updates") != "off") block()
    }

    private fun fling(away: Boolean, reverse: Boolean, trace: FrameTrace? = null, number: Int = 0) {
        val x = device.displayWidth / 2
        val low = device.displayHeight * 4 / 5
        val high = device.displayHeight / 4
        // Away from the start of the list: content moves up, or down in a reversed list.
        val up = away != reverse
        trace?.gesture(number, if (up) -1 else 1)
        if (up) device.swipe(x, low, x, high, 12) else device.swipe(x, high, x, low, 12)
        trace?.released()
        SystemClock.sleep(2_500)
    }

    private fun flings(reverse: Boolean, trace: FrameTrace? = null) {
        repeat(3) { fling(away = true, reverse = reverse, trace, it) }
        repeat(3) { fling(away = false, reverse = reverse, trace, it + 3) }
    }

    private fun shell(command: String): String = device.executeShellCommand(command)

    private fun measure(name: String, listTag: String, reverse: Boolean) {
        // Pass 1: frame times alone.
        shell("dumpsys gfxinfo ${app.packageName} reset")
        SystemClock.sleep(500)
        flings(reverse)
        val gfx = shell("dumpsys gfxinfo ${app.packageName} framestats")
        java.io.File(app.getExternalFilesDir(null), "scroll-$name-gfx.txt").writeText(gfx)
        gfx.lines().filter { line ->
            listOf("Total frames rendered", "Janky frames", "50th percentile", "90th percentile", "95th percentile", "99th percentile",
                "Number Missed Vsync", "Number High input latency", "Number Slow UI thread", "Number Slow bitmap uploads", "Number Slow issue draw commands",
                "Number Frame deadline missed").any { line.trim().startsWith(it) }
        }.distinct().forEach { log("$name gfx: ${it.trim()}") }
        // Pass 2: where the rows are, every frame.
        lateinit var trace: FrameTrace
        instrumentation.runOnMainSync { trace = FrameTrace(listTag); trace.start() }
        SystemClock.sleep(500)
        flings(reverse, trace)
        instrumentation.runOnMainSync { trace.stop() }
        trace.report(name)
        check(device.takeScreenshot(java.io.File(app.getExternalFilesDir(null), "scroll-$name.png")))
    }

    private data class Sample(val frame: Long, val gesture: Int, val direction: Int, val released: Boolean, val delta: Float,
        val shared: Int, val atStart: Boolean, val atEnd: Boolean, val index: Int?, val offset: Int?, val scrolling: Boolean?)

    /** Each frame, how far the rows on screen moved since the last one: the median over the rows on both frames. */
    @OptIn(InternalComposeUiApi::class)
    private inner class FrameTrace(private val listTag: String, private val state: LazyListState? = null) : ViewTreeObserver.OnPreDrawListener {
        private val root = root()
        private var running = false
        private var last: Map<String, Float>? = null
        private val samples = ArrayList<Sample>()
        private val rowPositions = ArrayList<String>()
        private var atStart = false
        private var atEnd = false
        @Volatile private var gesture = -1
        @Volatile private var direction = 0
        @Volatile private var releaseTime = Long.MAX_VALUE

        fun gesture(number: Int, sign: Int) { direction = sign; releaseTime = Long.MAX_VALUE; gesture = number }
        fun released() { releaseTime = System.nanoTime() }

        fun start() { running = true; decor.viewTreeObserver.addOnPreDrawListener(this) }
        fun stop() { running = false; decor.viewTreeObserver.removeOnPreDrawListener(this) }

        private fun positions(): Map<String, Float> {
            val list = find(root.semanticsOwner.unmergedRootSemanticsNode) ?: return emptyMap()
            // Axis range is only used for exact boundary flags, never to
            // estimate movement: variable-height rows make its value jump.
            list.config.getOrNull(SemanticsProperties.VerticalScrollAxisRange)?.let {
                atStart = it.value() == 0f
                atEnd = it.value() == it.maxValue()
            }
            val out = HashMap<String, Float>()
            // Reusable offscreen slots can retain semantics and stale
            // coordinates. The paired run records only placed visible keys.
            val placedKeys = state?.layoutInfo?.visibleItemsInfo?.map { it.key.toString() }?.toSet()
            fun walk(node: SemanticsNode) {
                node.children.forEach { child ->
                    val tag = child.config.getOrNull(SemanticsProperties.TestTag)
                    if (listTag == AgentHomeTags.LIST) {
                        if (tag?.startsWith("agentHome.row.") == true &&
                            (placedKeys == null || tag.removePrefix("agentHome.row.") in placedKeys)) out[tag] = child.positionInRoot.y
                    } else {
                        // Including text in the identity rejects a reused
                        // semantics node whose content changed this frame.
                        val text = child.config.getOrNull(SemanticsProperties.Text)?.hashCode()
                        out["${child.id}:$tag:$text"] = child.positionInRoot.y
                    }
                    walk(child)
                }
            }
            walk(list)
            return out
        }

        private fun find(node: SemanticsNode): SemanticsNode? {
            if (node.config.getOrNull(SemanticsProperties.TestTag) == listTag) return node
            for (child in node.children) find(child)?.let { return it }
            return null
        }

        override fun onPreDraw(): Boolean {
            if (!running) return true
            // Read after layout, immediately before the frame draws. A
            // Choreographer callback can run before Compose layout and
            // falsely turn one moving frame into a zero then doubled step.
            val frameTimeNanos = System.nanoTime()
            val now = positions()
            if (state != null) {
                val layout = state.layoutInfo.visibleItemsInfo.associate { it.key.toString() to it.offset }
                now.forEach { (key, y) -> rowPositions += "$frameTimeNanos,$key,$y,${layout[key.removePrefix("agentHome.row.")]}" }
            }
            last?.let { before ->
                val moved = now.keys.filter { it in before }.map { now.getValue(it) - before.getValue(it) }.sorted()
                samples += Sample(frameTimeNanos, gesture, direction, frameTimeNanos >= releaseTime,
                    if (moved.isEmpty()) Float.NaN else moved[moved.size / 2], moved.size, atStart, atEnd,
                    state?.firstVisibleItemIndex, state?.firstVisibleItemScrollOffset, state?.isScrollInProgress)
            }
            last = now
            return true
        }

        fun report(name: String, gestureCount: Int = 6, requireBothDirections: Boolean = true) {
            val csv = "frameNanos,gesture,direction,released,deltaPx,sharedNodes,atStart,atEnd,index,offset,scrolling\n" + samples.joinToString("\n") {
                "${it.frame},${it.gesture},${it.direction},${it.released},${it.delta},${it.shared},${it.atStart},${it.atEnd},${it.index},${it.offset},${it.scrolling}"
            }
            java.io.File(app.getExternalFilesDir(null), "scroll-$name-motion.csv").writeText(csv)
            if (state != null) java.io.File(app.getExternalFilesDir(null), "scroll-$name-positions.csv").writeText("frameNanos,key,y,layoutOffsetPx\n" + rowPositions.joinToString("\n"))
            for (i in 0 until gestureCount) {
                val f = samples.filter { it.gesture == i }
                val tail = f.filter { it.released }
                val moving = tail.filter { kotlin.math.abs(it.delta) >= 1f }
                val against = moving.count { it.delta * it.direction < 0 }
                val offBoundary = moving.count { it.delta * it.direction < 0 && !it.atStart && !it.atEnd }
                val stalls = (1 until tail.lastIndex).count { j ->
                    kotlin.math.abs(tail[j].delta) < 0.5f && tail[j - 1].delta * tail[j + 1].delta > 16f
                }
                val gaps = tail.count { it.delta.isNaN() }
                log("$name fling $i: ${f.size} frames; post-release ${moving.size} moving, $against against direction ($offBoundary off boundary), $stalls isolated stalls, $gaps no-shared; " +
                    "first ${moving.take(5).map { it.delta.toInt() }}, last ${moving.takeLast(5).map { it.delta.toInt() }}")
            }
            val measured = (0 until gestureCount).filter { i ->
                samples.count { it.gesture == i && it.released && !it.atStart && !it.atEnd && kotlin.math.abs(it.delta) >= 1f } >= 10
            }
            check(if (requireBothDirections) measured.count { it < 3 } >= 2 && measured.count { it >= 3 } >= 2 else measured.isNotEmpty()) {
                "Too few inertial flings measured: $measured"
            }
            log("$name trace: ${samples.size} frames sampled after layout, before drawing; CSV saved")
        }
    }
}
