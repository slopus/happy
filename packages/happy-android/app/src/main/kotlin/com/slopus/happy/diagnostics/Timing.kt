package com.slopus.happy.diagnostics

import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.os.Trace
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.withFrameNanos
import java.util.concurrent.atomic.AtomicInteger

/**
 * How long connecting takes, from process start or the last foreground to a
 * live chat: one logcat line per phase (tag `HappyTiming`,
 * `phase=<name> t=<elapsedRealtime> since_start=<ms> since_foreground=<ms>`
 * and details), and [Span]s as async slices in Perfetto. Times are
 * [SystemClock.elapsedRealtime] ms; since_foreground is -1 before the first
 * foreground. `tools/bench/connection-timing.py` runs the scenarios and reads them.
 * Nothing here names an address or an agent.
 */
object Timing {
    private const val TAG = "HappyTiming"
    // Null in a plain JVM test (LivePairingTest), whose android.jar is stubs: there it marks nothing.
    private val started: Long? = try { Process.getStartElapsedRealtime() } catch (_: RuntimeException) { null }
    @Volatile private var foregroundAt = -1L
    private val cookies = AtomicInteger()

    fun now(): Long = if (started == null) 0 else SystemClock.elapsedRealtime()

    fun foreground() {
        foregroundAt = now()
        mark("foreground", at = foregroundAt)
    }

    fun mark(phase: String, detail: String = "", at: Long = now()) {
        val start = started ?: return
        val foreground = foregroundAt
        val since = if (foreground < 0) -1 else at - foreground
        Log.i(TAG, "phase=$phase t=$at since_start=${at - start} since_foreground=$since${if (detail.isEmpty()) "" else " $detail"}")
    }

    fun begin(phase: String): Span = Span(phase, cookies.incrementAndGet(), now()).also {
        if (started != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) Trace.beginAsyncSection(phase, it.cookie)
    }

    class Span internal constructor(val phase: String, val cookie: Int, val startedAt: Long) {
        /** Marks [phase] where it ended, with how long it took. */
        fun end(detail: String = "") {
            if (started != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) Trace.endAsyncSection(phase, cookie)
            val now = now()
            mark(phase, "dur=${now - startedAt}${if (detail.isEmpty()) "" else " $detail"}", now)
        }
    }
}

/** Marks [phase] each time [shown] becomes true, after the frame that drew it. */
@Composable
fun TimingMark(phase: String, shown: Boolean) {
    LaunchedEffect(shown) {
        if (!shown) return@LaunchedEffect
        withFrameNanos {}
        Timing.mark(phase)
    }
}
