package com.slopus.happy.call

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Debug builds only (iOS `CallProbe`): what a live call heard, said and ran,
 * for the device's live check (`CallLiveDeviceCheck`). Words and tool calls,
 * never the agent's ID or a token. Release builds never call it.
 */
object CallProbe {
    data class Line(val role: String, val text: String)
    data class Sent(val kind: String, val bytes: Int)
    data class ToolRun(val name: String, val parameters: String, val result: String, val isError: Boolean)

    private val mutableLines = MutableStateFlow<List<Line>>(emptyList())
    val lines: StateFlow<List<Line>> = mutableLines.asStateFlow()
    private val mutableTools = MutableStateFlow<List<ToolRun>>(emptyList())
    val tools: StateFlow<List<ToolRun>> = mutableTools.asStateFlow()

    private val mutableSent = MutableStateFlow<List<Sent>>(emptyList())
    /** Every contextual update and prompt sent, by UTF-8 size. */
    val sent: StateFlow<List<Sent>> = mutableSent.asStateFlow()

    fun sent(kind: String, text: String) {
        mutableSent.value = mutableSent.value + Sent(kind, text.toByteArray(Charsets.UTF_8).size)
    }

    fun reset() {
        mutableSent.value = emptyList()
        mutableLines.value = emptyList()
        mutableTools.value = emptyList()
    }

    fun line(role: String, text: String) {
        mutableLines.value = mutableLines.value + Line(role, text)
        Log.i("HappyCall", "$role: ${text.take(300)}")
    }

    fun tool(call: CallToolCall, result: CallToolResult) {
        val run = ToolRun(call.name, call.parameters.toString(), result.text, result.isError)
        mutableTools.value = mutableTools.value + run
        Log.i("HappyCall", "tool ${run.name} ${run.parameters} -> ${if (run.isError) "error " else ""}${run.result.take(300)}")
    }
}
