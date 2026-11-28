package com.slopus.happy.call

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Debug builds only (iOS `CallProbe`): what a live call heard, said and ran,
 * for the device's live check (`CallLiveDeviceCheck`). Words and tool calls,
 * never the agent's ID or a token, and only while a live check turns
 * [capture] on: an ordinary call keeps and logs none of it. Release builds
 * never call it.
 */
object CallProbe {
    /** Set by a live device check for its run; off, nothing is kept or logged. */
    @Volatile var capture = false

    data class Line(val role: String, val text: String)
    data class Sent(val kind: String, val bytes: Int, val text: String)
    data class ToolRun(val name: String, val parameters: String, val result: String, val isError: Boolean)

    private val mutableLines = MutableStateFlow<List<Line>>(emptyList())
    val lines: StateFlow<List<Line>> = mutableLines.asStateFlow()
    private val mutableTools = MutableStateFlow<List<ToolRun>>(emptyList())
    val tools: StateFlow<List<ToolRun>> = mutableTools.asStateFlow()

    /** The app's own call while it is live, for a device check to type the person's turns into ([ElevenLabsCallConnection.type]). */
    @Volatile var live: ElevenLabsCallConnection? = null

    private val mutableSent = MutableStateFlow<List<Sent>>(emptyList())
    /** Every contextual update (and the device check's typed turns) sent, with its UTF-8 size. */
    val sent: StateFlow<List<Sent>> = mutableSent.asStateFlow()

    fun sent(kind: String, text: String) {
        if (!capture) return
        mutableSent.value = mutableSent.value + Sent(kind, text.toByteArray(Charsets.UTF_8).size, text)
    }

    fun reset() {
        mutableSent.value = emptyList()
        mutableLines.value = emptyList()
        mutableTools.value = emptyList()
    }

    fun line(role: String, text: String) {
        if (!capture) return
        mutableLines.value = mutableLines.value + Line(role, text)
        Log.i("HappyCall", "$role: ${text.take(300)}")
    }

    fun tool(call: CallToolCall, result: CallToolResult) {
        if (!capture) return
        val run = ToolRun(call.name, call.parameters.toString(), result.text, result.isError)
        mutableTools.value = mutableTools.value + run
        Log.i("HappyCall", "tool ${run.name} ${run.parameters} -> ${if (run.isError) "error " else ""}${run.result.take(300)}")
    }
}
