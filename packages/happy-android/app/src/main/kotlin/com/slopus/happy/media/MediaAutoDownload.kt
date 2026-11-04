package com.slopus.happy.media

import android.content.SharedPreferences
import androidx.compose.runtime.Immutable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Telegram's Data and Storage › Automatic Media Download, for this phone
 * (iOS `MediaAutoDownload`): which kinds of chat media are read as soon as
 * they show up, so they are here offline, and up to what size. One setting
 * for every network, as on iOS.
 */
@Immutable
@Serializable
data class MediaAutoDownload(
    val photos: Rule = Rule(true, 10 * MEGABYTE),
    val videos: Rule = Rule(false, 10 * MEGABYTE),
    val files: Rule = Rule(true, 1 * MEGABYTE),
) {
    @Serializable
    enum class Kind { Photos, Videos, Files }

    /** On or off, and in bytes the largest file read without a tap. */
    @Immutable
    @Serializable
    data class Rule(val enabled: Boolean, val limit: Long)

    operator fun get(kind: Kind): Rule = when (kind) {
        Kind.Photos -> photos
        Kind.Videos -> videos
        Kind.Files -> files
    }

    fun with(kind: Kind, rule: Rule): MediaAutoDownload = when (kind) {
        Kind.Photos -> copy(photos = rule)
        Kind.Videos -> copy(videos = rule)
        Kind.Files -> copy(files = rule)
    }

    /** Whether a file of [kind] and [size] is read without a tap: a photo of unknown size is (one is rarely large), nothing else is. */
    fun allows(kind: Kind, size: Long?): Boolean {
        val rule = this[kind]
        if (!rule.enabled) return false
        return if (size == null) kind == Kind.Photos else size <= rule.limit
    }

    companion object {
        const val MEGABYTE = 1024L * 1024
        /** The limits the setting offers. */
        val limits = listOf(1L, 5, 10, 25, 50, 100).map { it * MEGABYTE }
    }
}

/** [MediaAutoDownload] kept on this phone for every account, so signing out doesn't reset it. */
class MediaAutoDownloadSetting(private val prefs: SharedPreferences) {
    private val state = MutableStateFlow(read())

    val rules: StateFlow<MediaAutoDownload> = state.asStateFlow()

    fun change(transform: (MediaAutoDownload) -> MediaAutoDownload) {
        synchronized(this) {
            val next = transform(state.value)
            prefs.edit().putString(KEY, json.encodeToString(MediaAutoDownload.serializer(), next)).apply()
            state.value = next
        }
    }

    private fun read(): MediaAutoDownload =
        prefs.getString(KEY, null)?.let { runCatching { json.decodeFromString(MediaAutoDownload.serializer(), it) }.getOrNull() } ?: MediaAutoDownload()

    companion object {
        const val PREFS_NAME = "media"
        private const val KEY = "media.autoDownload"
        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    }
}
