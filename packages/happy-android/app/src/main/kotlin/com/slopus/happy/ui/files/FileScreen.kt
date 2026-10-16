package com.slopus.happy.ui.files

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.sync.SessionFileCache
import com.slopus.happy.ui.chat.ChatTheme
import com.slopus.happy.ui.chat.highlight
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlin.math.max

object FileTags {
    const val PATH_BAR = "file.pathBar"
    const val TOGGLE_BAR = "file.toggleBar"
    const val DIFF_TAB = "file.diffTab"
    const val FILE_TAB = "file.fileTab"
    const val DIFF_LINE = "file.diffLine"
    const val CODE = "file.code"
    const val SPINNER = "file.spinner"
    const val SCROLL = "file.scroll"
}

/** What file.tsx loaded: still loading, failed, binary, or the text and its uncommitted diff. */
sealed interface FileLoad {
    data object Loading : FileLoad
    data class Failed(val message: String) : FileLoad
    data object Binary : FileLoad
    data class Loaded(val content: String, val diff: String?) : FileLoad
}

/** file.tsx `getFileLanguage`: the SimpleSyntaxHighlighter language for an extension. */
fun fileLanguage(path: String): String? = when (path.substringAfterLast('.').lowercase()) {
    "js", "jsx" -> "javascript"
    "ts", "tsx" -> "typescript"
    "py" -> "python"
    "html", "htm" -> "html"
    "css" -> "css"
    "json" -> "json"
    "md" -> "markdown"
    "xml" -> "xml"
    "yaml", "yml" -> "yaml"
    "sh", "bash" -> "bash"
    "sql" -> "sql"
    "go" -> "go"
    "rust", "rs" -> "rust"
    "java" -> "java"
    "c" -> "c"
    "cpp", "cc", "cxx" -> "cpp"
    "php" -> "php"
    "rb" -> "ruby"
    "swift" -> "swift"
    "kt" -> "kotlin"
    else -> null
}

private val binaryExtensions = setOf(
    "png", "jpg", "jpeg", "gif", "bmp", "svg", "ico",
    "mp4", "avi", "mov", "wmv", "flv", "webm",
    "mp3", "wav", "flac", "aac", "ogg",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "zip", "tar", "gz", "rar", "7z",
    "exe", "dmg", "deb", "rpm",
    "woff", "woff2", "ttf", "otf",
    "db", "sqlite", "sqlite3",
)

/** file.tsx `isBinaryFile`: by extension, before reading anything. */
fun isBinaryPath(path: String): Boolean = '.' in path && path.substringAfterLast('.').lowercase() in binaryExtensions

/**
 * file.tsx's load: binary extensions stop at once; otherwise the file's
 * uncommitted diff (`git diff`, when it is inside the session root) and its
 * contents. Contents with a NUL byte, or more than a tenth control
 * characters, are binary.
 */
suspend fun SessionFileOps.loadFile(sessionId: String, filePath: String, sessionPath: String?, gitDiffPath: String?): FileLoad {
    if (isBinaryPath(filePath)) return FileLoad.Binary
    return try {
        var diff: String? = null
        if (sessionPath != null && gitDiffPath != null && gitDiffPath != ".") {
            val response = runCatching { bash(sessionId, "git diff --no-ext-diff -- \"$gitDiffPath\"", sessionPath, 5_000) }.getOrNull()
            if (response != null && response.success && response.stdout.isNotBlank()) diff = response.stdout
        }
        val response = readFile(sessionId, filePath)
        val content = response.content
        if (!response.success || content.isNullOrEmpty()) return FileLoad.Failed(response.error ?: "Failed to read file")
        val bytes = try {
            java.util.Base64.getMimeDecoder().decode(content)
        } catch (_: IllegalArgumentException) {
            return FileLoad.Binary
        }
        val text = String(bytes, Charsets.UTF_8)
        val controls = text.count { it.code < 32 && it != '\t' && it != '\n' && it != '\r' }
        val binary = bytes.any { it == 0.toByte() } || (text.isNotEmpty() && controls.toDouble() / text.length > 0.1)
        if (binary) FileLoad.Binary else FileLoad.Loaded(text, diff)
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        FileLoad.Failed("Failed to load file")
    }
}

/**
 * file.tsx over storage.ts `sessionFileCache`: the cached copy at once, with
 * no spinner, then the fetch, which replaces it and is cached in turn. A
 * fetch that finds no diff leaves the cached one up (file.tsx only sets its
 * diff when one comes back); a failure replaces the copy and caches nothing.
 */
fun SessionFileOps.fileLoads(cache: SessionFileCache?, sessionId: String, filePath: String, sessionPath: String?, gitDiffPath: String?): Flow<FileLoad> = flow {
    val cached = cache?.file(sessionId, filePath)
    if (cached != null) emit(if (cached.isBinary) FileLoad.Binary else FileLoad.Loaded(cached.content.orEmpty(), cached.diff))
    when (val fresh = loadFile(sessionId, filePath, sessionPath, gitDiffPath)) {
        FileLoad.Binary -> {
            cache?.putFile(sessionId, filePath, "", null, true)
            emit(fresh)
        }
        is FileLoad.Loaded -> {
            cache?.putFile(sessionId, filePath, fresh.content, fresh.diff, false)
            emit(fresh.copy(diff = fresh.diff ?: cached?.diff))
        }
        else -> emit(fresh)
    }
}

/** theme.ts `diff.*` for file.tsx's own line-by-line diff. */
private data class FileDiffColors(
    val addedBg: Color, val addedBorder: Color, val addedText: Color,
    val removedBg: Color, val removedBorder: Color, val removedText: Color,
    val contextText: Color, val hunkHeaderBg: Color, val hunkHeaderText: Color,
)

private fun c(hex: Long) = Color(hex or 0xFF000000)

private val LightFileDiff = FileDiffColors(c(0xE6FFED), c(0x34D058), c(0x24292E), c(0xFFEEF0), c(0xD73A49), c(0x24292E), c(0x586069), c(0xF1F8FF), c(0x005CC5))
private val DarkFileDiff = FileDiffColors(c(0x0D2E1F), c(0x3FB950), c(0xC9D1D9), c(0x3F1B23), c(0xF85149), c(0xC9D1D9), c(0x8B949E), c(0x161B22), c(0x58A6FF))

/** theme.ts `glass.border`, the native bars' hairline. */
private fun glassBorder(dark: Boolean) = if (dark) Color(1f, 1f, 1f, 0.14f) else Color(1f, 1f, 1f, 0.82f)

private val codeStyle = happyTextStyle(fontSize = 14, lineHeight = 20, family = PlexMono)

/**
 * session/[id]/file.tsx, header "File Viewer" with back. While loading: a
 * spinner, then "Loading name..." 16 textSecondary 16 below, centred. A
 * failure: "Error" 18 semibold textDestructive, 8 above the message (16
 * textSecondary), padded 20, centred, and an alert. Binary: "Binary File"
 * 18 semibold, "Cannot display binary file content" 16, the name 14 #999 8
 * below, all textSecondary and centred.
 *
 * Otherwise: the path bar (padding 16, glass backgroundStrong with a
 * hairline glass border below: the 20 file icon, then the path, with
 * `:line[:column]` when asked, mono 14 textSecondary 8 after it); with a
 * diff, the Diff / File tabs (padding 16/12, the same bar; each tab padding
 * 16/8, radius 8, 8 apart, 14 semibold: textLink at 0.4 with white text
 * when on, glass backgroundSubtle and textSecondary when off). Then,
 * padded 16 and scrolling: the diff line by line (mono 14/20, padding 8/1;
 * additions and removals on their colour with a 3 border at the left,
 * `@@` semibold on hunkHeaderBg, `+++`/`---` semibold text), or the file
 * through SimpleSyntaxHighlighter (mono 14/20, selectable), or "File is
 * empty" / "No changes to display" 16 italic textSecondary. The diff shows
 * first when there is one, the file when a [line] was asked for, scrolled
 * to 40 above it.
 */
@Composable
fun FileScreen(
    load: FileLoad,
    filePath: String,
    onBack: () -> Unit,
    line: Int? = null,
    column: Int? = null,
) {
    val colors = HappyTheme.colors
    val fileName = filePath.substringAfterLast('/').ifEmpty { filePath }
    var alertShown by remember(load) { mutableStateOf(load is FileLoad.Failed) }
    Screen(header = { StackHeader(stringResource(R.string.common_file_viewer), onBack) }) {
        when (load) {
            FileLoad.Loading -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                CircularProgressIndicator(Modifier.size(20.dp).testTag(FileTags.SPINNER), color = colors.textSecondary, strokeWidth = 2.dp)
                Text(stringResource(R.string.files_loading_file, fileName), style = happyTextStyle(fontSize = 16), color = colors.textSecondary, modifier = Modifier.padding(top = 16.dp))
            }
            is FileLoad.Failed -> {
                Centered(stringResource(R.string.common_error), colors.textDestructive, load.message)
                if (alertShown) {
                    HappyAlert(
                        Alert(stringResource(R.string.common_error), load.message, listOf(AlertButton(stringResource(R.string.common_ok)))),
                        onDismiss = { alertShown = false },
                    )
                }
            }
            FileLoad.Binary -> Centered(stringResource(R.string.files_binary_file), colors.textSecondary, stringResource(R.string.files_cannot_display_binary), fileName)
            is FileLoad.Loaded -> LoadedFile(load, filePath, line, column)
        }
    }
}

@Composable
private fun Centered(title: String, titleColor: Color, message: String, footnote: String? = null) {
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(title, style = happyTextStyle(fontSize = 18, weight = FontWeight.SemiBold), color = titleColor, modifier = Modifier.padding(bottom = 8.dp))
        Text(message, style = happyTextStyle(fontSize = 16), color = HappyTheme.colors.textSecondary, textAlign = TextAlign.Center)
        if (footnote != null) {
            Text(footnote, style = happyTextStyle(fontSize = 14), color = Color(0xFF999999), textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

private enum class Mode { Diff, File }

@Composable
private fun LoadedFile(load: FileLoad.Loaded, filePath: String, line: Int?, column: Int?) {
    val colors = HappyTheme.colors
    val border = glassBorder(colors.dark)
    val requested = line?.takeIf { it > 0 }
    var mode by rememberSaveable(load.diff != null, requested) { mutableStateOf(if (requested == null && load.diff != null) Mode.Diff else Mode.File) }
    val scroll = rememberScrollState()
    val density = LocalDensity.current
    LaunchedEffect(mode, load.content, requested) {
        if (mode != Mode.File || requested == null || load.content.isEmpty()) return@LaunchedEffect
        scroll.scrollTo(with(density) { max(0, (requested - 1) * 20 - 40).dp.roundToPx() })
    }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(colors.glass.backgroundStrong)
                .hairlineBelow(border)
                .testTag(FileTags.PATH_BAR)
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FileIcon(filePath.substringAfterLast('/').ifEmpty { filePath }, 20.dp)
            val label = if (requested != null) "$filePath:$requested${column?.takeIf { it > 0 }?.let { ":$it" }.orEmpty()}" else filePath
            Text(label, style = happyTextStyle(fontSize = 14, family = PlexMono), color = colors.textSecondary, modifier = Modifier.padding(start = 8.dp).weight(1f))
        }
        if (load.diff != null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(colors.glass.backgroundStrong)
                    .hairlineBelow(border)
                    .testTag(FileTags.TOGGLE_BAR)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Tab(stringResource(R.string.files_diff), mode == Mode.Diff, FileTags.DIFF_TAB) { mode = Mode.Diff }
                Tab(stringResource(R.string.files_file), mode == Mode.File, FileTags.FILE_TAB) { mode = Mode.File }
            }
        }
        // The bars span the screen; the body is held to layout.maxWidth.
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).testTag(FileTags.SCROLL).contentMaxWidth(LocalWindowLayout.current).padding(16.dp)) {
            val empty = happyTextStyle(fontSize = 16).copy(fontStyle = FontStyle.Italic)
            when {
                mode == Mode.Diff && load.diff != null -> DiffDisplay(load.diff)
                mode == Mode.File && load.content.isNotEmpty() -> {
                    val chat = ChatTheme.colors
                    val text = remember(load.content, chat) { highlight(load.content, fileLanguage(filePath), chat) }
                    SelectionContainer { Text(text, style = codeStyle, modifier = Modifier.testTag(FileTags.CODE)) }
                }
                mode == Mode.File -> Text(stringResource(R.string.files_file_empty), style = empty, color = colors.textSecondary)
                else -> Text(stringResource(R.string.files_no_changes), style = empty, color = colors.textSecondary)
            }
        }
    }
}

private fun Modifier.hairlineBelow(color: Color) = drawBehind {
    val width = 0.5.dp.toPx()
    drawLine(color, Offset(0f, size.height - width / 2), Offset(size.width, size.height - width / 2), width)
}

@Composable
private fun Tab(label: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    Box(
        Modifier
            .testTag(tag)
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) colors.textLink.copy(alpha = 0x66 / 255f) else colors.glass.backgroundSubtle)
            .clickable(role = Role.Tab, onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Text(label, style = happyTextStyle(fontSize = 14, weight = FontWeight.SemiBold), color = if (selected) Color.White else colors.textSecondary)
    }
}

/** file.tsx `DiffDisplay`: the raw patch, one coloured row per line. */
@Composable
private fun DiffDisplay(diff: String) {
    val colors = HappyTheme.colors
    val palette = if (colors.dark) DarkFileDiff else LightFileDiff
    val bold = codeStyle.copy(fontWeight = FontWeight.SemiBold)
    Column {
        for (line in diff.split('\n')) {
            val added = line.startsWith("+") && !line.startsWith("+++")
            val removed = line.startsWith("-") && !line.startsWith("---")
            val (background, color, style) = when {
                added -> Triple(palette.addedBg, palette.addedText, codeStyle)
                removed -> Triple(palette.removedBg, palette.removedText, codeStyle)
                line.startsWith("@@") -> Triple(palette.hunkHeaderBg, palette.hunkHeaderText, bold)
                line.startsWith("+++") || line.startsWith("---") -> Triple(Color.Transparent, colors.text, bold)
                else -> Triple(Color.Transparent, palette.contextText, codeStyle)
            }
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).background(background).testTag(FileTags.DIFF_LINE)) {
                if (added || removed) Spacer(Modifier.width(3.dp).fillMaxHeight().background(if (added) palette.addedBorder else palette.removedBorder))
                Text(
                    line.ifEmpty { " " },
                    style = style,
                    color = color,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 1.dp),
                )
            }
        }
    }
}
