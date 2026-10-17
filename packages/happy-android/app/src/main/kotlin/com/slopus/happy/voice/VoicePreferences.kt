package com.slopus.happy.voice

import android.content.SharedPreferences

enum class VoiceUpsell(val wire: String) {
    Control("control"), SoftPaywall("show-paywall-before-first-voice-chat"), Onboarding("voice-onboarding-and-upsell");

    companion object {
        /** voiceExperiment.ts: a developer override wins, unknown remote values are control. */
        fun resolve(raw: String? = null, override: String? = null, overrideEnabled: Boolean = false): VoiceUpsell =
            entries.firstOrNull { it.wire == (if (overrideEnabled && override != null) override else raw) } ?: Control
    }
}

/** persistence.ts's account-local counters; AppGraph clears this file at logout. */
class VoicePreferences(private val prefs: SharedPreferences) {
    val softPaywalls: Int get() = prefs.getInt("voice-soft-paywall-shown-count", 0)
    val onboardingLoads: Int get() = prefs.getInt("voice-onboarding-prompt-load-count", 0)
    val messages: Int get() = prefs.getInt("voice-message-count", 0)
    @Synchronized fun incrementSoftPaywalls() { prefs.edit().putInt("voice-soft-paywall-shown-count", softPaywalls + 1).apply() }
    @Synchronized fun incrementOnboarding() { prefs.edit().putInt("voice-onboarding-prompt-load-count", onboardingLoads + 1).apply() }
    @Synchronized fun incrementMessages() { prefs.edit().putInt("voice-message-count", messages + 1).apply() }
    @Synchronized fun reset() { prefs.edit().clear().apply() }

    companion object { const val PREFS_NAME = "voice-counters" }
}