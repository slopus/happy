package com.slopus.happy.ui.diff

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.diff.DiffDocument
import com.slopus.happy.diff.DiffRow
import com.slopus.happy.diff.DiffSource
import com.slopus.happy.diff.FileChangeKind
import com.slopus.happy.diff.syntax.SyntaxService
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Both sides of an image file, as `data:` URIs. */
data class DiffImages(val before: String?, val after: String?)

/** DiffFilesList.tsx `DiffFileItem`: one changed file and, once fetched, what to draw for it. */
data class DiffFileItem(
    val path: String,
    val kind: FileChangeKind,
    val additions: Int,
    val deletions: Int,
    /** Null while the body is still being fetched. */
    val source: DiffSource? = null,
    /** Set instead of [source] for files that are pictures rather than text. */
    val image: DiffImages? = null,
    val error: String? = null,
    /** Why a file has no text body (empty, conflicted, ...). */
    val message: String? = null,
    /** Stable identity; [path] when null. */
    val key: String? = null,
) {
    val id: String get() = key ?: path
    val summary: DiffFileSummary get() = DiffFileSummary(path, kind, additions, deletions)
    internal val unavailable get() = source == null && image == null && error == null && message == null
}

/**
 * The built bodies of a changeset's expanded files. A file is parsed when
 * its header is first composed (near the viewport), on a background thread
 * when large, so a 60-file changeset never builds everything up front.
 */
@Stable
private class DiffSections(private val scope: CoroutineScope, private val syntax: SyntaxService?) {
    class Section(val source: DiffSource, val document: DiffDocument?, val bodies: List<DiffFileBody>, val job: Job?)

    private val sections = mutableStateMapOf<String, Section>()

    operator fun get(item: DiffFileItem): Section? = sections[item.id]?.takeIf { it.source == item.source }

    fun ensure(item: DiffFileItem) {
        val source = item.source ?: return
        if (get(item) != null) return
        drop(item.id)
        if (source.size <= DIFF_SYNC_BUILD_LIMIT) {
            finish(item.id, source, source.build())
            return
        }
        val job = scope.launch {
            val document = withContext(Dispatchers.Default) { source.build() }
            if (sections[item.id]?.source == source) finish(item.id, source, document)
        }
        sections[item.id] = Section(source, null, emptyList(), job)
    }

    private fun finish(id: String, source: DiffSource, document: DiffDocument) {
        val bodies = document.files.map { file -> DiffFileBody(file, showHunkHeaders = true, collapseAfter = 600, syntax = syntax).also { it.start(scope) } }
        sections[id] = Section(source, document, bodies, null)
    }

    fun drop(id: String) {
        val section = sections.remove(id) ?: return
        section.job?.cancel()
        section.bodies.forEach { it.stop() }
    }

    /** Forgets files that left the list, were collapsed or changed source. */
    fun retain(live: Map<String, DiffFileItem>, expanded: (DiffFileItem) -> Boolean) {
        for (id in sections.keys.toList()) {
            val item = live[id]
            if (item == null || !expanded(item) || item.source != sections[id]?.source) drop(id)
        }
    }

    fun clear() = sections.keys.toList().forEach(::drop)
}

/**
 * The pull-request view (DiffFilesList.tsx): every changed file, one after
 * another, in a lazy list on the surface colour. Each file is a
 * [DiffFileHeader] with a chevron that collapses it, then its body as lazy
 * rows ([diffFileItems], collapsed after 600), then a 1 divider. Files with
 * more than [autoCollapseAbove] changed lines start collapsed with a "N
 * changed lines - tap to expand" line (13 textSecondary, padded 12); with
 * [defaultCollapsed] every file starts closed and the hint is dropped. An
 * error or message is 13 textSecondary centred, padded 16; an image file
 * is a [DiffImageView]; a body not fetched yet is a spinner, and
 * [onRequestContent] is asked for it once per expansion. [scrollToPath]
 * scrolls to that file once, when the list first has it, and tints its
 * section hunkBg. No files: [emptyText] (or "No changes") padded 32.
 */
@Composable
fun DiffFilesList(
    items: List<DiffFileItem>,
    modifier: Modifier = Modifier,
    state: LazyListState = rememberLazyListState(),
    scrollToPath: String? = null,
    showLineNumbers: Boolean = true,
    layout: DiffLayoutMode = DiffLayoutMode.Scroll,
    fontSize: Float = DiffMetrics.DEFAULT_FONT_SIZE,
    header: (@Composable LazyItemScope.() -> Unit)? = null,
    autoCollapseAbove: Int = 2000,
    defaultCollapsed: Boolean = false,
    emptyText: String? = null,
    onExpandContext: ((path: String) -> Unit)? = null,
    onRequestContent: ((path: String) -> Unit)? = null,
) {
    val palette = diffPalette()
    val metrics = rememberDiffMetrics(fontSize)
    // FileSection: each file held to layout.maxWidth, centred.
    val width = Modifier.contentMaxWidth(LocalWindowLayout.current)
    val syntax = LocalDiffSyntax.current
    val scope = rememberCoroutineScope()
    val sections = remember(syntax) { DiffSections(scope, syntax) }
    DisposableEffect(sections) { onDispose { sections.clear() } }
    val overrides = remember { mutableStateMapOf<String, Boolean>() }
    val requested = remember { HashSet<String>() }
    val requestContent by rememberUpdatedState(onRequestContent)

    fun tooBig(item: DiffFileItem) = item.additions + item.deletions > autoCollapseAbove
    fun collapsed(item: DiffFileItem) = overrides[item.path] ?: (defaultCollapsed || tooBig(item))

    // A collapse, or a body that arrived (or failed), makes the next expansion ask again.
    LaunchedEffect(items, overrides.toMap()) {
        val live = items.associateBy { it.id }
        sections.retain(live) { !collapsed(it) }
        requested.retainAll(items.filter { !collapsed(it) && it.unavailable }.map { it.path }.toSet())
    }

    val content: LazyListScope.() -> Unit = {
        if (header != null) item(key = "diff.list.header", content = header)
        if (items.isEmpty()) {
            item(key = "diff.list.empty") {
                Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    Text(emptyText ?: stringResource(R.string.diff_no_changes), style = happyTextStyle(fontSize = 14), color = palette.textSecondary)
                }
            }
        }
        for (item in items) {
            val isCollapsed = collapsed(item)
            val highlighted = scrollToPath == item.path
            val tint = if (highlighted) palette.hunkBg else Color.Transparent
            val showSizeHint = isCollapsed && tooBig(item)
            item(key = "file:${item.id}", contentType = "diff.fileHeader") {
                if (!isCollapsed) LaunchedEffect(item.source) { sections.ensure(item) }
                DiffFileHeader(item.summary, width, collapsed = isCollapsed, onToggle = { overrides[item.path] = !isCollapsed })
            }
            when {
                isCollapsed -> if (showSizeHint) item(key = "hint:${item.id}") {
                    Box(
                        width
                            .background(tint)
                            .testTag(DiffTags.SIZE_HINT)
                            .clickable(role = Role.Button) { overrides[item.path] = false }
                            .padding(vertical = 12.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        val count = item.additions + item.deletions
                        Text(pluralResource(R.plurals.diff_tap_to_expand, count, count), style = happyTextStyle(fontSize = 13), color = palette.textSecondary)
                    }
                }
                item.error != null -> item(key = "body:${item.id}") { SectionMessage(item.error, palette, tint, width) }
                item.message != null -> item(key = "body:${item.id}") { SectionMessage(item.message, palette, tint, width) }
                item.image != null -> item(key = "body:${item.id}") { DiffImageView(item.image.before, item.image.after, width) }
                item.source == null -> item(key = "body:${item.id}") {
                    LaunchedEffect(item.path) { if (requested.add(item.path)) runCatching { requestContent?.invoke(item.path) } }
                    Spinner(palette, tint, width)
                }
                else -> {
                    val document = sections[item]?.document
                    val bodies = sections[item]?.bodies.orEmpty()
                    val hasTextRows = document?.files?.any { file -> file.rows.any { it is DiffRow.Line } } == true
                    when {
                        document == null -> item(key = "body:${item.id}") { Spinner(palette, tint, width) }
                        document.error != null -> item(key = "body:${item.id}") { SectionMessage(document.error, palette, tint, width) }
                        document.files.isEmpty() || (item.source is DiffSource.Contents && !hasTextRows) ->
                            item(key = "body:${item.id}") { SectionMessage(stringResource(R.string.diff_no_changes), palette, tint, width) }
                        else -> bodies.forEachIndexed { index, body ->
                            diffFileItems(
                                body,
                                palette,
                                metrics,
                                keyPrefix = "${item.id}:$index",
                                showLineNumbers = showLineNumbers,
                                layout = layout,
                                onExpandContext = onExpandContext?.let { expand -> { expand(item.path) } },
                                rowModifier = width.background(tint),
                            )
                        }
                    }
                }
            }
            item(key = "end:${item.id}", contentType = "diff.fileEnd") { HorizontalDivider(width, thickness = 1.dp, color = palette.divider) }
        }
    }

    // Scroll to the requested file once, when it first appears. Bodies
    // arriving change the list, and following them would yank the reader
    // back after they had moved on.
    val consumed = remember { arrayOfNulls<String>(1) }
    LaunchedEffect(scrollToPath, items) {
        if (scrollToPath == null) {
            consumed[0] = null
            return@LaunchedEffect
        }
        if (consumed[0] == scrollToPath || items.none { it.path == scrollToPath }) return@LaunchedEffect
        val index = ItemCounter("file:${items.first { it.path == scrollToPath }.id}").apply(content).index ?: return@LaunchedEffect
        consumed[0] = scrollToPath
        state.animateScrollToItem(index)
    }

    LazyColumn(
        state = state,
        modifier = modifier.fillMaxSize().background(palette.surface),
        contentPadding = PaddingValues(bottom = 32.dp),
        content = content,
    )
}

@Composable
private fun SectionMessage(text: String, palette: DiffPalette, tint: Color, modifier: Modifier) {
    Box(modifier.background(tint).padding(vertical = 16.dp).testTag(DiffTags.MESSAGE), contentAlignment = Alignment.Center) {
        Text(text, style = happyTextStyle(fontSize = 13), color = palette.textSecondary)
    }
}

@Composable
private fun Spinner(palette: DiffPalette, tint: Color, modifier: Modifier) {
    Box(modifier.background(tint).padding(vertical = 16.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(modifier = Modifier.size(20.dp).testTag(DiffTags.SPINNER), color = palette.textSecondary, strokeWidth = 2.dp)
    }
}

/** Runs a list's content without composing it, to find the index of the item keyed [target]. */
@OptIn(ExperimentalFoundationApi::class)
private class ItemCounter(private val target: Any) : LazyListScope {
    private var count = 0
    var index: Int? = null
        private set

    override fun item(key: Any?, contentType: Any?, content: @Composable LazyItemScope.() -> Unit) {
        if (key == target) index = count
        count++
    }

    override fun items(count: Int, key: ((index: Int) -> Any)?, contentType: (index: Int) -> Any?, itemContent: @Composable LazyItemScope.(index: Int) -> Unit) {
        if (key != null && index == null) for (i in 0 until count) if (key(i) == target) index = this.count + i
        this.count += count
    }

    @Deprecated("Use the non deprecated overload", level = DeprecationLevel.HIDDEN)
    override fun stickyHeader(key: Any?, contentType: Any?, content: @Composable LazyItemScope.() -> Unit) {
        item(key, contentType, content)
    }
}
