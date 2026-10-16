package com.slopus.happy.ui.diff

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.slopus.happy.diff.DiffDocument
import com.slopus.happy.diff.DiffRow
import com.slopus.happy.diff.DiffSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Inputs up to this many UTF-16 units are built in place; larger ones on a background thread. */
const val DIFF_SYNC_BUILD_LIMIT = 16_000

/**
 * useDiffDocument: [source] built into a document (the engine caches
 * builds). A large source is built off the main thread and reads as
 * [DiffDocument.Empty] until it is ready; null is always empty.
 */
@Composable
fun rememberDiffDocument(source: DiffSource?, contextLines: Int? = null, ignoreWhitespace: Boolean? = null): DiffDocument {
    if (source == null) return DiffDocument.Empty
    if (source.size <= DIFF_SYNC_BUILD_LIMIT) return remember(source, contextLines, ignoreWhitespace) { source.build(contextLines, ignoreWhitespace) }
    val document by produceState(DiffDocument.Empty, source, contextLines, ignoreWhitespace) {
        value = withContext(Dispatchers.Default) { source.build(contextLines, ignoreWhitespace) }
    }
    return document
}

/**
 * The chat-sized diff (DiffChunk.tsx): what an agent's edit looks like
 * mid-conversation. Every file of [source] as a [DiffFileView] with no file
 * header (the tool card draws one), [contextLines] of context, collapsed
 * after [collapseAfter] rows, `@@` bars only when a file has more than one
 * hunk. Nothing at all when there are no files.
 */
@Composable
fun DiffChunk(
    source: DiffSource,
    modifier: Modifier = Modifier,
    showLineNumbers: Boolean = true,
    layout: DiffLayoutMode = DiffLayoutMode.Scroll,
    contextLines: Int = 3,
    collapseAfter: Int = 80,
    fontSize: Float = DiffMetrics.DEFAULT_FONT_SIZE,
) {
    val document = rememberDiffDocument(source, contextLines)
    if (document.files.isEmpty()) return
    Column(modifier = modifier.fillMaxWidth().testTag(DiffTags.CHUNK)) {
        for (file in document.files) {
            DiffFileView(
                file = file,
                fontSize = fontSize,
                showLineNumbers = showLineNumbers,
                layout = layout,
                collapseAfter = collapseAfter,
                showHunkHeaders = file.rows.count { it is DiffRow.Hunk } > 1,
            )
        }
    }
}

/**
 * DiffChunk.tsx's props: a unified [patch] wins; otherwise the
 * [oldText]/[newText] pair, named [fileName] (which picks the syntax).
 * Nothing when neither is given.
 */
@Composable
fun DiffChunk(
    modifier: Modifier = Modifier,
    patch: String? = null,
    oldText: String? = null,
    newText: String? = null,
    fileName: String? = null,
    showLineNumbers: Boolean = true,
    layout: DiffLayoutMode = DiffLayoutMode.Scroll,
    contextLines: Int = 3,
    collapseAfter: Int = 80,
    fontSize: Float = DiffMetrics.DEFAULT_FONT_SIZE,
) {
    val source = remember(patch, oldText, newText, fileName) {
        when {
            !patch.isNullOrEmpty() -> DiffSource.Patch(patch)
            oldText != null || newText != null -> DiffSource.Contents(fileName ?: "file.txt", oldText.orEmpty(), newText.orEmpty())
            else -> null
        }
    } ?: return
    DiffChunk(source, modifier, showLineNumbers, layout, contextLines, collapseAfter, fontSize)
}
