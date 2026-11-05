package com.slopus.happy.ui.files

import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.produceState
import androidx.compose.ui.layout.ContentScale
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.Segment
import com.slopus.happy.ui.components.SegmentedTabs
import com.slopus.happy.ui.conversation.PictureViewer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.slopus.happy.text.wordsResource
import com.slopus.happy.text.Words
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
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
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
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
import com.slopus.happy.ui.theme.AppMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import androidx.compose.ui.text.TextLayoutResult
import kotlin.math.roundToInt

object FileTags {
    const val PATH_BAR = "file.pathBar"
    const val TOGGLE_BAR = "file.toggleBar"
    const val DIFF_TAB = "file.diffTab"
    const val FILE_TAB = "file.fileTab"
    const val DIFF_LINE = "file.diffLine"
    const val CODE = "file.code"
    const val SPINNER = "file.spinner"
    const val SCROLL = "file.scroll"
    const val RENDERED_TAB = "file.renderedTab"
    const val RENDERED = "file.rendered"
    const val PICTURE = "file.picture"
    const val SAVE = "file.save"
    const val RETRY = "file.retry"
}

/** What file.tsx loaded: still loading, failed, binary, a picture, or the text and its uncommitted diff. */
sealed interface FileLoad {
    data object Loading : FileLoad
    data class Failed(val message: Words) : FileLoad
    data object Binary : FileLoad
    /** [stale]: the copy kept from an earlier read, shown because this one failed (offline), and why. */
    data class Loaded(val content: String, val diff: String?, val stale: Words? = null) : FileLoad

    /** A picture's bytes and its size in pixels (desktop's FilePreview shows it rather than calling it binary). */
    class Picture(val bytes: ByteArray, val width: Int, val height: Int) : FileLoad
}

/** desktop FilePreview's `markdown` kind: these render as a document, with the source a tab away. */
fun isMarkdownPath(path: String): Boolean = path.substringAfterLast('.', "").lowercase() in setOf("md", "markdown", "mdx")

/** desktop FilePreview's raster `image` kinds Android decodes itself; SVG stays text. */
fun isPicturePath(path: String): Boolean = path.substringAfterLast('.', "").lowercase() in setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "avif")

/**
 * [bytes] as the viewer shows them: a picture when its name says so and
 * they decode, binary when they hold a NUL or more than a tenth control
 * characters (file.tsx), text otherwise. Off the main thread.
 */
fun fileLoadOf(path: String, bytes: ByteArray): FileLoad {
    if (isPicturePath(path)) {
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        return if (bounds.outWidth > 0 && bounds.outHeight > 0) FileLoad.Picture(bytes, bounds.outWidth, bounds.outHeight) else FileLoad.Binary
    }
    val text = String(bytes, Charsets.UTF_8)
    val controls = text.count { it.code < 32 && it != '\t' && it != '\n' && it != '\r' }
    val binary = bytes.any { it == 0.toByte() } || (text.isNotEmpty() && controls.toDouble() / text.length > 0.1)
    return if (binary) FileLoad.Binary else FileLoad.Loaded(text, null)
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
        if (!response.success || content.isNullOrEmpty()) return FileLoad.Failed(Words.said(response.error, R.string.files_failed_to_read))
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
        FileLoad.Failed(Words.ours(R.string.files_load_failed))
    }
}

/**
 * file.tsx over storage.ts `sessionFileCache`: the cached copy at once, with
 * no spinner (from memory, else from the account's disk, read off the main
 * thread), then the fetch, which replaces it and is cached in turn. A fetch
 * that finds no diff leaves the cached one up (file.tsx only sets its diff
 * when one comes back). A failure caches nothing; with a text copy kept it
 * leaves that copy up under its alert (iOS b6982bd92, offline), else it
 * replaces it.
 */
fun SessionFileOps.fileLoads(cache: SessionFileCache?, sessionId: String, filePath: String, sessionPath: String?, gitDiffPath: String?): Flow<FileLoad> = flow {
    val cached = cache?.file(sessionId, filePath) ?: cache?.snapshot(sessionId, filePath)
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
        is FileLoad.Failed -> emit(if (cached != null && !cached.isBinary) FileLoad.Loaded(cached.content.orEmpty(), cached.diff, stale = fresh.message) else fresh)
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

private val codeStyle = happyTextStyle(fontSize = 14, lineHeight = 20, family = AppMono)

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
    /** desktop d122790d: the file saved to the phone, from the bar; null where there is nothing to save yet. */
    save: FileSave? = null,
    /** A failed read offers Retry, and says why without an alert. */
    onRetry: (() -> Unit)? = null,
    /** The bar's title; "File viewer" when not given. */
    title: String? = null,
    /** More of the bar's actions, after the save. */
    actions: @Composable RowScope.() -> Unit = {},
) {
    val colors = HappyTheme.colors
    val fileName = filePath.substringAfterLast('/').ifEmpty { filePath }
    var alertShown by remember(load) { mutableStateOf(load is FileLoad.Failed && onRetry == null) }
    Screen(header = { StackHeader(title ?: stringResource(R.string.common_file_viewer), onBack) { save?.let { FileSaveButton(it) }; actions() } }) {
        when (load) {
            FileLoad.Loading -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                CircularProgressIndicator(Modifier.size(20.dp).testTag(FileTags.SPINNER), color = colors.textSecondary, strokeWidth = 2.dp)
                Text(stringResource(R.string.files_loading_file, fileName), style = happyTextStyle(fontSize = 16), color = colors.textSecondary, modifier = Modifier.padding(top = 16.dp))
            }
            is FileLoad.Failed -> {
                Centered(stringResource(R.string.common_error), colors.textDestructive, wordsResource(load.message), retry = onRetry)
                if (alertShown) {
                    HappyAlert(
                        Alert(stringResource(R.string.common_error), wordsResource(load.message), listOf(AlertButton(stringResource(R.string.common_ok)))),
                        onDismiss = { alertShown = false },
                    )
                }
            }
            FileLoad.Binary -> Centered(stringResource(R.string.files_binary_file), colors.textSecondary, stringResource(R.string.files_cannot_display_binary), fileName)
            is FileLoad.Loaded -> LoadedFile(load, filePath, line, column)
            is FileLoad.Picture -> PictureFile(load, filePath)
        }
    }
}

@Composable
private fun Centered(title: String, titleColor: Color, message: String, footnote: String? = null, retry: (() -> Unit)? = null) {
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(title, style = happyTextStyle(fontSize = 18, weight = FontWeight.SemiBold), color = titleColor, modifier = Modifier.padding(bottom = 8.dp))
        Text(message, style = happyTextStyle(fontSize = 16), color = HappyTheme.colors.textSecondary, textAlign = TextAlign.Center)
        if (footnote != null) {
            Text(footnote, style = happyTextStyle(fontSize = 14), color = Color(0xFF999999), textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
        }
        if (retry != null) {
            Text(
                stringResource(R.string.common_retry),
                style = happyTextStyle(fontSize = 16, weight = FontWeight.SemiBold),
                color = HappyTheme.colors.text,
                modifier = Modifier.padding(top = 16.dp).clickable(role = Role.Button, onClick = retry).testTag(FileTags.RETRY).padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }
    }
}

private enum class Mode { Diff, Rendered, File }

/** Where 1-based [line] of [text] starts; past its last line, its end. */
internal fun offsetOfLine(text: String, line: Int): Int {
    var at = 0
    repeat(line - 1) {
        val next = text.indexOf('\n', at)
        if (next < 0) return text.length
        at = next + 1
    }
    return at
}

@Composable
private fun LoadedFile(load: FileLoad.Loaded, filePath: String, line: Int?, column: Int?) {
    val colors = HappyTheme.colors
    var staleShown by remember(load) { mutableStateOf(load.stale != null) }
    if (staleShown && load.stale != null) {
        HappyAlert(
            Alert(stringResource(R.string.common_error), wordsResource(load.stale), listOf(AlertButton(stringResource(R.string.common_ok)))),
            onDismiss = { staleShown = false },
        )
    }
    val border = glassBorder(colors.dark)
    val requested = line?.takeIf { it > 0 }
    val markdown = isMarkdownPath(filePath) && load.content.isNotEmpty()
    var mode by rememberSaveable(load.diff != null, requested, markdown) {
        mutableStateOf(
            when {
                requested != null -> Mode.File
                load.diff != null -> Mode.Diff
                markdown -> Mode.Rendered
                else -> Mode.File
            },
        )
    }
    val scroll = rememberScrollState()
    val density = LocalDensity.current
    val inset = with(density) { 16.dp.toPx() }
    // The source's lines as laid out, so a place in it outlives a new text size.
    var code by remember { mutableStateOf<TextLayoutResult?>(null) }
    // A text-size change makes the activity again, where the scroll's pixels land elsewhere:
    // the place is kept as the source's character at the top (iOS bbaf6a8e1's
    // FileLinesLayout.place), else as a fraction of the way down. The line asked for is
    // gone to once, not again over that place.
    var topChar by rememberSaveable { mutableIntStateOf(-1) }
    var topFraction by rememberSaveable { mutableFloatStateOf(0f) }
    var jumped by rememberSaveable { mutableStateOf(false) }
    var restored by remember { mutableStateOf(false) }
    LaunchedEffect(mode, load.content) {
        val source = mode == Mode.File && load.content.isNotEmpty()
        val asked = source && requested != null && !jumped
        val kept = !restored && (if (source) topChar > 0 else topFraction > 0f)
        restored = true
        if (asked || kept) {
            // Once laid out: the scroll knows its length, the source its lines.
            val (max, layout) = snapshotFlow { scroll.maxValue to code }
                .first { (max, layout) -> max in 1 until Int.MAX_VALUE && (!source || layout != null) }
            val y = when {
                asked && layout != null && requested != null ->
                    layout.getLineTop(layout.getLineForOffset(offsetOfLine(load.content, requested))) - with(density) { 40.dp.toPx() }
                source && layout != null -> inset + layout.getLineTop(layout.getLineForOffset(topChar.coerceAtMost(load.content.length)))
                else -> topFraction * max
            }
            scroll.scrollTo(y.roundToInt().coerceIn(0, max))
            if (asked) jumped = true
        }
        snapshotFlow { scroll.value }.collect { y ->
            val max = scroll.maxValue
            topFraction = if (max in 1 until Int.MAX_VALUE) y.toFloat() / max else 0f
            topChar = code?.takeIf { source }?.let { it.getLineStart(it.getLineForVerticalPosition((y - inset).coerceAtLeast(0f))) } ?: -1
        }
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
            Text(label, style = happyTextStyle(fontSize = 14, family = AppMono), color = colors.textSecondary, modifier = Modifier.padding(start = 8.dp).weight(1f))
        }
        if (load.diff != null || markdown) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(colors.glass.backgroundStrong)
                    .hairlineBelow(border)
                    .testTag(FileTags.TOGGLE_BAR)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
            ) {
                val tabs = buildList {
                    if (load.diff != null) add(Mode.Diff to Segment(stringResource(R.string.files_diff), FileTags.DIFF_TAB))
                    if (markdown) add(Mode.Rendered to Segment(stringResource(R.string.workspace_rendered), FileTags.RENDERED_TAB))
                    add(Mode.File to Segment(stringResource(if (markdown) R.string.workspace_source else R.string.files_file), FileTags.FILE_TAB))
                }
                SegmentedTabs(tabs.map { it.second }, tabs.indexOfFirst { it.first == mode }, onPick = { mode = tabs[it].first })
            }
        }
        // The bars span the screen; the body is held to layout.maxWidth.
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).testTag(FileTags.SCROLL).contentMaxWidth(LocalWindowLayout.current).padding(16.dp)) {
            val empty = happyTextStyle(fontSize = 16).copy(fontStyle = FontStyle.Italic)
            when {
                mode == Mode.Diff && load.diff != null -> DiffDisplay(load.diff)
                mode == Mode.Rendered && markdown -> {
                    val blocks by produceState(emptyList<MarkdownBlock>(), load.content) {
                        value = withContext(Dispatchers.Default) { parseMarkdown(load.content) }
                    }
                    // A file is a document: iOS's document heading ramp, h1 the largest.
                    androidx.compose.runtime.CompositionLocalProvider(com.slopus.happy.ui.chat.LocalMarkdownHeadings provides com.slopus.happy.ui.chat.MarkdownSpec.documentHeaders) {
                        MarkdownView(blocks, Modifier.testTag(FileTags.RENDERED))
                    }
                }
                mode == Mode.File && load.content.isNotEmpty() -> {
                    val chat = ChatTheme.colors
                    val text = remember(load.content, chat) { highlight(load.content, fileLanguage(filePath), chat) }
                    SelectionContainer { Text(text, style = codeStyle, onTextLayout = { code = it }, modifier = Modifier.testTag(FileTags.CODE)) }
                }
                mode == Mode.File -> Text(stringResource(R.string.files_file_empty), style = empty, color = colors.textSecondary)
                else -> Text(stringResource(R.string.files_no_changes), style = empty, color = colors.textSecondary)
            }
        }
    }
}

/**
 * A picture file: the path bar, then the picture at its own size, fitted
 * to the width and never enlarged, centred; a tap opens it in the viewer
 * (pinch, pan, drag away), as a picture in the conversation opens.
 */
@Composable
private fun PictureFile(load: FileLoad.Picture, filePath: String) {
    val colors = HappyTheme.colors
    val fileName = filePath.substringAfterLast('/').ifEmpty { filePath }
    var viewing by remember { mutableStateOf(false) }
    val density = LocalDensity.current
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().background(colors.glass.backgroundStrong).hairlineBelow(glassBorder(colors.dark)).testTag(FileTags.PATH_BAR).padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FileIcon(fileName, 20.dp)
            Text(filePath, style = happyTextStyle(fontSize = 14, family = AppMono), color = colors.textSecondary, modifier = Modifier.padding(start = 8.dp).weight(1f))
        }
        Box(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).contentMaxWidth(LocalWindowLayout.current).padding(16.dp),
            contentAlignment = Alignment.TopCenter,
        ) {
            val natural = with(density) { load.width.toDp() }
            RemoteImage(
                model = load.bytes,
                contentDescription = fileName,
                contentScale = ContentScale.Fit,
                cacheKey = "file:$filePath:${load.bytes.size}",
                modifier = Modifier
                    .widthIn(max = natural)
                    .fillMaxWidth()
                    .aspectRatio(load.width.toFloat() / load.height)
                    .testTag(FileTags.PICTURE)
                    .clickable(role = Role.Image) { viewing = true },
            )
        }
    }
    if (viewing) PictureViewer(load.bytes, "file:$filePath:${load.bytes.size}", fileName) { viewing = false }
}

private fun Modifier.hairlineBelow(color: Color) = drawBehind {
    val width = 0.5.dp.toPx()
    drawLine(color, Offset(0f, size.height - width / 2), Offset(size.width, size.height - width / 2), width)
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
