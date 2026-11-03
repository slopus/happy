package com.slopus.happy.ui.call

import android.os.SystemClock
import com.slopus.happy.BuildConfig
import com.slopus.happy.call.CallActivity
import com.slopus.happy.call.CallController
import com.slopus.happy.call.CallProblem
import com.slopus.happy.call.CallState
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.sin

/**
 * Screenshots only, in debug builds: the call's bar drawn from a script,
 * with no microphone, provider or grant. Never a call, and never in a
 * release build (each entry checks [BuildConfig.DEBUG]).
 */
object CallFixtures {
    private val scope = MainScope()
    private var running: Job? = null

    fun show(calls: CallController, name: String) {
        if (!BuildConfig.DEBUG) return
        running?.cancel()
        val since = SystemClock.elapsedRealtime() - 42_000
        val states = mapOf(
            "connecting" to CallState.Connecting,
            "listening" to CallState.Active(CallActivity.Listening, false, since),
            "speaking" to CallState.Active(CallActivity.AgentSpeaking, false, since),
            "user" to CallState.Active(CallActivity.UserSpeaking, false, since),
            "muted" to CallState.Active(CallActivity.Listening, true, since),
            "ended" to CallState.Ended(CallProblem.Connection),
            "limit" to CallState.Ended(CallProblem.LimitReached),
        )
        val script: List<Pair<CallState, Long>> = if (name == "cycle") {
            listOf(
                CallState.Connecting to 2_000L, states.getValue("listening") to 2_000L, states.getValue("speaking") to 4_000L,
                states.getValue("user") to 3_000L, states.getValue("muted") to 2_000L, CallState.Idle to 2_000L,
                states.getValue("speaking") to 3_000L, CallState.Idle to 1_000L,
            )
        } else {
            listOf((states[name] ?: return) to Long.MAX_VALUE)
        }
        running = scope.launch {
            var phase = 0.0
            for ((state, millis) in script) {
                val until = if (millis == Long.MAX_VALUE) Long.MAX_VALUE else SystemClock.elapsedRealtime() + millis
                val speaking = state is CallState.Active && state.activity != CallActivity.Listening && !state.muted
                if (state == CallState.Idle) calls.close()
                while (SystemClock.elapsedRealtime() < until) {
                    phase += 0.12
                    if (state != CallState.Idle) calls.showFixture(state, if (speaking) (0.7 + 0.6 * sin(phase) * sin(phase * 0.37)).toFloat() else 0f)
                    delay(100)
                }
            }
        }
    }
}
