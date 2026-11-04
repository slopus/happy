package com.slopus.happy.calendar

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.Problem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/**
 * The visible calendar range, kept separately by range and viewer time zone.
 * A journal change invalidates the read: its occurrences are expanded by the
 * daemon, so partial event patches cannot repair them locally. Desktop's
 * surfaceCalendarStore gathers a burst for 120 ms before rereading. Hidden
 * calendars do no network work; a resumed one reads the range again.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CalendarFeed(
    private val scope: CoroutineScope,
    private val fetch: suspend (CalendarRange) -> JsonObject,
    private val kept: suspend (String) -> JsonObject? = { null },
    private val keep: suspend (String, JsonObject) -> Unit = { _, _ -> },
    private val retryMs: Long = 5_000,
) {
    enum class Status { Loading, Ready, Missing, Unsupported }
    @Immutable
    data class State(val range: CalendarRange? = null, val page: CalendarPage? = null, val status: Status = Status.Loading,
        val reading: Boolean = false, val error: Problem? = null)

    private val stateFlow = MutableStateFlow(State())
    val state: StateFlow<State> = stateFlow.asStateFlow()
    private val confined = Dispatchers.Default.limitedParallelism(1)
    private var visible = false
    private var reading: Job? = null
    private var restored = false

    fun show(range: CalendarRange): Job = scope.launch(confined) {
        if (stateFlow.value.range == range) return@launch
        reading?.cancel()
        restored = false
        stateFlow.value = State(range)
        if (visible) read(range)
    }

    fun resume(): Job = scope.launch(confined) {
        if (visible) return@launch
        visible = true
        stateFlow.value.range?.let { read(it) }
    }

    fun pause(): Job = scope.launch(confined) {
        visible = false
        reading?.cancel()
        reading = null
        stateFlow.value = stateFlow.value.copy(reading = false)
    }

    /** An event for this calendar, or a reconnect. An old in-flight result cannot win. */
    fun invalidate(surfaceId: String? = null): Job = scope.launch(confined) {
        val range = stateFlow.value.range ?: return@launch
        if (!visible || (surfaceId != null && surfaceId != range.surfaceId)) return@launch
        read(range, if (surfaceId == null) 0 else REREAD_DELAY_MS)
    }

    private fun read(range: CalendarRange, after: Long = 0) {
        reading?.cancel()
        reading = scope.launch(confined) {
            if (after > 0) delay(after)
            if (!restored) {
                val page = withContext(Dispatchers.IO) { kept(range.key) }?.let { CalendarPage.parse(it, range.surfaceId) }
                currentCoroutineContext().ensureActive()
                restored = true
                if (page != null) stateFlow.value = State(range, page, Status.Ready)
            }
            while (true) {
                stateFlow.value = stateFlow.value.copy(reading = true)
                try {
                    val answer = fetch(range)
                    currentCoroutineContext().ensureActive()
                    val page = CalendarPage.parse(answer, range.surfaceId)
                        ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
                    // Persist before publication, so navigating away as it appears
                    // cannot cancel the only write of the displayed range.
                    withContext(Dispatchers.IO) { keep(range.key, answer) }
                    currentCoroutineContext().ensureActive()
                    stateFlow.value = State(range, page, Status.Ready)
                    return@launch
                } catch (e: CancellationException) {
                    throw e
                } catch (e: AgentApiException) {
                    val status = when (e.status) { 404, 410 -> Status.Missing; 405, 501 -> Status.Unsupported; else -> null }
                    if (status != null) { stateFlow.value = State(range, status = status); return@launch }
                    stateFlow.value = stateFlow.value.copy(reading = false, error = Conversation.describe(e))
                } catch (e: Exception) {
                    stateFlow.value = stateFlow.value.copy(reading = false, error = Conversation.describe(e))
                }
                delay(retryMs)
            }
        }
    }

    companion object { const val REREAD_DELAY_MS = 120L }
}