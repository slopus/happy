package com.slopus.happy.call

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * What a call is started with: the system prompt ([CallPrompt], the hosted agent's prompt override), its one
 * variable, and the person's language if they chose one. The tools are the hosted agent's ([CallTool]); no greeting
 * is sent.
 */
data class CallStart(val context: String, val language: String? = null, val prompt: String = CallPrompt.SYSTEM)

/** What the connection reports back while it runs; called on the session's thread. */
class CallEvents(
    /** Who is speaking, with the person's voice activity (0..1) and the SDK's audio level, if it has one. */
    val activity: (CallActivity, Float, Float?) -> Unit,
    /** The call dropped, or the provider ended it unasked. */
    val disconnected: () -> Unit,
    /** The agent hung up (its `end_call`): the same as the person tapping End. */
    val hungUp: () -> Unit,
    /** One client tool call; the connection replies with the answer. */
    val tool: suspend (CallToolCall) -> CallToolResult,
)

/** The SDK stays in its adapter ([ElevenLabsCallConnection]); this is all of it the call needs. */
interface CallConnection {
    /** Ends the call and returns once its audio is let go. */
    suspend fun end()
    suspend fun setMuted(muted: Boolean)
    /** Context the agent reads without answering. */
    fun update(context: String)
}

/**
 * One call's life, from the tap to its end (iOS `CallSession`): the grant
 * and the device's free time before anything else (a call that can't have
 * either ends at once, without asking for the microphone), then the
 * microphone, then the connection. A live call is counted against
 * [allowance] as it goes, every 10 s on the wall clock, and ends when that
 * runs out. Context that comes before it is live waits for it, up to 32 KB;
 * past that it is let go, never cut, and put right in one go. Every callback carries the
 * generation it was made in, and one from an ended call goes nowhere.
 *
 * Runs on [scope]'s one thread (the main thread in the app).
 */
class CallSession(
    private val scope: CoroutineScope,
    private val grants: CallGrants,
    private val permission: suspend () -> Boolean,
    private val now: () -> Long,
    private val allowance: CallAllowance? = null,
    private val wallClock: () -> Long = System::currentTimeMillis,
    private val connect: suspend (CallGrant, CallStart, CallEvents) -> CallConnection,
) {
    private val mutableState = MutableStateFlow<CallState>(CallState.Idle)
    val state: StateFlow<CallState> = mutableState.asStateFlow()
    /** The waves' level, from what the call reported ([CallLevel]). */
    var onLevel: ((Float) -> Unit)? = null
    /** Context waiting for the call went past [PENDING_BYTES] and was let go whole: the call's context sends what puts it right ([CallContext.resync]). */
    var onOverflow: (() -> Unit)? = null
    /** The agent hung up, after the call went idle: whoever holds it ends it as End would. */
    var onHangUp: (() -> Unit)? = null

    private var connection: CallConnection? = null
    private var starting: Job? = null
    /** The last call's audio being let go: the next one connects after it. */
    private var teardown: Job? = null
    private var generation = 0
    private var activity = CallActivity.Listening
    private var muted = false
    private var changingMute = false
    private var since = 0L
    private val pendingContext = ArrayList<String>()
    private var counted: Pair<String, Long>? = null
    private var counting: Job? = null

    /** [context] makes the first snapshot once the grant is in hand; [tool] answers the hosted agent's tools. */
    fun start(language: String?, context: suspend () -> String, tool: suspend (CallToolCall) -> CallToolResult) {
        if (starting != null || connection != null || state.value.isLive) return
        val current = ++generation
        if (!grants.isConfigured) {
            mutableState.value = CallState.Ended(CallProblem.NotSetUp)
            return
        }
        if (allowance != null && allowance.remaining(wallClock()) <= 0) {
            mutableState.value = CallState.Ended(CallProblem.LimitReached)
            return
        }
        mutableState.value = CallState.Connecting
        starting = scope.launch {
            try {
                if (!permission()) {
                    if (current == generation) mutableState.value = CallState.Ended(CallProblem.MicrophonePermission)
                    return@launch
                }
                val grant = when (val result = grants.grant()) {
                    is CallGrantResult.Granted -> result.grant
                    is CallGrantResult.Refused -> {
                        if (current == generation) mutableState.value = CallState.Ended(result.problem)
                        return@launch
                    }
                }
                if (current != generation) return@launch
                val request = CallStart(context(), language)
                teardown?.join()
                val events = CallEvents(
                    activity = { activity, vad, audio ->
                        if (current == generation) {
                            this@CallSession.activity = activity
                            onLevel?.invoke(CallLevel.level(activity, vad, audio, muted))
                            if (connection != null) mutableState.value = CallState.Active(activity, muted, since)
                        }
                    },
                    disconnected = { if (current == generation) end(CallProblem.Connection) },
                    hungUp = {
                        if (current == generation) {
                            stop()
                            onHangUp?.invoke()
                        }
                    },
                    tool = tool,
                )
                val opened = connect(grant, request, events)
                if (current != generation) {
                    withContext(NonCancellable) { opened.end() }
                    return@launch
                }
                connection = opened
                muted = false
                since = now()
                mutableState.value = CallState.Active(activity, false, since)
                count(current)
                flushContext()
            } catch (e: CancellationException) {
                if (current == generation) mutableState.value = CallState.Idle
                throw e
            } catch (e: Exception) {
                if (current == generation) mutableState.value = CallState.Ended(CallProblem.Connection)
            } finally {
                if (current == generation) starting = null
            }
        }
    }

    /** Hangs up, or closes the bar of a call that ended. */
    fun stop() {
        tearDown()
        mutableState.value = CallState.Idle
    }

    private fun end(problem: CallProblem) {
        tearDown()
        mutableState.value = CallState.Ended(problem)
    }

    /** Writes the call's time down every 10 s, so a call the app never saw end still counts, and ends it when the time is gone. */
    private fun count(current: Int) {
        val allowance = allowance ?: return
        val call = java.util.UUID.randomUUID().toString() to wallClock()
        counted = call
        counting = scope.launch {
            while (current == generation) {
                val at = wallClock()
                allowance.record(call.first, call.second, at)
                val left = allowance.remaining(at)
                if (left <= 0) return@launch end(CallProblem.LimitReached)
                delay(minOf(10_000L, left))
            }
        }
    }

    private fun tearDown() {
        generation += 1
        starting?.cancel()
        starting = null
        counting?.cancel()
        counting = null
        counted?.let { (id, start) -> allowance?.record(id, start, wallClock()) }
        counted = null
        val old = connection
        connection = null
        pendingContext.clear()
        activity = CallActivity.Listening
        muted = false
        changingMute = false
        onLevel?.invoke(0f)
        if (old != null) {
            val previous = teardown
            teardown = scope.launch {
                previous?.join()
                withContext(NonCancellable) { old.end() }
            }
        }
    }

    fun toggleMute() {
        val connection = connection ?: return
        if (changingMute) return
        val current = generation
        val target = !muted
        changingMute = true
        scope.launch {
            try {
                connection.setMuted(target)
                if (current != generation) return@launch
                muted = target
                mutableState.value = CallState.Active(activity, muted, since)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (current == generation) end(CallProblem.Connection)
            } finally {
                if (current == generation) changingMute = false
            }
        }
    }

    /**
     * Context from the call's context; kept until it is live. Past
     * [PENDING_BYTES] none of it is kept, rather than words with a hole in
     * them: [onOverflow] asks for what puts the agent right instead.
     */
    fun deliver(update: CallUpdate) {
        if (!state.value.isLive || update.isEmpty) return
        pendingContext += update.context
        if (pendingContext.sumOf { it.utf8Size() + 1 } > PENDING_BYTES) {
            pendingContext.clear()
            onOverflow?.invoke()
            return
        }
        flushContext()
    }

    private fun flushContext() {
        val connection = connection ?: return
        if (pendingContext.isEmpty()) return
        val text = pendingContext.joinToString("\n")
        pendingContext.clear()
        try {
            connection.update(text)
        } catch (e: Exception) {
            end(CallProblem.Connection)
        }
    }

    companion object {
        /** The most context kept while the call isn't live yet. */
        const val PENDING_BYTES = 32 * 1024
    }
}
