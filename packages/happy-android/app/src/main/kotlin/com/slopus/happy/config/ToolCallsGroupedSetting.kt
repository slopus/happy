package com.slopus.happy.config

import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * An agent connection's Appearance › Group tool calls (desktop's
 * appearance setting of the same name): a Happy Agent chat draws each run
 * of tool calls as one line ([com.slopus.happy.conversation.ToolSections]).
 * Kept on this phone for every connection, so a logout doesn't reset it;
 * on unless turned off (desktop's is off unless turned on).
 */
class ToolCallsGroupedSetting(private val prefs: SharedPreferences) {
    private val state = MutableStateFlow(prefs.getBoolean(KEY, true))

    val enabled: StateFlow<Boolean> = state.asStateFlow()

    fun set(on: Boolean) {
        if (on == state.value) return
        prefs.edit().putBoolean(KEY, on).apply()
        state.value = on
    }

    companion object {
        const val PREFS_NAME = "transcript"
        private const val KEY = "tool-calls-grouped"
    }
}
