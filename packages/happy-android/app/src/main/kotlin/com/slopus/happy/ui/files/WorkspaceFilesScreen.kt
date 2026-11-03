package com.slopus.happy.ui.files

import android.text.format.Formatter
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.agent.WorkspaceFiles
import com.slopus.happy.text.wordsResource
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.barInsetTop
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.components.shimmer
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator

object WorkspaceFilesTags {
    const val LIST = "workspaceFiles.list"
    const val ROW = "workspaceFiles.row"
    const val ROW_NAME = "workspaceFiles.row.name"
    const val ROW_META = "workspaceFiles.row.meta"
    const val ROW_ICON = "workspaceFiles.row.icon"
    const val PLACEHOLDER = "workspaceFiles.placeholder"
    const val EMPTY = "workspaceFiles.empty"
    const val ERROR = "workspaceFiles.error"
    const val RETRY = "workspaceFiles.retry"
    const val MORE = "workspaceFiles.more"
}

/**
 * Telegram's document row (SharedDocumentCell.java, `VIEW_TYPE_DEFAULT`,
 * 56 tall; FlickerLoadingView.java:386 `FILES_TYPE` draws the same box)
 * in this app's type: a 40 square tile 12 in and 8 down (rounded 4),
 * the name (16) and its line (13) from 72, a hairline from 72 to the end.
 */
object WorkspaceFilesSpec {
    val row = 56.dp
    val tile = 40.dp
    val tileX = 12.dp
    val tileCorner = 4.dp
    val glyph = 22.dp
    val textX = 72.dp
    val trailing = 16.dp
    const val PLACEHOLDER_ROWS = 10
    /** Rows from the end at which the next page is asked for. */
    const val PREFETCH = 20

    val name = happyTextStyle(fontSize = 16, lineHeight = 20)
    val meta = happyTextStyle(fontSize = 13, lineHeight = 17)
}

/**
 * desktop's All Files (FileBrowser.tsx, C-168, a lazy tree) one level per
 * screen, as Telegram's document picker walks folders
 * (ChatAttachAlertDocumentLayout.java `listFiles`, each folder a step back
 * can undo): under the standard bar titled [title], the folder's entries,
 * folders first. A folder reads "Folder", a file its size. While the first
 * page loads, Telegram's flickering placeholder rows; a failure says why
 * with Retry; nothing in it, "This folder is empty". The next page is read
 * as the last rows come near, with a spinner at the end meanwhile.
 */
@Composable
fun WorkspaceFilesScreen(
    title: String,
    state: WorkspaceFolder.State,
    onBack: () -> Unit,
    onOpen: (WorkspaceFiles.Entry) -> Unit,
    onRetry: () -> Unit = {},
    onMore: () -> Unit = {},
) {
    val colors = HappyTheme.colors
    Screen(header = { StackHeader(title, onBack) }, ground = colors.surface) {
        when {
            state.loading -> Placeholders()
            state.error != null && state.entries.isEmpty() -> FolderMessage(wordsResource(state.error), WorkspaceFilesTags.ERROR, onRetry)
            state.empty -> FolderMessage(stringResource(R.string.workspace_folder_empty), WorkspaceFilesTags.EMPTY, null)
            else -> Entries(state, onOpen, onMore)
        }
    }
}

@Composable
private fun Entries(state: WorkspaceFolder.State, onOpen: (WorkspaceFiles.Entry) -> Unit, onMore: () -> Unit) {
    val list = rememberLazyListState()
    val nearEnd by remember(state.entries.size) {
        derivedStateOf { (list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) >= state.entries.size - WorkspaceFilesSpec.PREFETCH }
    }
    LaunchedEffect(nearEnd, state.nextCursor) { if (nearEnd && state.nextCursor != null) onMore() }
    LazyColumn(
        state = list,
        modifier = Modifier.fillMaxSize().testTag(WorkspaceFilesTags.LIST),
        contentPadding = PaddingValues(top = barInsetTop(), bottom = 32.dp),
    ) {
        itemsIndexed(state.entries, key = { _, entry -> entry.path }, contentType = { _, _ -> "entry" }) { index, entry ->
            EntryRow(entry, last = index == state.entries.lastIndex && state.nextCursor == null) { onOpen(entry) }
        }
        if (state.nextCursor != null) {
            item(key = "more", contentType = "more") {
                Box(Modifier.contentMaxWidth(LocalWindowLayout.current).fillMaxWidth().height(WorkspaceFilesSpec.row).testTag(WorkspaceFilesTags.MORE), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = HappyTheme.colors.textSecondary, strokeWidth = 2.dp)
                }
            }
        }
    }
}

@Composable
private fun EntryRow(entry: WorkspaceFiles.Entry, last: Boolean, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val context = LocalContext.current
    val meta = if (entry.directory) stringResource(R.string.workspace_folder) else remember(entry.size) { Formatter.formatShortFileSize(context, entry.size) }
    val divider = colors.divider
    Row(
        Modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .fillMaxWidth()
            .heightIn(min = WorkspaceFilesSpec.row)
            .testTag(WorkspaceFilesTags.ROW)
            .clickable(role = Role.Button, onClick = onClick)
            .drawBehind {
                if (!last) {
                    val y = size.height - 0.5f
                    drawLine(divider, Offset(WorkspaceFilesSpec.textX.toPx(), y), Offset(size.width, y), 1f)
                }
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .padding(start = WorkspaceFilesSpec.tileX)
                .size(WorkspaceFilesSpec.tile)
                .clip(RoundedCornerShape(WorkspaceFilesSpec.tileCorner))
                .background(colors.surfaceHigh)
                .testTag(WorkspaceFilesTags.ROW_ICON),
            contentAlignment = Alignment.Center,
        ) {
            if (entry.directory) Icon(Ionicon.Folder, WorkspaceFilesSpec.glyph, colors.textLink) else FileIcon(entry.name, WorkspaceFilesSpec.glyph)
        }
        Column(
            Modifier
                .padding(start = WorkspaceFilesSpec.textX - WorkspaceFilesSpec.tileX - WorkspaceFilesSpec.tile, end = WorkspaceFilesSpec.trailing)
                .weight(1f)
                .padding(vertical = 8.dp),
        ) {
            Text(entry.name, style = WorkspaceFilesSpec.name, color = colors.text, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.testTag(WorkspaceFilesTags.ROW_NAME))
            Text(meta, style = WorkspaceFilesSpec.meta, color = colors.textSecondary, maxLines = 1, modifier = Modifier.padding(top = 2.dp).testTag(WorkspaceFilesTags.ROW_META))
        }
        if (entry.directory) Icon(Ionicon.ChevronForward, 18.dp, colors.textSecondary, Modifier.padding(end = WorkspaceFilesSpec.trailing))
    }
}

/** FlickerLoadingView's FILES_TYPE rows: the tile and two bars, under one moving sheen (still with animations off). */
@Composable
private fun Placeholders() {
    val colors = HappyTheme.colors
    val ground = colors.surfaceHighest
    val still = rememberReduceMotion()
    val sheen = if (still) Modifier else Modifier.shimmer(lerp(ground, if (colors.dark) Color.White else Color.Black, 0.06f))
    Column(Modifier.fillMaxSize().padding(top = barInsetTop()).testTag(WorkspaceFilesTags.PLACEHOLDER)) {
        repeat(WorkspaceFilesSpec.PLACEHOLDER_ROWS) {
            Box(Modifier.contentMaxWidth(LocalWindowLayout.current).fillMaxWidth().height(WorkspaceFilesSpec.row)) {
                Box(Modifier.offset(12.dp, 8.dp).size(40.dp).clip(RoundedCornerShape(4.dp)).background(ground).then(sheen))
                Box(Modifier.offset(68.dp, 12.dp).size(72.dp, 8.dp).clip(RoundedCornerShape(4.dp)).background(ground).then(sheen))
                Box(Modifier.offset(68.dp, 34.dp).size(192.dp, 8.dp).clip(RoundedCornerShape(4.dp)).background(ground).then(sheen))
            }
        }
    }
}

@Composable
private fun FolderMessage(message: String, tag: String, onRetry: (() -> Unit)?) {
    val colors = HappyTheme.colors
    Column(
        Modifier.fillMaxSize().padding(20.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(message, style = happyTextStyle(fontSize = 14), color = colors.textSecondary, textAlign = TextAlign.Center, modifier = Modifier.testTag(tag))
        if (onRetry != null) {
            Text(
                stringResource(R.string.common_retry),
                style = happyTextStyle(fontSize = 14, weight = FontWeight.SemiBold),
                color = colors.text,
                modifier = Modifier.padding(top = 8.dp).testTag(WorkspaceFilesTags.RETRY).clickable(role = Role.Button, onClick = onRetry).padding(12.dp),
            )
        }
    }
}

