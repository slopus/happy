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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalResources
import androidx.core.content.FileProvider
import com.slopus.happy.R
import com.slopus.happy.conversation.MediaFiles
import com.slopus.happy.conversation.MediaItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.slopus.happy.ui.components.TrackOverlay

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
    private val text: MediaOpenerText,
) {
    private val running = mutableStateMapOf<String, Job>()
    internal val states = mutableStateMapOf<String, MediaOpening>()

    fun state(key: String): MediaOpening? = states[key]

    /** A presented text, source or Markdown file shown in the app ([MediaPreview]); null when none is. */
    var preview: PresentedFile? by mutableStateOf(null)
        internal set

    /**
     * Reads [item] with [load] and opens it; tapped again while reading, it
     * stops. With [inApp], a file whose name says it is Markdown, source or
     * text (and not over [PresentedFile.MAX_BYTES]) opens in the app's own
     * file viewer when its bytes read as text (desktop 24f532b3, 30b9e165);
     * anything else goes to whatever on the phone opens it.
     */
    fun open(key: String, item: MediaItem, inApp: Boolean = false, load: suspend () -> ByteArray) {
        running.remove(key)?.let {
            it.cancel()
            states.remove(key)
            return
        }
        states[key] = MediaOpening.Reading
        running[key] = scope.launch {
            try {
                val bytes = load()
                if (inApp && PresentedFile.previews(item)) {
                    val shown = withContext(Dispatchers.Default) { com.slopus.happy.ui.files.fileLoadOf(item.name, bytes) }
                    if (shown is com.slopus.happy.ui.files.FileLoad.Loaded) {
                        preview = PresentedFile(item.name, bytes, shown)
                        states.remove(key)
                        return@launch
                    }
                }
                val file = withContext(Dispatchers.IO) { MediaFiles.stage(context.cacheDir, key, item, bytes) }
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.conversation.media", file)
                val intent = Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, item.mimeType)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    context.startActivity(intent)
                    states.remove(key)
                } catch (_: ActivityNotFoundException) {
                    states[key] = MediaOpening.Failed(text.noApp)
                }
            } catch (e: CancellationException) {
                states.remove(key)
                throw e
            } catch (_: Exception) {
                // The reason never carries the file's own content.
                states[key] = MediaOpening.Failed(text.failed)
            } finally {
                running.remove(key)
            }
        }
    }
}

/** A presented file read whole and shown in the app's file viewer. */
class PresentedFile(val name: String, val bytes: ByteArray, val load: com.slopus.happy.ui.files.FileLoad) {
    companion object {
        /** desktop 24f532b3: a file over 2 MB is not read for a preview. */
        const val MAX_BYTES = 2L * 1024 * 1024

        private val TEXT = setOf("txt", "text", "log", "csv", "tsv", "toml", "ini", "cfg", "conf", "env", "diff", "patch", "gradle", "kts", "h", "hpp", "m", "mm", "cs", "scala", "lua", "r", "pl", "dart", "vue", "svelte", "zsh", "fish", "ps1", "proto", "graphql", "tex", "rst", "adoc")

        /** Its name says it reads as text: Markdown, source or plain text (desktop takes the kind from the name). */
        fun previews(item: MediaItem): Boolean {
            if ((item.size ?: 0.0) > MAX_BYTES) return false
            val name = item.name.substringAfterLast('/')
            val extension = name.substringAfterLast('.', "").lowercase()
            return com.slopus.happy.ui.files.isMarkdownPath(name) || com.slopus.happy.ui.files.fileLanguage(name) != null ||
                extension in TEXT || name in setOf("Makefile", "Dockerfile", "LICENSE", "README")
        }
    }
}

/**
 * The opener's in-app preview, over everything: the file viewer (text with
 * its syntax, Markdown rendered with its source a tab away) with a save to
 * the phone from its bar; back closes it.
 */
@Composable
internal fun MediaPreview(opener: MediaOpener) {
    val shown = opener.preview ?: return
    val save = com.slopus.happy.ui.files.rememberFileSave(shown.name) { shown.bytes }
    TrackOverlay(true) { opener.preview = null }
    androidx.compose.ui.window.Dialog(
        onDismissRequest = { opener.preview = null },
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        androidx.compose.foundation.layout.Box(androidx.compose.ui.Modifier.testTag(MediaPreviewTags.PREVIEW)) {
            com.slopus.happy.ui.files.FileScreen(shown.load, shown.name, onBack = { opener.preview = null }, save = save)
        }
    }
}

object MediaPreviewTags {
    const val PREVIEW = "mediaPreview"
}

internal data class MediaOpenerText(val noApp: String, val failed: String)

/** The opener this screen uses; its reads stop when the screen goes. */
@Composable
internal fun rememberMediaOpener(): MediaOpener {
    val context = LocalContext.current
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf<MediaOpener?>(null) }
    return current ?: MediaOpener(
        context = context,
        scope = scope,
        text = MediaOpenerText(
            noApp = resources.getString(R.string.conversation_media_no_app),
            failed = resources.getString(R.string.conversation_media_failed),
        ),
    ).also { current = it }
}
