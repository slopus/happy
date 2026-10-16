package com.slopus.happy.config

import android.content.SharedPreferences
import com.slopus.happy.model.settings.LocalSettingsValues
import com.slopus.happy.model.settings.LocalSettingsValues.Companion.wire
import com.slopus.happy.net.HappyJson
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.SerializationException

/**
 * Device-only preferences (happy-app sync/localSettings.ts). They are not
 * synced, and logout clears them, as `mmkv.clearAll()` does. The document is
 * kept as JSON under `local-settings`, the key happy-app uses in MMKV.
 */
class LocalSettings(private val prefs: SharedPreferences) {
    private val state = MutableStateFlow(read())
    private val theme = MutableStateFlow(state.value.themePreference)

    val values: StateFlow<LocalSettingsValues> = state.asStateFlow()
    val themePreference: StateFlow<ThemePreference> = theme.asStateFlow()

    /** applyLocalSettings: [transform]'s result is stored and published. */
    @Synchronized
    fun change(transform: (LocalSettingsValues) -> LocalSettingsValues) {
        val next = transform(state.value)
        prefs.edit().putString(KEY_DOCUMENT, next.toJson().toString()).remove(KEY_THEME).apply()
        state.value = next
        theme.value = next.themePreference
    }

    fun setThemePreference(preference: ThemePreference) = change { it.copy(themePreference = preference) }

    @Synchronized
    fun clear() {
        prefs.edit().clear().apply()
        state.value = read()
        theme.value = state.value.themePreference
    }

    private fun read(): LocalSettingsValues {
        val document = prefs.getString(KEY_DOCUMENT, null)?.let {
            try {
                HappyJson.parseToJsonElement(it)
            } catch (_: SerializationException) {
                null
            } catch (_: IllegalArgumentException) {
                null
            }
        }
        val values = LocalSettingsValues.parse(document)
        // Builds before the document stored the theme alone.
        val legacyTheme = prefs.getString(KEY_THEME, null)?.let { w -> ThemePreference.entries.firstOrNull { it.wire == w } }
        return if (document == null && legacyTheme != null) values.copy(themePreference = legacyTheme) else values
    }

    companion object {
        const val PREFS_NAME = "local-settings"
        private const val KEY_DOCUMENT = "local-settings"
        private const val KEY_THEME = "themePreference"
    }
}
