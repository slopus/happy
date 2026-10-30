package com.slopus.happy.ui.conversation

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.core.content.FileProvider
import com.slopus.happy.R
import com.slopus.happy.conversation.MediaFiles
import com.slopus.happy.conversation.MediaRef
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What a presented video or file is doing: nothing, being read, or why it couldn't open. */
sealed interface MediaOpening {
    data object Reading : MediaOpening
    data class Failed(val reason: String) : MediaOpening
}

/**
 * Opens a conversation's videos and files in whatever on the phone reads
 * them: the bytes are read through the agent connection, written to the
 * app's own media directory ([MediaFiles]) and handed over as one
 * read-only URI. Tapping a second time while it reads stops that read.
 * Nothing is written anywhere a person can browse, and no permission is
 * asked for.
 */
@Stable
class MediaOpener internal constructor(
    private val context: Context,
    private val scope: CoroutineScope,
    private val load: suspend (MediaRef) -> ByteArray,
    private val text: MediaOpenerText,
) {
    private val running = mutableStateMapOf<String, Job>()
    internal val states = mutableStateMapOf<String, MediaOpening>()

    fun state(ref: MediaRef): MediaOpening? = states[ref.key]

    /** Reads [ref] and opens it; tapped again while reading, it stops. */
    fun open(ref: MediaRef) {
        running.remove(ref.key)?.let {
            it.cancel()
            states.remove(ref.key)
            return
        }
        states[ref.key] = MediaOpening.Reading
        running[ref.key] = scope.launch {
            try {
                val bytes = load(ref)
                val file = withContext(Dispatchers.IO) { MediaFiles.stage(context.cacheDir, ref.key, ref.item, bytes) }
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.conversation.media", file)
                val intent = Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, ref.item.mimeType)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    context.startActivity(intent)
                    states.remove(ref.key)
                } catch (_: ActivityNotFoundException) {
                    states[ref.key] = MediaOpening.Failed(text.noApp)
                }
            } catch (e: CancellationException) {
                states.remove(ref.key)
                throw e
            } catch (_: Exception) {
                // The reason never carries the file's own content.
                states[ref.key] = MediaOpening.Failed(text.failed)
            } finally {
                running.remove(ref.key)
            }
        }
    }
}

internal data class MediaOpenerText(val noApp: String, val failed: String)

/** The opener this screen uses; its reads stop when the screen goes. */
@Composable
internal fun rememberMediaOpener(load: suspend (MediaRef) -> ByteArray): MediaOpener {
    val context = LocalContext.current
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf<MediaOpener?>(null) }
    return current ?: MediaOpener(
        context = context,
        scope = scope,
        load = load,
        text = MediaOpenerText(
            noApp = resources.getString(R.string.conversation_media_no_app),
            failed = resources.getString(R.string.conversation_media_failed),
        ),
    ).also { current = it }
}
