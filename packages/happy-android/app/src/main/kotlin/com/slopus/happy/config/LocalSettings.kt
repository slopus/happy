package com.slopus.happy.config

import android.content.SharedPreferences
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Device-only preferences (happy-app sync/localSettings.ts). They are not
 * synced, and logout clears them, as `mmkv.clearAll()` does.
 */
class LocalSettings(private val prefs: SharedPreferences) {
    private val theme = MutableStateFlow(readTheme())

    val themePreference: StateFlow<ThemePreference> = theme.asStateFlow()

    fun setThemePreference(preference: ThemePreference) {
        prefs.edit().putString(KEY_THEME, preference.wire).apply()
        theme.value = preference
    }

    fun clear() {
        prefs.edit().clear().apply()
        theme.value = readTheme()
    }

    private fun readTheme(): ThemePreference =
        ThemePreference.entries.firstOrNull { it.wire == prefs.getString(KEY_THEME, null) } ?: ThemePreference.Adaptive

    companion object {
        const val PREFS_NAME = "local-settings"
        private const val KEY_THEME = "themePreference"

        /** The value happy-app stores. */
        private val ThemePreference.wire: String
            get() = when (this) {
                ThemePreference.Adaptive -> "adaptive"
                ThemePreference.Light -> "light"
                ThemePreference.Dark -> "dark"
            }
    }
}
