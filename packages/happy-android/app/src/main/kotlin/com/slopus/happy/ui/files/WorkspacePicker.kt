package com.slopus.happy.ui.files

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.R

/** A workspace a file can be picked from: its [name] for the root's title, and how its folders read. */
@Immutable
class WorkspaceSource(val name: String?, val pages: FolderPages)

object WorkspacePickerTags {
    const val PICKER = "workspacePicker"
}

/**
 * The workspace browser in pick mode (Telegram's ChatAttachAlertDocumentLayout
 * over the attach sheet, its folders a step back can undo): the same rows as
 * Files, a folder opening the next level in place, back going up one, out of
 * the root closing. A file is [onPick]ed by its path from the root.
 */
@Composable
fun WorkspaceFilePicker(source: WorkspaceSource, onPick: (String) -> Unit, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    // Each level read once: going back shows what was listed.
    val levels = remember(source) { mutableStateListOf(WorkspaceFolder(scope, source.pages, "")) }
    val folder = levels.last()
    LaunchedEffect(folder) { if (folder.state.value.entries.isEmpty()) folder.open() }
    val state by folder.state.collectAsStateWithLifecycle()
    fun back() {
        if (levels.size > 1) levels.removeAt(levels.lastIndex) else onClose()
    }
    Dialog(onDismissRequest = ::back, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.testTag(WorkspacePickerTags.PICKER)) {
            WorkspaceFilesScreen(
                title = folder.path.substringAfterLast('/').ifEmpty { source.name ?: stringResource(R.string.common_files) },
                state = state,
                onBack = ::back,
                onOpen = { entry ->
                    if (entry.directory) levels.add(WorkspaceFolder(scope, source.pages, entry.path)) else onPick(entry.path)
                },
                onRetry = folder::open,
                onMore = folder::more,
            )
        }
    }
}

/**
 * The composer's [text] naming [path] in the workspace the way a turn
 * names an attached file (desktop's `rigAttachmentTextAppend`, `./path`):
 * after what was typed, a space apart; nothing is uploaded.
 */
fun withWorkspacePath(text: String, path: String): String {
    val named = "./" + path.trimStart('/')
    return when {
        text.isEmpty() -> named
        text.last().isWhitespace() -> text + named
        else -> "$text $named"
    }
}
