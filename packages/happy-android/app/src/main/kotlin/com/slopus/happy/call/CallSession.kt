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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

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
    /** The person's words, as finally transcribed. */
    val heard: (String) -> Unit = {},
    /** The agent's words, by the provider's event for them. */
    val said: (String, Int) -> Unit = { _, _ -> },
    /** The agent's words for an event as they were heard: the person cut in. */
    val corrected: (String, Int) -> Unit = { _, _ -> },
    /** Another app has the audio for a while (a phone call, an alarm): the call on hold (true) until it is back (false). */
    val held: (Boolean) -> Unit = {},
)

/** The SDK stays in its adapter ([ElevenLabsCallConnection]); this is all of it the call needs. */
interface CallConnection {
    /** Ends the call and returns once its audio is let go. */
    suspend fun end()
    suspend fun setMuted(muted: Boolean)
    /** On hold: the microphone and the agent's voice off, whatever [setMuted] says; off hold, as it says. */
    suspend fun hold(held: Boolean)
    /** Context the agent reads without answering. */
    fun update(context: String)
    /** Facts the agent answers aloud ([CallCue]), marked as the app's: never the person's words, never kept as theirs. */
    fun cue(facts: String)
}

/**
 * One call's life, from the tap to its end (iOS `CallSession`): the grant
 * and the device's free time before anything else (a call that can't have
 * either ends at once, without asking for the microphone), then the
 * microphone, then the connection. A live call is counted against
 * [allowance] as it goes, every 10 s on the wall clock, and ends when that
 * runs out. Context that comes before it is live waits for it, up to 32 KB;
 * past that it is let go, never cut, and put right in one go. What the
 * person and the agent say goes into [history], and how the call ended;
 * [CallCues] has the agent speak up before silence or a limit ends it, and a
 * call the agent agreed to restart ([requestRestart]) starts again at once.
 * Every callback carries the generation it was made in, and one from an ended
 * call goes nowhere.
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
    private val history: CallHistory? = null,
    private val timing: CallCues.Timing = CallCues.Timing(),
    private val tickMillis: Long = 1_000,
    /** A phone call has the phone's audio: a call made again after a hold waits for it ([lost]). */
    private val phoneBusy: () -> Boolean = { false },
    private val connect: suspend (CallGrant, CallStart, CallEvents) -> CallConnection,
) {
    private val mutableState = MutableStateFlow<CallState>(CallState.Idle)
    val state: StateFlow<CallState> = mutableState.asStateFlow()
    /** The waves' level, from what the call reported ([CallLevel]). */
    var onLevel: ((Float) -> Unit)? = null
    /** Context waiting for the call went past [PENDING_BYTES] and was let go whole: the call's context sends what puts it right ([CallContext.resync]). */
    var onOverflow: (() -> Unit)? = null
    /** The agent hung up, or a hold went on too long, after the call went idle: whoever holds it ends it as End would. */
    var onHangUp: (() -> Unit)? = null
    /** A call that went live ended, and its audio is let go: how. */
    var onEnded: ((CallEnding) -> Unit)? = null

    private var connection: CallConnection? = null
    private var starting: Job? = null
    /** The last call's audio being let go: the next one connects after it. */
    private var teardown: Job? = null
    private var generation = 0
    private var activity = CallActivity.Listening
    private var muted = false
    private var changingMute = false
    /** Another app has the audio ([CallEvents.held]): neither side is heard, for as long as it lasts, and silence isn't counted. */
    private var held = false
    /** When the last hold ended: a connection lost within [HOLD_GRACE] of it is the hold's too. */
    private var resumedAt = Long.MIN_VALUE / 2
    private var since = 0L
    private val pendingContext = ArrayList<String>()
    private var counted: Pair<String, Long>? = null
    /** When the call's time was last written down, on the wall clock. */
    private var countedAt = 0L
    private var counting: Job? = null
    private var cues: CallCues? = null
    private var cueing: Job? = null
    /** What this call has said worth a line, past the agent's greeting. */
    private var spoke = false
    private var greeted = false
    private var lastVoice = Long.MIN_VALUE / 2
    private var request: Triple<String?, suspend () -> String, suspend (CallToolCall) -> CallToolResult>? = null

    /** [context] makes the first snapshot once the grant is in hand; [tool] answers the hosted agent's tools. */
    fun start(language: String?, context: suspend () -> String, tool: suspend (CallToolCall) -> CallToolResult) {
        if (starting != null || connection != null || state.value.isLive) return
        request = Triple(language, context, tool)
        begin()
    }

    /**
     * The agent asked for a fresh call (`happy://call/restart`): it comes once
     * its words on it are said, this one carried over in the next one's
     * context. Refused with too little voice time left.
     */
    fun requestRestart(): CallToolResult {
        val cues = cues
        if (connection == null || cues == null) return CallToolResult.refused("The call isn't live.")
        if (!cues.canRestart(allowanceLeft())) return CallToolResult.refused("There isn't enough voice time left to restart; the call ends soon.")
        cues.restartAsked(now())
        return CallToolResult.json(buildJsonObject {
            put("ok", true)
            put("restarting", true)
            put("note", "The call restarts once you finish speaking; say so in a few words.")
        })
    }

    private fun begin() {
        val (language, context, tool) = request ?: return
        val current = ++generation
        spoke = false
        greeted = false
        history?.began()
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
                            if (this@CallSession.activity == CallActivity.AgentSpeaking && activity != CallActivity.AgentSpeaking) cues?.agentSpoke(now())
                            if (activity == CallActivity.UserSpeaking) lastVoice = now()
                            this@CallSession.activity = activity
                            onLevel?.invoke(if (held) 0f else CallLevel.level(activity, vad, audio, muted))
                            if (connection != null) mutableState.value = CallState.Active(activity, muted, since, held)
                        }
                    },
                    disconnected = { if (current == generation) lost() },
                    hungUp = {
                        if (current == generation) {
                            stop(CallEnding.AgentHungUp)
                            onHangUp?.invoke()
                        }
                    },
                    tool = tool,
                    heard = { text ->
                        if (current == generation) {
                            cues?.heard(now())
                            spoke = true
                            greeted = true
                            history?.heard(text, wallClock())
                        }
                    },
                    said = { text, event ->
                        // Its first words before anyone else's are the hosted agent's greeting.
                        if (current == generation) {
                            if (!greeted) {
                                greeted = true
                            } else {
                                spoke = true
                                history?.said(text, event, wallClock())
                            }
                        }
                    },
                    corrected = { text, event -> if (current == generation) history?.corrected(text, event) },
                    held = { value -> if (current == generation) hold(current, value) },
                )
                val opened = connect(grant, request, events)
                if (current != generation) {
                    withContext(NonCancellable) { opened.end() }
                    return@launch
                }
                connection = opened
                muted = false
                since = now()
                cues = CallCues(timing, since)
                // Held while it connected: it starts on hold.
                if (held) runCatching { opened.hold(true) }
                mutableState.value = CallState.Active(activity, false, since, held)
                count(current)
                cue(current)
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

    /** Hangs up, or closes the bar of a call that ended; [ending] says why, for a call that was live. */
    fun stop(ending: CallEnding = CallEnding.HungUp) {
        unhold()
        tearDown(ending)
        mutableState.value = CallState.Idle
    }

    private fun end(problem: CallProblem, ending: CallEnding) {
        unhold()
        tearDown(ending)
        mutableState.value = CallState.Ended(problem)
    }

    private fun unhold() {
        held = false
        resumedAt = Long.MIN_VALUE / 2
    }

    /**
     * The connection went: a drop, unless the phone had the audio or gave it
     * back under [HOLD_GRACE] ago (iOS `lost`). Then the call is made again,
     * this one carried over in its first context, as a restart is, once no
     * phone call has the audio: the hold's own end can't be heard with the
     * connection gone, so a phone call ringing or on ([phoneBusy]) is what
     * it waits for.
     */
    private fun lost() {
        if (!held && now() - resumedAt >= HOLD_GRACE) return end(CallProblem.Connection, dropped())
        if (!state.value.isLive || request == null) return
        tearDown(CallEnding.Interrupted)
        mutableState.value = CallState.Connecting
        val current = generation
        starting = scope.launch {
            while (phoneBusy()) delay(tickMillis)
            if (current != generation) return@launch
            held = false
            resumedAt = now()
            begin()
        }
    }

    /** What ended a call the provider let go of unasked: its limit, its own silence timeout (never first, [CallCues]), or a drop. */
    private fun dropped(): CallEnding =
        if (now() - since >= timing.callLimit - 3 * timing.callLimitMargin) CallEnding.CallLimit else CallEnding.Dropped

    /** Voice time left now, counting what isn't written down yet. */
    private fun allowanceLeft(): Long? {
        val allowance = allowance ?: return null
        val at = wallClock()
        return maxOf(0L, allowance.remaining(at) - (if (counted != null) at - countedAt else 0L))
    }

    /** Asks the cues every [tickMillis] what to do while the call is live. */
    private fun cue(current: Int) {
        cueing = scope.launch {
            while (current == generation) {
                delay(tickMillis)
                val connection = connection
                val cues = cues
                if (current != generation || connection == null || cues == null) return@launch
                // Nothing is said or ended on hold: what is due comes once the audio is back.
                if (held) continue
                val at = now()
                val moment = CallCues.Moment(
                    at, agentSpeaking = activity == CallActivity.AgentSpeaking,
                    personSpeaking = activity == CallActivity.UserSpeaking || at - lastVoice < 1_500,
                    allowanceLeft = allowanceLeft(), allowanceTotal = allowance?.total(),
                )
                when (val action = cues.next(moment)) {
                    is CallCues.Action.Cue -> runCatching { connection.cue(action.cue.text) }
                    is CallCues.Action.End -> return@launch stop(action.ending)
                    CallCues.Action.Restart -> {
                        tearDown(CallEnding.Restarted)
                        return@launch begin()
                    }
                    null -> Unit
                }
            }
        }
    }

    /** Writes the call's time down every 10 s, so a call the app never saw end still counts, and ends it when the time is gone. */
    private fun count(current: Int) {
        val allowance = allowance ?: return
        val call = java.util.UUID.randomUUID().toString() to wallClock()
        counted = call
        countedAt = call.second
        counting = scope.launch {
            while (current == generation) {
                val at = wallClock()
                allowance.record(call.first, call.second, at)
                countedAt = at
                val left = allowance.remaining(at)
                if (left <= 0) return@launch end(CallProblem.LimitReached, CallEnding.TimeUsed)
                delay(minOf(10_000L, left))
            }
        }
    }

    private fun tearDown(ending: CallEnding = CallEnding.HungUp) {
        generation += 1
        starting?.cancel()
        starting = null
        counting?.cancel()
        counting = null
        // Not cancelled: a cue's own restart or end tears down from inside it, and it stops on the next turn.
        cueing = null
        cues = null
        counted?.let { (id, start) -> allowance?.record(id, start, wallClock()) }
        counted = null
        val old = connection
        connection = null
        pendingContext.clear()
        activity = CallActivity.Listening
        lastVoice = Long.MIN_VALUE / 2
        muted = false
        changingMute = false
        onLevel?.invoke(0f)
        // Only a call that went live ended; a plain end is worth a line only after words.
        if (old != null && (spoke || !ending.isPlain)) history?.ended(ending, wallClock())
        spoke = false
        if (old != null) {
            val previous = teardown
            // Told even once whoever held the session has let it go.
            val ended = onEnded
            teardown = scope.launch {
                previous?.join()
                withContext(NonCancellable) { old.end() }
                ended?.invoke(ending)
            }
        }
    }

    /**
     * As a phone call on hold (iOS `hold`, `resume`): neither side heard
     * while another app has the audio, however long, and back as it was when
     * the audio is, its silence counted from then.
     */
    private fun hold(current: Int, value: Boolean) {
        if (held == value) return
        held = value
        if (!value) {
            resumedAt = now()
            cues?.heard(now())
            lastVoice = now()
        }
        val connection = connection ?: return
        if (value) onLevel?.invoke(0f)
        mutableState.value = CallState.Active(activity, muted, since, held)
        scope.launch {
            try {
                connection.hold(value)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (current == generation) lost()
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
                mutableState.value = CallState.Active(activity, muted, since, held)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (current == generation) lost()
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
            lost()
        }
    }

    companion object {
        /** The most context kept while the call isn't live yet. */
        const val PENDING_BYTES = 32 * 1024

        /** How long after a hold a lost connection is still the hold's (iOS `holdGrace`). */
        const val HOLD_GRACE = 15_000L
    }
}
