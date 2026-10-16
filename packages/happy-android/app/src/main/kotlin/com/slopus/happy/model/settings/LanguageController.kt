package com.slopus.happy.model.settings

import android.app.LocaleManager
import android.content.Context
import android.content.SharedPreferences
import android.content.res.Resources
import android.os.Build
import android.os.LocaleList
import com.slopus.happy.model.Settings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * The UI language, as happy-app's text/index.ts picks it: once, at start,
 * from the synced `preferredLanguage` (else the device's locales). A change
 * made on another device is kept for the next start; one made here applies
 * when the user confirms the restart ([apply]).
 *
 * [language] drives a configuration override around the Compose UI
 * (`LocalizedContent`); on Android 13+ the choice also goes to
 * [LocaleManager], so text outside Compose follows it.
 */
class LanguageController(
    private val context: Context,
    private val prefs: SharedPreferences,
    private val systemLocales: () -> List<Locale> = ::systemLocaleList,
) {
    private val state = MutableStateFlow(resolve(prefs.getString(KEY_PREFERRED, null)))

    /** The language the UI is in now. */
    val language: StateFlow<Language> = state.asStateFlow()

    /** Remembers [settings]' `preferredLanguage` for the next start, as happy-app's settings cache does. */
    fun follow(settings: StateFlow<Settings>, scope: CoroutineScope) {
        scope.launch {
            settings.map { it.preferredLanguage }.distinctUntilChanged().collect { remember(it) }
        }
    }

    /** The restart after a change: [preferred] (null for automatic) takes effect now. */
    fun apply(preferred: String?) {
        remember(preferred)
        state.value = resolve(preferred)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.getSystemService(LocaleManager::class.java)?.applicationLocales =
                if (Languages.byCode(preferred) != null) LocaleList(state.value.locale) else LocaleList.getEmptyLocaleList()
        }
    }

    /** The device's locales, for "Automatic (…)". */
    fun deviceLocales(): List<Locale> = systemLocales()

    private fun remember(preferred: String?) {
        prefs.edit().apply { if (preferred == null) remove(KEY_PREFERRED) else putString(KEY_PREFERRED, preferred) }.apply()
    }

    private fun resolve(preferred: String?) = Languages.resolve(preferred, systemLocales())

    companion object {
        const val PREFS_NAME = "language"
        private const val KEY_PREFERRED = "preferredLanguage"

        /** The system's locales, not the app's override (expo-localization's getLocales). */
        fun systemLocaleList(): List<Locale> {
            val locales = Resources.getSystem().configuration.locales
            return (0 until locales.size()).map { locales[it] }
        }
    }
}
