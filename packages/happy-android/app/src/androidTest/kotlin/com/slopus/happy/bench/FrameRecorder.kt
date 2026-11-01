package com.slopus.happy.bench

import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.view.FrameMetrics
import android.view.Window
import java.util.Collections
import java.util.Locale

/**
 * Every frame the window renders while recording, from FrameMetrics (what
 * JankStats reads): its whole time from vsync to the GPU's end, the main
 * thread's share (input, animation, measure and layout, recording the draw),
 * and the deadline the display gave it (API 31+, else 60 Hz).
 */
class FrameRecorder(private val window: Window) : Window.OnFrameMetricsAvailableListener {
    /**
     * [waitNs] is from the vsync to the main thread starting the frame (a
     * busy main thread or a late wake), [renderNs] the RenderThread's sync,
     * commands and swap, [gpuNs] the GPU's (API 31+).
     */
    class Frame(val totalNs: Long, val uiNs: Long, val deadlineNs: Long, val first: Boolean, val waitNs: Long = 0, val renderNs: Long = 0, val gpuNs: Long = 0, val vsyncNs: Long = 0)

    private val thread = HandlerThread("frame-metrics").apply { start() }
    private val frames = Collections.synchronizedList(ArrayList<Frame>())

    fun start() {
        frames.clear()
        window.addOnFrameMetricsAvailableListener(this, Handler(thread.looper))
    }

    fun stop(): List<Frame> {
        // Metrics arrive a frame or two late.
        SystemClock.sleep(150)
        window.removeOnFrameMetricsAvailableListener(this)
        return synchronized(frames) { frames.toList() }
    }

    override fun onFrameMetricsAvailable(window: Window, metrics: FrameMetrics, dropCountSinceLastInvocation: Int) {
        val ui = metrics.getMetric(FrameMetrics.INPUT_HANDLING_DURATION) + metrics.getMetric(FrameMetrics.ANIMATION_DURATION) +
            metrics.getMetric(FrameMetrics.LAYOUT_MEASURE_DURATION) + metrics.getMetric(FrameMetrics.DRAW_DURATION)
        val deadline = if (Build.VERSION.SDK_INT >= 31) metrics.getMetric(FrameMetrics.DEADLINE) else 16_666_667L
        val render = metrics.getMetric(FrameMetrics.SYNC_DURATION) + metrics.getMetric(FrameMetrics.COMMAND_ISSUE_DURATION) +
            metrics.getMetric(FrameMetrics.SWAP_BUFFERS_DURATION)
        val gpu = if (Build.VERSION.SDK_INT >= 31) metrics.getMetric(FrameMetrics.GPU_DURATION) else 0L
        frames += Frame(
            metrics.getMetric(FrameMetrics.TOTAL_DURATION), ui, deadline, metrics.getMetric(FrameMetrics.FIRST_DRAW_FRAME) == 1L,
            metrics.getMetric(FrameMetrics.UNKNOWN_DELAY_DURATION), render, gpu, metrics.getMetric(FrameMetrics.INTENDED_VSYNC_TIMESTAMP),
        )
    }
}

/** p50/p90/p99 of whole frames and of their main-thread part, in ms, and the share past the deadline. */
class FrameSummary(frames: List<FrameRecorder.Frame>) {
    val count = frames.size
    private val total = frames.map { it.totalNs / 1e6 }.sorted()
    private val ui = frames.map { it.uiNs / 1e6 }.sorted()
    private val wait = frames.map { it.waitNs / 1e6 }.sorted()
    private val render = frames.map { it.renderNs / 1e6 }.sorted()
    private val gpu = frames.map { it.gpuNs / 1e6 }.sorted()
    private val deadline = frames.map { it.deadlineNs / 1e6 }.sorted()
    private val late = frames.filter { it.totalNs > it.deadlineNs }
    val missed = frames.count { it.totalNs > it.deadlineNs }
    /** JankStats' default: a frame is janky past twice its deadline. */
    val janky = frames.count { it.totalNs > 2 * it.deadlineNs }

    private fun List<Double>.p(q: Double) = if (isEmpty()) Double.NaN else this[((size - 1) * q).toInt()]

    fun line(name: String): String = String.format(
        Locale.US,
        "%-28s frames=%4d total p50=%5.1f p90=%5.1f p99=%5.1f max=%6.1f | ui p50=%5.1f p90=%5.1f p99=%5.1f max=%6.1f | missed=%5.1f%% janky(2x)=%5.1f%%",
        name, count, total.p(0.5), total.p(0.9), total.p(0.99), total.lastOrNull() ?: Double.NaN,
        ui.p(0.5), ui.p(0.9), ui.p(0.99), ui.lastOrNull() ?: Double.NaN,
        if (count == 0) 0.0 else missed * 100.0 / count, if (count == 0) 0.0 else janky * 100.0 / count,
    )

    /** Where the frames' time went: p50 / p90 of the wait before the main thread, RenderThread and GPU, and the deadlines given. */
    fun parts(): String = String.format(
        Locale.US,
        "  parts p50/p90: wait %.1f/%.1f, render %.1f/%.1f, gpu %.1f/%.1f, deadline p10/p50 %.1f/%.1f ms; missed: %s",
        wait.p(0.5), wait.p(0.9), render.p(0.5), render.p(0.9), gpu.p(0.5), gpu.p(0.9), deadline.p(0.1), deadline.p(0.5),
        late.take(6).joinToString(" ") { String.format(Locale.US, "[%.1f>%.1f ui %.1f rt %.1f gpu %.1f]", it.totalNs / 1e6, it.deadlineNs / 1e6, it.uiNs / 1e6, it.renderNs / 1e6, it.gpuNs / 1e6) },
    )
}
