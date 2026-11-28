package com.slopus.happy.config

import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Settings' Happy Cloud switch: whether the app offers Happy Cloud's ways in
 * (the first screen's Use Happy Cloud, the account menu's Connect to Happy
 * Cloud). It only hides them: an invite link opens the app and its invite
 * whatever it says (the manifest claims the links in every build, and
 * nothing here turns that off), a Cloud flow reached anyway works, and
 * signing out stays. This phone's own, never an account's or a server's; a
 * logout doesn't reset it.
 *
 * An override over [default], the build's ([com.slopus.happy.connection.HappyCloud.offeredByDefault]):
 * nothing is kept until the switch is turned, so a person who never turns
 * it gets whatever default the build they run has, update after update.
 * Servers already on the phone keep working either way.
 */
class HappyCloudSetting(private val prefs: SharedPreferences, private val default: Boolean) {
    private val state = MutableStateFlow(if (prefs.contains(KEY)) prefs.getBoolean(KEY, default) else default)

    val enabled: StateFlow<Boolean> = state.asStateFlow()

    /** The switch's own change: the one place the override is written. */
    fun set(on: Boolean) {
        if (on == state.value) return
        prefs.edit().putBoolean(KEY, on).apply()
        state.value = on
    }

    companion object {
        const val PREFS_NAME = "happy-cloud"
        private const val KEY = "offered"
    }
}
