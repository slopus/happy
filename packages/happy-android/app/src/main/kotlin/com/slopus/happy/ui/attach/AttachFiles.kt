package com.slopus.happy.ui.attach

import android.text.format.DateUtils
import android.text.format.Formatter
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.R
import com.slopus.happy.attachments.RecentFile
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import java.util.Locale

/** The File tab's sources: which rows head it. */
@Immutable
data class FileSources(
    /** Browse: the system's file picker. */
    val browse: Boolean = true,
    /** Gallery: photos and videos picked as files, sent as they are. */
    val gallery: Boolean = true,
    /** Paste: the image on the clipboard. */
    val paste: Boolean = true,
    /** Workspace: a file already on the agent's computer, named by its path (nothing uploaded). */
    val workspace: Boolean = false,
)

/**
 * Telegram's File tab (`ChatAttachAlertDocumentLayout`): its sources first,
 * each a coloured circle (Workspace #EB6060 where the agent's files can be
 * named, Browse #60C255, Gallery #F2C04B, Paste #5DAFEB),
 * then Recent files, the ones sent from here before, each a square with its
 * extension coloured by type. Rows are 64 tall, a divider under each, the
 * icon 42 at 15 in, the name 16 bold at 72. A file row picks and unpicks.
 */
@Composable
internal fun AttachFilesPage(
    sources: FileSources,
    recent: List<RecentFile>,
    selection: AttachSelection,
    padding: PaddingValues,
    state: LazyListState,
    sheet: Color,
    colors: AttachColors,
    onBrowse: () -> Unit,
    onGallery: () -> Unit,
    onPaste: () -> Unit,
    onToggle: (RecentFile) -> Unit,
    modifier: Modifier = Modifier,
    onWorkspace: () -> Unit = {},
) {
    LazyColumn(state = state, contentPadding = padding, modifier = modifier.fillMaxSize().testTag(AttachTags.FILES)) {
        if (sources.workspace) item(key = "workspace") {
            SourceRow(MaterialSymbols.Computer, SourceWorkspace, stringResource(R.string.attach_files_workspace), stringResource(R.string.attach_files_workspace_detail), onWorkspace, Modifier.testTag(AttachTags.WORKSPACE))
        }
        if (sources.browse) item(key = "browse") {
            SourceRow(MaterialSymbols.Folder, SourceStorage, stringResource(R.string.attach_files_browse), stringResource(R.string.attach_files_browse_detail), onBrowse, Modifier.testTag(AttachTags.BROWSE))
        }
        if (sources.gallery) item(key = "gallery") {
            SourceRow(MaterialSymbols.PhotoLibrary, SourceGallery, stringResource(R.string.attach_files_gallery), stringResource(R.string.attach_files_gallery_detail), onGallery, Modifier.testTag(AttachTags.FILES_GALLERY))
        }
        if (sources.paste) item(key = "paste") {
            SourceRow(MaterialSymbols.ContentPaste, SourcePaste, stringResource(R.string.attach_files_paste), stringResource(R.string.attach_files_paste_detail), onPaste, Modifier.testTag(AttachTags.PASTE))
        }
        if (recent.isNotEmpty()) {
            item(key = "recent") { RecentHeader(colors) }
            items(recent, key = { "file:" + it.uri }) { file ->
                FileRow(file, selection.number(file.uri), sheet, colors, onClick = { onToggle(file) })
            }
        }
    }
}

@Composable
private fun SourceRow(icon: ImageVector, tint: Color, title: String, detail: String, onClick: () -> Unit, modifier: Modifier) {
    Row64(onClick, modifier) {
        Box(Modifier.size(AttachSpec.fileIcon).clip(CircleShape).background(tint), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(24.dp))
        }
        RowText(title, detail)
    }
}

@Composable
private fun FileRow(file: RecentFile, number: Int, sheet: Color, colors: AttachColors, onClick: () -> Unit) {
    val context = LocalContext.current
    val details = remember(file) {
        val size = if (file.size > 0) Formatter.formatShortFileSize(context, file.size) else null
        val date = DateUtils.formatDateTime(context, file.sentAt, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_ABBREV_MONTH)
        listOfNotNull(size, date).joinToString(", ")
    }
    Row64(
        onClick,
        Modifier
            .semantics {
                role = Role.Checkbox
                selected = number > 0
            }
            .testTag(AttachTags.FILE_ROW),
    ) {
        Box(Modifier.size(AttachSpec.fileIcon)) {
            val extension = fileExtension(file.name)
            Box(
                Modifier.fillMaxSize().clip(RoundedCornerShape(6.dp)).background(fileTint(file.name).color),
                contentAlignment = Alignment.BottomStart,
            ) {
                Text(
                    extension.take(4).uppercase(Locale.ROOT),
                    style = happyTextStyle(11, weight = FontWeight.Bold).copy(fontSize = 11.sp),
                    color = Color.White,
                    maxLines = 1,
                    modifier = Modifier.padding(start = 6.dp, bottom = 5.dp),
                )
            }
            // SharedDocumentCell's check sits over the icon's bottom right.
            AttachCheck(
                number,
                sheet,
                colors,
                Modifier
                    .align(Alignment.BottomEnd)
                    .offset(x = 6.dp, y = 6.dp)
                    .graphicsLayer {
                        scaleX = 22f / 24f
                        scaleY = 22f / 24f
                        alpha = if (number > 0) 1f else 0f
                    },
            )
        }
        RowText(file.name, details)
    }
}

/** A 64 row: the 42 icon 12 down and 15 in, the text from 72, a divider under it from 72. */
@Composable
private fun Row64(onClick: () -> Unit, modifier: Modifier, content: @Composable () -> Unit) {
    Column(modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(AttachSpec.fileRow)
                .padding(start = AttachSpec.fileIconStart, end = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            content()
        }
        HorizontalDivider(Modifier.padding(start = AttachSpec.fileText), thickness = 1.dp, color = HappyTheme.colors.divider)
    }
}

@Composable
private fun RowText(title: String, detail: String) {
    val colors = HappyTheme.colors
    Column(Modifier.padding(start = AttachSpec.fileText - AttachSpec.fileIconStart - AttachSpec.fileIcon)) {
        Text(
            title,
            style = happyTextStyle(16, weight = FontWeight.SemiBold).copy(fontSize = AttachSpec.fileName),
            color = colors.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.height(3.dp))
        Text(
            detail,
            style = happyTextStyle(13).copy(fontSize = AttachSpec.fileDetails),
            color = colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** "Recent files", a section header in the accent where Telegram has its blue. */
@Composable
private fun RecentHeader(colors: AttachColors) {
    Text(
        stringResource(R.string.attach_files_recent),
        style = happyTextStyle(15, weight = FontWeight.SemiBold),
        color = colors.tabSelectedText,
        modifier = Modifier.padding(start = 21.dp, top = 15.dp, bottom = 8.dp).testTag(AttachTags.RECENT),
    )
}

/** A file's extension, lower case, without the dot; empty when it has none. */
fun fileExtension(name: String): String = name.substringAfterLast('.', "").takeIf { it.length in 1..8 && !it.contains(' ') }?.lowercase(Locale.ROOT) ?: ""

/** Telegram's document colours, by extension (`AndroidUtilities.getThumbForNameOrMime`). */
enum class FileTint(val color: Color) {
    Blue(Color(0xFF519AE8)),
    Green(Color(0xFF5FBB6A)),
    Red(Color(0xFFEA6A5F)),
    Yellow(Color(0xFFF0B23F)),
}

fun fileTint(name: String): FileTint {
    val extension = fileExtension(name)
    return when (extension) {
        "doc", "docx", "txt", "psd" -> FileTint.Blue
        "xls", "xlsx", "csv" -> FileTint.Green
        "pdf", "ppt", "pptx", "key" -> FileTint.Red
        "zip", "rar", "ai", "mp3", "mov", "avi" -> FileTint.Yellow
        "" -> FileTint.Blue
        else -> FileTint.entries[extension[0].code % FileTint.entries.size]
    }
}

/** A file waiting in the composer: its type's colour and its extension, as the File tab draws it. */
@Composable
fun AttachedFileTile(name: String, modifier: Modifier = Modifier) {
    Box(modifier.background(fileTint(name).color), contentAlignment = Alignment.Center) {
        Icon(MaterialSymbols.InsertDriveFile, contentDescription = name, tint = Color.White.copy(alpha = 0.9f), modifier = Modifier.size(24.dp))
        Text(
            fileExtension(name).take(4).uppercase(Locale.ROOT),
            style = happyTextStyle(11, weight = FontWeight.Bold).copy(fontSize = 11.sp),
            color = Color.White,
            maxLines = 1,
            modifier = Modifier.align(Alignment.BottomStart).padding(start = 6.dp, bottom = 4.dp),
        )
    }
}

private val SourceStorage = Color(0xFF60C255)
private val SourceGallery = Color(0xFFF2C04B)
private val SourcePaste = Color(0xFF5DAFEB)
// Telegram's one source colour left (`key_chat_attachAudioBackground`, its Music row's).
private val SourceWorkspace = Color(0xFFEB6060)
