package com.slopus.happy.call

import android.content.Context
import io.elevenlabs.AgentOverrides
import io.elevenlabs.ConversationClient
import io.elevenlabs.ConversationConfig
import io.elevenlabs.ConversationSession
import io.elevenlabs.Language
import io.elevenlabs.Overrides
import io.elevenlabs.PromptOverrides
import io.elevenlabs.models.ConversationEvent
import io.elevenlabs.models.ConversationMode
import io.elevenlabs.models.DisconnectionDetails
import io.elevenlabs.network.ConversationEventParser
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The hosted call agent over the official SDK (iOS `ElevenLabsCallConnection`).
 * Apart from the relay's `ElevenLabsTransport` on purpose: the call's own
 * prompt goes as the agent's prompt override, with its one variable,
 * `initialConversationContext`; no greeting or relay tools are sent. Tool
 * calls are answered one at a time, by their provider ID, and an ID seen
 * before is never run again. Everything the SDK reports comes back on
 * [scope]'s thread.
 */
class ElevenLabsCallConnection private constructor(
    private val session: ConversationSession,
    private val scope: CoroutineScope,
    private val events: CallEvents,
) : CallConnection {
    private val handled = HashSet<String>()
    private val tools = HashMap<String, Job>()
    private var ended = false

    override suspend fun end() {
        ended = true
        tools.values.forEach { it.cancel() }
        tools.clear()
        withContext(NonCancellable) { session.endSession() }
    }

    override suspend fun setMuted(muted: Boolean) = session.setMicMuted(muted)
    override fun update(context: String) {
        if (com.slopus.happy.BuildConfig.DEBUG) CallProbe.sent("update", context)
        session.sendContextualUpdate(context)
    }

    /**
     * A user message the prompt reads as the app's ([CallCue.MARK]): the one
     * event that has the agent take a turn; a contextual update never does.
     */
    override fun cue(facts: String) {
        if (com.slopus.happy.BuildConfig.DEBUG) CallProbe.sent("cue", facts)
        session.sendUserMessage(CallCue.MARK + facts)
    }

    /**
     * The person's turn typed rather than spoken: the device check's synthetic
     * input, never the app's. Kept as theirs, as a transcript would be.
     */
    fun type(text: String) {
        if (com.slopus.happy.BuildConfig.DEBUG) CallProbe.sent("typed", text)
        session.sendUserMessage(text)
        events.heard(text)
    }

    private fun answer(call: CallToolCall, events: CallEvents) {
        if (ended || !handled.add(call.id)) return
        tools[call.id] = scope.launch {
            val result = events.tool(call)
            if (com.slopus.happy.BuildConfig.DEBUG) CallProbe.tool(call, result)
            if (ended) return@launch
            if (call.expectsResponse) session.sendToolResult(call.id, result.text, result.isError)
            tools.remove(call.id)
        }
    }

    /**
     * Who is speaking, from the agent's mode and the person's voice activity,
     * held 300 ms past the end of the person's speech.
     */
    private class Tracker(private val scope: CoroutineScope, private val changed: (CallActivity, Float, Float?) -> Unit) {
        private var speaking = false
        private var silence: Job? = null
        var audio: Float? = null

        fun agentSpeaking(value: Boolean) {
            speaking = value
            silence?.cancel(); silence = null
            changed(if (value) CallActivity.AgentSpeaking else CallActivity.Listening, 0f, audio)
        }

        fun vad(score: Float) {
            if (speaking) return
            if (score > 0.5f) {
                silence?.cancel(); silence = null
                changed(CallActivity.UserSpeaking, score, null)
            } else if (silence == null) {
                silence = scope.launch {
                    delay(300)
                    silence = null
                    if (!speaking) changed(CallActivity.Listening, 0f, null)
                }
            }
        }

        fun level(value: Float) {
            audio = value
            if (speaking) changed(CallActivity.AgentSpeaking, 0f, value)
        }
    }

    companion object {
        /** Whether [message], a raw event, is the response to the agent's end_call: it hung up. */
        internal fun hangsUp(message: String): Boolean =
            "end_call" in message && (ConversationEventParser.parseIncomingEvent(message) as? ConversationEvent.AgentToolResponse)?.toolName == "end_call"

        suspend fun connect(context: Context, scope: CoroutineScope, grant: CallGrant, request: CallStart, events: CallEvents): ElevenLabsCallConnection {
            val tracker = Tracker(scope, events.activity)
            var connection: ElevenLabsCallConnection? = null
            // Calls that come before the session is handed back wait for it.
            val early = ArrayList<CallToolCall>()
            // The SDK ends the call itself for the agent's end_call, as the person's own end; the agent
            // leaving the room can be heard first, so the tool's response is what says it hung up.
            // Its raw event, in order with the agent leaving: the parsed one comes off a queue, later.
            val agentEnded = java.util.concurrent.atomic.AtomicBoolean(false)
            val config = ConversationConfig(
                // A minted token when a Happy service grants one; a public agent by its ID otherwise.
                agentId = grant.agentId.takeIf { grant.conversationToken == null },
                conversationToken = grant.conversationToken,
                userId = grant.userId,
                dynamicVariables = mapOf("initialConversationContext" to request.context),
                // The hosted agent must allow the prompt override (its Security settings), or the call is refused.
                overrides = Overrides(agent = AgentOverrides(prompt = PromptOverrides(request.prompt), language = request.language?.let(Language::fromCode))),
                onUnhandledClientToolCall = { call ->
                    val parameters = call.parameters.toJson() as? kotlinx.serialization.json.JsonObject ?: kotlinx.serialization.json.JsonObject(emptyMap())
                    val request = CallToolCall(call.toolCallId, call.toolName, parameters, call.expectsResponse)
                    scope.launch { connection?.answer(request, events) ?: early.add(request) }
                },
                onModeChange = { mode -> scope.launch { tracker.agentSpeaking(mode == ConversationMode.SPEAKING) } },
                onVadScore = { score -> scope.launch { tracker.vad(score) } },
                onAudioLevelChanged = { level -> scope.launch { tracker.level(level) } },
                // What was said aloud, final only, for the call's history: never a cue, which comes back as none of these.
                onUserTranscriptEvent = { text, _ ->
                    scope.launch {
                        if (com.slopus.happy.BuildConfig.DEBUG) CallProbe.line("user", text)
                        events.heard(text)
                    }
                },
                onAgentResponseEvent = { text, event ->
                    scope.launch {
                        if (com.slopus.happy.BuildConfig.DEBUG) CallProbe.line("agent", text)
                        events.said(text, event ?: -1)
                    }
                },
                onAgentResponseCorrectionEvent = { text, event -> scope.launch { events.corrected(text, event ?: -1) } },
                onMessage = { _, message -> if (hangsUp(message)) agentEnded.set(true) },
                onDisconnect = { details ->
                    val hungUp = details is DisconnectionDetails.User || agentEnded.get()
                    scope.launch { if (hungUp) events.hungUp() else events.disconnected() }
                },
                onError = { _, _ -> scope.launch { events.disconnected() } },
                // Another app took the audio focus, or the selected headset went (ConversationAudioHandler).
                onAudioInterruption = { scope.launch { events.interrupted() } },
            )
            var opened: ConversationSession? = null
            try {
                val session = ConversationClient.startSession(config, context)
                opened = session
                return ElevenLabsCallConnection(session, scope, events).also { made ->
                    connection = made
                    early.forEach { made.answer(it, events) }
                    early.clear()
                }
            } catch (error: Throwable) {
                withContext(NonCancellable) { opened?.endSession() }
                throw error
            }
        }
    }
}
