package com.slopus.happy.bench

import android.content.Intent
import android.os.Debug
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.genui.Element
import com.slopus.happy.genui.GenUi
import com.slopus.happy.genui.RenderDocument
import com.slopus.happy.genui.Span
import com.slopus.happy.ui.genui.GenUiChatGymActivity
import com.slopus.happy.ui.genui.GenUiHost
import com.slopus.happy.ui.genui.GenUiView
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Locale

/**
 * Gen UI's frame costs in a conversation, for the T04 perf proof. Lines go to
 * logcat under `GenUiBench` and to `genui-bench.txt` in the app's external files.
 *
 * - genui_scroll: GenUiChatGymActivity's 100 rows (an answer and a Gen UI
 *   block under its card each), flung through, against the same rows with
 *   each block as its card and fallback words (`genui.plain`), in
 *   interleaved rounds (`-e rounds N`, 5 by default; ABBA order; `-e plain off`
 *   for Gen UI alone, to compare two builds round by round). Every
 *   round warms the process's read versions first, so only drawing is
 *   measured. Per variant: whole-frame and main-thread percentiles, the main
 *   thread split into animation (recomposition), layout (measure) and draw,
 *   main-thread CPU per frame, and the spread of p90/p99 over rounds.
 * - genui_first_frame: each bundled fixture composed alone at the screen's
 *   width, 7 times, and the frame that composes it split the same way.
 *
 * Run from a build made with -Phappy.debuggable=false (research/telegram-chat.md
 * "Running the benchmark"): a debuggable app runs interpreted.
 */
@RunWith(AndroidJUnit4::class)
class GenUiBenchmark {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val arguments = InstrumentationRegistry.getArguments()
    private val results = File(app.getExternalFilesDir(null), "genui-bench.txt")
    private var open: ActivityScenario<*>? = null

    @After fun stop() {
        open?.close()
    }

    private fun report(line: String) {
        android.util.Log.i("GenUiBench", line)
        results.appendText(line + "\n")
    }

    private fun main(block: () -> Unit) = instrumentation.runOnMainSync(block)

    private fun fling(down: Boolean) {
        val x = device.displayWidth / 2
        val low = device.displayHeight * 4 / 5
        val high = device.displayHeight / 4
        if (down) device.swipe(x, low, x, high, 6) else device.swipe(x, high, x, low, 6)
        SystemClock.sleep(1_600)
    }

    private class Round(val frames: List<FrameRecorder.Frame>, val cpuMs: Double)

    private fun scrollRound(plain: Boolean, window: Float = 0f): Round {
        open?.close()
        val intent = Intent(app, GenUiChatGymActivity::class.java).putExtra("genui.plain", plain).putExtra("genui.window", window)
        val scenario = ActivityScenario.launch<GenUiChatGymActivity>(intent)
        open = scenario
        lateinit var window: android.view.Window
        scenario.onActivity { window = it.window }
        SystemClock.sleep(1_500)
        // Warm: every version read and every row composed once, then back to the top.
        repeat(10) { fling(down = true) }
        repeat(10) { fling(down = false) }
        val recorder = FrameRecorder(window)
        var cpu = 0L
        main {
            recorder.start()
            cpu = Debug.threadCpuTimeNanos()
        }
        repeat(6) { fling(down = true) }
        repeat(6) { fling(down = false) }
        main { cpu = Debug.threadCpuTimeNanos() - cpu }
        val frames = recorder.stop()
        return Round(frames, cpu / 1e6)
    }

    private fun List<Double>.p(q: Double) = if (isEmpty()) Double.NaN else sorted()[((size - 1) * q).toInt()]

    private fun ms(frames: List<FrameRecorder.Frame>, part: (FrameRecorder.Frame) -> Long) = frames.map { part(it) / 1e6 }

    private fun describe(name: String, rounds: List<Round>) {
        val all = rounds.flatMap { it.frames }
        report(FrameSummary(all).line(name))
        fun parts(label: String, part: (FrameRecorder.Frame) -> Long): String {
            val xs = ms(all, part)
            return String.format(Locale.US, "%s p50/p90/p99 %.2f/%.2f/%.2f", label, xs.p(0.5), xs.p(0.9), xs.p(0.99))
        }
        report("  main thread: " + listOf(parts("animation", { it.animationNs }), parts("layout", { it.layoutNs }), parts("draw", { it.drawNs })).joinToString("; "))
        val ui90 = rounds.map { ms(it.frames) { f -> f.uiNs }.p(0.9) }
        val ui99 = rounds.map { ms(it.frames) { f -> f.uiNs }.p(0.99) }
        val total99 = rounds.map { ms(it.frames) { f -> f.totalNs }.p(0.99) }
        val perFrame = rounds.map { it.cpuMs / it.frames.size.coerceAtLeast(1) }
        fun spread(xs: List<Double>) = String.format(Locale.US, "median %.1f (%.1f–%.1f)", xs.p(0.5), xs.min(), xs.max())
        report("  over ${rounds.size} rounds: ui p90 ${spread(ui90)}, ui p99 ${spread(ui99)}, total p99 ${spread(total99)}, main cpu ${String.format(Locale.US, "%.2f", perFrame.p(0.5))} ms/frame (${String.format(Locale.US, "%.2f–%.2f", perFrame.min(), perFrame.max())})")
        val worst = all.sortedByDescending { it.uiNs }.take(8)
        report("  slowest main-thread frames (ui = animation + layout + draw): " + worst.joinToString(" ") { String.format(Locale.US, "[%.1f = %.1f+%.1f+%.1f]", it.uiNs / 1e6, it.animationNs / 1e6, it.layoutNs / 1e6, it.drawNs / 1e6) })
    }

    @Test fun genui_scroll() {
        val count = arguments.getString("rounds")?.toIntOrNull() ?: 5
        // `-e window F`: the other variant is Gen UI with a cache window of F viewports instead of plain rows.
        val window = arguments.getString("window")?.toFloatOrNull() ?: 0f
        val other = if (window > 0f) "window $window" else "plain"
        val gen = ArrayList<Round>()
        val second = ArrayList<Round>()
        report("# genui_scroll ${android.os.Build.MODEL}, $count rounds, ${app.packageName}, against $other")
        repeat(count) { round ->
            // ABBA: neither variant always runs first.
            val order = (if (round % 2 == 0) listOf(false, true) else listOf(true, false)).filter { isOther -> !isOther || arguments.getString("plain") != "off" }
            for (isOther in order) {
                val r = if (isOther && window > 0f) scrollRound(false, window) else scrollRound(isOther)
                (if (isOther) second else gen) += r
                report(FrameSummary(r.frames).line("  round $round ${if (isOther) other else "genui"}"))
            }
        }
        describe("genui scroll", gen)
        if (second.isNotEmpty()) describe("$other scroll", second)
    }

    private var shown by mutableStateOf(false)
    private var which by mutableStateOf<RenderDocument?>(null)
    private var take by mutableIntStateOf(0)

    @Test fun genui_first_frame() {
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        open = scenario
        lateinit var window: android.view.Window
        val host = GenUiHost(cached = { null }, load = { null })
        scenario.onActivity { a ->
            window = a.window
            a.setContent {
                HappyTheme(ThemePreference.Light) {
                    Column(Modifier.fillMaxWidth()) {
                        val document = which
                        if (shown && document != null) key(take) { GenUiView(document, Modifier.fillMaxWidth(), host) }
                    }
                }
            }
        }
        SystemClock.sleep(1_000)
        val fixtures = app.assets.list("genui/fixtures").orEmpty().sorted()
        // `-e strip icons|text`: the same documents without glyphs, or with every text one letter, to attribute the cost.
        val strip = arguments.getString("strip")
        val takes = arguments.getString("takes")?.toIntOrNull() ?: 15
        report("# genui_first_frame ${android.os.Build.MODEL}, ${app.packageName}, strip=$strip: median of $takes (a first take dropped) — main-thread cpu of the composing frame; ui = animation + layout + draw, ms")
        for (name in fixtures) {
            val parsed = GenUi.parse(app.assets.open("genui/fixtures/$name").bufferedReader().use { it.readText() })
            val document = when (strip) {
                "icons" -> withoutIcons(parsed)
                "text" -> withLetters(parsed)
                else -> parsed
            }
            val firsts = ArrayList<FrameRecorder.Frame>()
            val cpu = ArrayList<Double>()
            repeat(takes + 1) { i ->
                main { shown = false }
                SystemClock.sleep(250)
                val recorder = FrameRecorder(window)
                var start = 0L
                main {
                    recorder.start()
                    which = document
                    take = i
                    shown = true
                    start = Debug.threadCpuTimeNanos()
                }
                SystemClock.sleep(300)
                var spent = 0L
                main { spent = Debug.threadCpuTimeNanos() - start }
                val frames = recorder.stop()
                // The first take loads classes and fonts once; the rest are what a row costs.
                if (i > 0) {
                    frames.firstOrNull()?.let(firsts::add)
                    cpu += spent / 1e6
                }
            }
            fun med(part: (FrameRecorder.Frame) -> Long) = ms(firsts, part).p(0.5)
            report(String.format(Locale.US, "  %-24s cpu %5.1f (p25–p75 %4.1f–%4.1f) | ui %5.1f = animation %5.1f + layout %5.1f + draw %4.1f", name.removeSuffix(".json"), cpu.p(0.5), cpu.p(0.25), cpu.p(0.75), med { it.uiNs }, med { it.animationNs }, med { it.layoutNs }, med { it.drawNs }))
        }
    }

    private fun withoutIcons(d: RenderDocument): RenderDocument {
        val icons = d.elements.filterValues { it is Element.Icon }.keys
        return d.copy(
            elements = d.elements.filterKeys { it !in icons }.mapValues { (_, e) ->
                when (e) {
                    is Element.Button -> e.copy(icon = null)
                    is Element.Pill -> e.copy(icon = null)
                    is Element.Box -> e.copy(children = e.children - icons)
                    is Element.Grid -> e.copy(children = e.children - icons)
                    is Element.Press -> e.copy(children = e.children - icons)
                    is Element.Scroll -> e.copy(children = e.children - icons)
                    is Element.Switch -> e.copy(compact = e.compact - icons, regular = e.regular - icons)
                    else -> e
                }
            },
        )
    }

    private fun withLetters(d: RenderDocument): RenderDocument = d.copy(
        elements = d.elements.mapValues { (_, e) ->
            when (e) {
                is Element.Text -> e.copy(spans = listOf(Span("x")))
                is Element.Pill -> e.copy(text = "x")
                is Element.Button -> e.copy(label = "x")
                else -> e
            }
        },
    )
}
