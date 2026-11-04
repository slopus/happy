package com.slopus.happy.voice

import androidx.compose.runtime.Immutable
import kotlinx.coroutines.flow.StateFlow

enum class VoiceStatus { Disconnected, Connecting, Connected, Error }
enum class VoiceMode { Idle, AgentSpeaking, UserSpeaking }

@Immutable
data class VoiceState(
    val status: VoiceStatus = VoiceStatus.Disconnected,
    val mode: VoiceMode = VoiceMode.Idle,
    val sessionId: String? = null,
    val connectedAtElapsed: Long? = null,
    val muted: Boolean = false,
)

sealed interface VoiceStart {
    data class Started(val conversationId: String?) : VoiceStart
    data class MicrophoneDenied(val canAskAgain: Boolean) : VoiceStart
    data object NotSignedIn : VoiceStart
    data object LimitReached : VoiceStart

    /** The server's hard cap on voice time, [hours] long: no purchase lifts it, so no sheet sells one. */
    data class HardLimitReached(val hours: Long) : VoiceStart
    data object Declined : VoiceStart
    data object Unavailable : VoiceStart

    /** The relay's voice is switched off ([VoiceController.available]): nothing was asked or opened. */
    data object NotAvailable : VoiceStart
}

data class MicrophoneAccess(val granted: Boolean, val canAskAgain: Boolean)

/** The activity owns the runtime permission launcher; the engine owns its order in gating. */
interface MicrophonePermission {
    suspend fun request(): MicrophoneAccess
    fun openSettings()
}

data class VoiceUsage(val usedSeconds: Int, val limitSeconds: Int, val conversationCount: Int, val conversationLimit: Int)

interface VoiceController {
    val state: StateFlow<VoiceState>
    /** Whether a call can start at all; false shows no voice button. */
    val available: Boolean get() = true
    /** RealtimeSession.ts: outcomes are presented by the UI; only cancellation escapes. */
    suspend fun start(sessionId: String, microphone: MicrophonePermission): VoiceStart
    suspend fun stop()
    fun setMuted(muted: Boolean) {}
    suspend fun usage(): VoiceUsage? = null
    /** voiceHooks.onSessionFocus; silent context, never starts a call. */
    fun focus(sessionId: String) {}
}

/**
 * Adapter to the app's subscription and its offer sheets. [present] is true
 * to go on: for `voice_must_pay`, only once `pro` came while its sheet was
 * up; for `voice_trial_eligible`, when no welcome was due or its "Start Voice
 * Session" (or a purchase) closed it. Closing a sheet never goes on.
 */
interface VoicePaywall {
    fun hasPro(): Boolean
    suspend fun present(flow: String): Boolean
}