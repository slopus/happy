package com.slopus.happy.media

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateMapOf

/** Where one media file is on its way to this phone, in bytes, as Telegram's ring and size badge show it (iOS `DownloadPhase`). */
@Immutable
sealed interface DownloadPhase {
    /** The whole length, when known. */
    val total: Long?

    /** Nothing of it is here. */
    data class Remote(override val total: Long?) : DownloadPhase

    /** Being read: [done] of [total]. */
    data class Downloading(val done: Long, override val total: Long?) : DownloadPhase

    /** Stopped by a tap: what is here stays for a resume. */
    data class Paused(val done: Long, override val total: Long?) : DownloadPhase

    /** The last read failed; a tap tries again from where it stopped. */
    data class Failed(val done: Long, override val total: Long?) : DownloadPhase

    /** All of it is on this phone. */
    data class Complete(override val total: Long) : DownloadPhase

    val isComplete: Boolean get() = this is Complete

    /** The share read, for the ring; null while the size isn't known. */
    val share: Float?
        get() = when (this) {
            is Remote -> 0f
            is Complete -> 1f
            is Downloading -> share(done, total)
            is Paused -> share(done, total)
            is Failed -> share(done, total)
        }

    private fun share(done: Long, total: Long?): Float? = total?.takeIf { it > 0 }?.let { minOf(1f, done.toFloat() / it) }
}

/**
 * Every media file's download in one account's library, by its ID (iOS
 * `DownloadBoard`). Downloads write from their own threads; each tile reads
 * its own key, so bytes arriving redraw that ring and badge and nothing else.
 */
@Stable
class DownloadBoard {
    private val phases = mutableStateMapOf<String, DownloadPhase>()

    fun phase(key: String): DownloadPhase? = phases[key]

    internal fun set(key: String, phase: DownloadPhase) {
        if (phases[key] != phase) phases[key] = phase
    }

    /** Every file forgotten (Clear Media): each tile asks again where its file is. */
    internal fun clear() {
        phases.clear()
    }
}
