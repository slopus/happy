package com.slopus.happy.ui.files

import android.content.Context
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.size
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator

/**
 * desktop d122790d (FilePreview's download control): a file saved to the
 * phone, and how that went. [Pending] while its bytes are written; [Saved]
 * once they are; [Failed] says so and a press tries again. This is the
 * outcome of pressing the control, not the file's own state.
 */
sealed interface FileSaveState {
    data object Idle : FileSaveState
    data object Pending : FileSaveState
    data object Saved : FileSaveState
    data object Failed : FileSaveState
}

/**
 * Saving one file where the person picks (the system's Save to, so no
 * permission is asked): [start] opens the picker, then [write]s the bytes
 * there. A press while one is pending does nothing; a cancelled pick goes
 * back to [FileSaveState.Idle].
 */
@Stable
class FileSave internal constructor(private val scope: CoroutineScope, private val write: suspend (Uri) -> Unit) {
    var state: FileSaveState by mutableStateOf(FileSaveState.Idle)
        internal set
    internal var pick: () -> Unit = {}
    private var job: Job? = null

    fun start() {
        if (state == FileSaveState.Pending) return
        state = FileSaveState.Pending
        pick()
    }

    /** The picker's answer: where to write, or null when the person backed out. */
    fun picked(uri: Uri?) {
        if (uri == null) {
            state = FileSaveState.Idle
            return
        }
        job?.cancel()
        job = scope.launch {
            state = try {
                write(uri)
                FileSaveState.Saved
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                FileSaveState.Failed
            }
        }
    }
}

/** What the system's Save to suggests for [name]: its type by extension, else bytes. */
internal fun saveMimeType(name: String): String =
    MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

/** Writes [bytes] to [uri] off the main thread; fails when the place can't be opened. */
internal suspend fun writeTo(context: Context, uri: Uri, bytes: ByteArray) = withContext(Dispatchers.IO) {
    val out = context.contentResolver.openOutputStream(uri, "wt") ?: throw java.io.IOException("No stream")
    out.use { it.write(bytes) }
}

/** A [FileSave] for [name], whose bytes [bytes] reads when the person has picked where. */
@Composable
fun rememberFileSave(name: String, bytes: suspend () -> ByteArray): FileSave {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val read by rememberUpdatedState(bytes)
    val save = remember(name) { FileSave(scope) { uri -> writeTo(context, uri, read()) } }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(saveMimeType(name))) { save.picked(it) }
    save.pick = {
        try {
            launcher.launch(name)
        } catch (_: android.content.ActivityNotFoundException) {
            save.state = FileSaveState.Failed
        }
    }
    return save
}

/**
 * The viewer bar's download control: the download glyph, a spinner while
 * pending, a check once saved, an alert once failed (pressing it again
 * tries again). TalkBack hears each outcome as it comes.
 */
@Composable
fun FileSaveButton(save: FileSave) {
    val colors = HappyTheme.colors
    val label = when (save.state) {
        FileSaveState.Idle -> stringResource(R.string.file_save)
        FileSaveState.Pending -> stringResource(R.string.file_saving)
        FileSaveState.Saved -> stringResource(R.string.file_saved)
        FileSaveState.Failed -> stringResource(R.string.file_save_failed)
    }
    IconButton(
        onClick = save::start,
        modifier = Modifier.testTag(FileTags.SAVE).semantics {
            contentDescription = label
            liveRegion = LiveRegionMode.Polite
        },
    ) {
        when (save.state) {
            FileSaveState.Pending -> CircularProgressIndicator(Modifier.size(18.dp), color = colors.textSecondary, strokeWidth = 2.dp)
            FileSaveState.Saved -> Icon(Ionicon.Checkmark, 22.dp, colors.success)
            FileSaveState.Failed -> Icon(Ionicon.AlertCircleOutline, 22.dp, colors.textDestructive)
            FileSaveState.Idle -> Icon(Ionicon.DownloadOutline, 22.dp, colors.text)
        }
    }
}
