package com.slopus.happy.config

import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.net.URI
import java.net.URISyntaxException

/**
 * Which Happy server the app talks to. Mirrors
 * packages/happy-app/sources/sync/serverConfig.ts: a custom URL lives in its
 * own preferences file so it survives logout, and the default applies when
 * none is set.
 */
class ServerConfig(
    private val prefs: SharedPreferences,
    val defaultUrl: String,
) {
    private val state = MutableStateFlow(read())

    /** The server URL in effect, without a trailing slash. */
    val url: StateFlow<String> = state.asStateFlow()

    val isCustom: Boolean get() = state.value != defaultUrl

    /** serverConfig.ts: voice defaults to Happy's server, even for a self-hosted account. */
    var useCustomServerForVoice: Boolean
        get() = isCustom && prefs.getBoolean("use-custom-server-for-voice", false)
        set(value) { prefs.edit().putBoolean("use-custom-server-for-voice", value).apply() }

    val voiceUrl: String get() = if (useCustomServerForVoice) url.value else defaultUrl

    /** `host[:port]` of a custom server, for the header subtitle; null on the default server. */
    val customHostLabel: String?
        get() {
            if (!isCustom) return null
            return try {
                val uri = URI(state.value)
                if (uri.port >= 0) "${uri.host}:${uri.port}" else uri.host
            } catch (_: URISyntaxException) {
                state.value
            }
        }

    /** A blank or null URL resets to the default. Call [validate] first. */
    fun set(url: String?) {
        val trimmed = url?.trim()?.trimEnd('/')
        if (trimmed.isNullOrEmpty() || trimmed == defaultUrl) {
            prefs.edit().remove(KEY).apply()
        } else {
            prefs.edit().putString(KEY, trimmed).apply()
        }
        state.value = read()
    }

    private fun read(): String = prefs.getString(KEY, null) ?: defaultUrl

    sealed interface Validation {
        data object Valid : Validation
        data object Empty : Validation
        data object NotHttp : Validation
        data object Malformed : Validation
    }

    companion object {
        const val PREFS_NAME = "server-config"
        private const val KEY = "custom-server-url"

        /** validateServerUrl */
        fun validate(url: String): Validation {
            val trimmed = url.trim()
            if (trimmed.isEmpty()) return Validation.Empty
            val uri = try {
                URI(trimmed)
            } catch (_: URISyntaxException) {
                return Validation.Malformed
            }
            val scheme = uri.scheme?.lowercase() ?: return Validation.Malformed
            if (scheme != "http" && scheme != "https") return Validation.NotHttp
            if (uri.host.isNullOrEmpty()) return Validation.Malformed
            return Validation.Valid
        }
    }
}
