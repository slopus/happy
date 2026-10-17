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
    data object Declined : VoiceStart
    data object Unavailable : VoiceStart
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
    /** RealtimeSession.ts: outcomes are presented by the UI; only cancellation escapes. */
    suspend fun start(sessionId: String, microphone: MicrophonePermission): VoiceStart
    suspend fun stop()
    fun setMuted(muted: Boolean) {}
    suspend fun usage(): VoiceUsage? = null
    /** voiceHooks.onSessionFocus; silent context, never starts a call. */
    fun focus(sessionId: String) {}
}

/** Adapter to purchases; present returns true only when the paywall reports a purchase. */
interface VoicePaywall {
    fun hasPro(): Boolean
    suspend fun present(flow: String): Boolean
}