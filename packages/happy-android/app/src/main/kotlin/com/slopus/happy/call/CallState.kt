package com.slopus.happy.call

/**
 * A voice call with an agent connection's agents (iOS `HappyCore/Call`):
 * ElevenLabs' new hosted agent, its audio, context and five client tools,
 * all on this phone. Apart from the relay's voice (`voice/`), whose agent,
 * prompt and tools stay as they are; nothing here is shared with it.
 */
enum class CallActivity { Listening, UserSpeaking, AgentSpeaking }

/** Why a call isn't running, in the person's terms. */
enum class CallProblem {
    /** No hosted agent or no grant this connection can ask for yet. Never shown as connecting. */
    NotSetUp,
    MicrophonePermission,
    SubscriptionRequired,
    LimitReached,
    Authentication,
    /** It started and dropped, or never connected. */
    Connection,
}

sealed interface CallState {
    data object Idle : CallState
    data object Connecting : CallState
    /** Live; [since] is `SystemClock.elapsedRealtime()` when it connected, for its clock. */
    data class Active(val activity: CallActivity, val muted: Boolean, val since: Long) : CallState
    /** It couldn't start or it stopped for a reason to read; the bar stays until closed. */
    data class Ended(val problem: CallProblem) : CallState

    val isLive: Boolean get() = this is Connecting || this is Active
    val isShown: Boolean get() = this != Idle
}

/**
 * The waves' level from what the call reported, 0..1.5: the SDK's audio
 * level, the person's voice activity while they speak, nothing otherwise.
 */
object CallLevel {
    fun level(activity: CallActivity, vad: Float, audio: Float?, muted: Boolean): Float = when (activity) {
        CallActivity.AgentSpeaking -> audio?.let { (it * 1.5f).coerceIn(0f, 1.5f) } ?: 0.9f
        CallActivity.UserSpeaking -> if (muted) 0f else (vad * 1.5f).coerceIn(0f, 1.5f)
        CallActivity.Listening -> 0f
    }
}

/**
 * What starts one call (iOS `CallGrant`): the hosted agent's ID, and either
 * a conversation token a Happy service minted for it or nothing, for a
 * public agent anyone may call. No provider key is ever on this phone.
 */
data class CallGrant(val agentId: String, val conversationToken: String? = null, val userId: String? = null)

sealed interface CallGrantResult {
    data class Granted(val grant: CallGrant) : CallGrantResult
    data class Refused(val problem: CallProblem) : CallGrantResult
}

/** Where a connection's calls come from. Asked once per call, after the microphone. */
interface CallGrants {
    /** False ends a call at the tap, before the microphone is asked for. */
    val isConfigured: Boolean
    suspend fun grant(): CallGrantResult
}

/** The hosted agent: versioned, its own prompt and the four [CallTool]s (v3); not the relay's. */
object CallAgent {
    /**
     * The build's `CALL_AGENT_ID`, from `HAPPY_CALL_AGENT_V3_ID`, `-Phappy.callAgentV3Id`
     * or `local.properties`, never the repository (docs/agent-voice-call.md). Named for
     * the tools, so an older agent's ID (`HAPPY_CALL_AGENT_ID`, v2's) never reaches this
     * code. Without it every call ends as [CallProblem.NotSetUp].
     */
    val hostedAgentId: String? = id(com.slopus.happy.BuildConfig.CALL_AGENT_ID)

    /** An ElevenLabs agent ID, or null for anything else. */
    fun id(value: String?): String? = value?.trim()?.takeIf { text ->
        text.startsWith("agent_") && text.length > 6 && text.all { it.isLetterOrDigit() || it == '_' }
    }
}

/**
 * A public agent, called with its ID alone: launch's way in. Anyone with the
 * ID may start a conversation, so it connects rather than authenticates, and
 * the only limit is this device's count of free time ([CallAllowance]).
 */
class PublicAgentCallGrants(val agentId: String) : CallGrants {
    override val isConfigured = true
    override suspend fun grant(): CallGrantResult = CallGrantResult.Granted(CallGrant(agentId))
}

/** No hosted agent in this build: says so rather than pretend. */
object UnconfiguredCallGrants : CallGrants {
    override val isConfigured = false
    override suspend fun grant(): CallGrantResult = CallGrantResult.Refused(CallProblem.NotSetUp)
}
