package com.slopus.happy.config

import android.content.ComponentName
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Settings' Happy Cloud switch, also on the first screen's Get help: whether
 * the app offers Happy Cloud's ways in (the first screen's Use Happy Cloud,
 * the account menu's Connect to Happy Cloud, its invite links). Kept on this
 * phone for every account, so a logout doesn't reset it; off on every build
 * unless turned on. Servers already on the phone keep working either way.
 */
class HappyCloudSetting(private val prefs: SharedPreferences) {
    private val state = MutableStateFlow(prefs.getBoolean(KEY, false))

    val enabled: StateFlow<Boolean> = state.asStateFlow()

    fun set(on: Boolean) {
        if (on == state.value) return
        prefs.edit().putBoolean(KEY, on).apply()
        state.value = on
    }

    companion object {
        const val PREFS_NAME = "happy-cloud"
        private const val KEY = "offered"

        /** The manifest's alias that holds Happy Cloud's invite-link intent filters, off until the switch is on. */
        private const val LINKS = "com.slopus.happy.HappyCloudLinks"

        /** Lets Happy Cloud's invite links open the app while [on], or leaves them to the browser. */
        fun applyLinks(context: Context, on: Boolean) {
            val links = ComponentName(context, LINKS)
            val state = if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
            val packages = context.packageManager
            runCatching {
                if (packages.getComponentEnabledSetting(links) != state) packages.setComponentEnabledSetting(links, state, PackageManager.DONT_KILL_APP)
            }
        }
    }
}
