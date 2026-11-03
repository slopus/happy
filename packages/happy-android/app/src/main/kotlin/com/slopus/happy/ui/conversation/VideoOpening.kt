package com.slopus.happy.ui.conversation

import android.media.MediaDataSource
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import com.slopus.happy.artifacts.VideoProbe
import com.slopus.happy.conversation.MediaRef
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Telegram's tap on a recording's play button (iOS `VideoOpening`,
 * 42121e99e): it plays as soon as its first playable range is on this
 * phone, never after the whole file. Until then the tile's play glyph is a
 * small spinner ([starting]); then the viewer comes up playing, from what is
 * here and what streams in, the rest reading on behind. A second tap while
 * it spins gives up; the file reads on. A screen gone meanwhile brings up
 * nothing, as its scope goes with it.
 *
 * "Playable" is the platform's retriever reading the recording's header
 * ([VideoProbe]) through the same ranged source the player reads.
 */
@Stable
class VideoOpening internal constructor(
    private val scope: CoroutineScope,
    private val source: (MediaRef) -> MediaDataSource?,
    private val ready: suspend (MediaDataSource) -> Unit = { withContext(Dispatchers.IO) { VideoProbe.read(it) } },
) {
    /** The tile's key whose recording is starting, or null. */
    var starting by mutableStateOf<String?>(null)
        private set
    private var job: Job? = null

    fun isStarting(key: String): Boolean = starting == key

    /** Plays [ref] with [play] once its first range is here, [key]'s tile spinning till then; tapped again while it spins, it stops. */
    fun open(key: String, ref: MediaRef, play: () -> Unit) {
        if (starting == key) {
            cancel()
            return
        }
        cancel()
        val read = source(ref) ?: return play()
        starting = key
        job = scope.launch {
            try {
                // A recording that can't be read plays anyway: the viewer says it can't.
                runCatching { ready(read) }.exceptionOrNull()?.let { if (it is kotlinx.coroutines.CancellationException) throw it }
            } finally {
                if (starting == key) starting = null
            }
            job = null
            play()
        }
    }

    /** Lets go of a recording still starting. */
    fun cancel() {
        job?.cancel()
        job = null
        starting = null
    }
}

/** This screen's [VideoOpening] over [source]; what is starting stops when the screen goes. */
@Composable
internal fun rememberVideoOpening(source: (MediaRef) -> MediaDataSource?): VideoOpening {
    val scope = rememberCoroutineScope()
    val current by rememberUpdatedState(source)
    return remember(scope) { VideoOpening(scope, { current(it) }) }
}
