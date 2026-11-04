package com.slopus.happy.ui.documents

import android.content.Context
import android.view.inputmethod.InputMethodManager
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.documents.DocumentEditor
import com.slopus.happy.documents.DocumentLine
import com.slopus.happy.documents.DocumentSaveState
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.surfaces.SurfaceMenu
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * iOS's `DocumentScreenLayout.Metrics`: the text 16 below the bar and 96
 * of room under its end; a status ("Loading…", a failure) in place of the
 * text, at most 280 wide, centred. The text's sides are the content
 * column's keylines (`ContentTokens.keyline`: 16 on a phone, the 640 or
 * 768 measure centred beyond), where iOS pads 20.
 */
object DocumentScreenSpec {
    val top = 16.dp
    val bottom = 96.dp
    val statusWidth = 280.dp
}

object DocumentScreenTags {
    const val SCREEN = "document.screen"
    const val TEXT = "document.text"
    const val STATUS = "document.status"
    const val MARKDOWN = "document.markdown"
}

/**
 * A document Surface, open for editing (iOS 10b57eff3's
 * `DocumentViewController`, docs/DOCUMENT-EDITOR.md): drawn from what this
 * phone kept the moment it opens, kept in step with the computer by its
 * sync, and with whoever else has it open. The bar says where saving
 * stands (Saved, Saving…, Waiting to sync), or for 4 s that a change was
 * refused; its menu renames the document and leaves it. The formatting bar
 * rides the keyboard while the text has focus. A computer without shared
 * documents shows the Markdown, read-only.
 */
@Composable
fun DocumentScreen(session: AgentSession, surfaceId: String, onBack: () -> Unit) {
    val holder = viewModel(key = "document:${session.connectionId}:$surfaceId") { DocumentHolder(session, surfaceId) }
    val surface by session.surface(surfaceId).collectAsStateWithLifecycle(null)
    val phase by holder.phase.collectAsStateWithLifecycle()
    val save by holder.save.collectAsStateWithLifecycle()
    val notice by holder.notice.collectAsStateWithLifecycle()
    val name = surface?.name.orEmpty()
    var renaming by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    var active by remember { mutableStateOf(emptySet<DocumentTool>()) }
    var linking by remember { mutableStateOf<Pair<String?, (String?) -> Unit>?>(null) }
    val context = LocalContext.current

    val subtitle = when {
        phase is DocumentHolder.Phase.Markdown && (phase as DocumentHolder.Phase.Markdown).text != null -> stringResource(R.string.document_markdown_only)
        phase !is DocumentHolder.Phase.Ready -> null
        notice != null -> stringResource(R.string.document_refused).let { words -> notice?.takeIf { it.isNotEmpty() }?.let { "$words $it" } ?: words }
        else -> stringResource(
            when (save) {
                DocumentSaveState.Saved -> R.string.document_saved
                DocumentSaveState.Saving -> R.string.document_saving
                DocumentSaveState.Waiting -> R.string.document_waiting
            },
        )
    }

    DocumentPage(
        title = name.ifEmpty { stringResource(R.string.document_untitled) },
        subtitle = subtitle,
        phase = phase,
        toolbar = focused,
        active = active,
        onBack = onBack,
        actions = {
            SurfaceMenu(session, surfaceId, onBack) { close ->
                HappyMenuItem(stringResource(R.string.common_rename), onClick = { close(); renaming = true })
            }
        },
        onTool = { holder.controller?.run(it) },
        onStyle = { holder.controller?.setStyle(it) },
        onDone = { holder.controller?.textView?.let { view -> hideKeyboard(context, view) } },
    ) { editor ->
        val fallbackName = stringResource(R.string.document_someone)
        DocumentEditorView(
            editor = editor,
            onController = { holder.controller = it },
            onSelection = { controller, focus ->
                active = controller.activeTools
                holder.presence(controller, focus, fallbackName)
            },
            onFocus = { focused = it },
            onLink = { current, done -> linking = current to done },
        )
    }

    if (renaming) {
        val title = stringResource(R.string.document_rename_title)
        PromptModal(
            Prompt(
                title = title,
                placeholder = stringResource(R.string.document_name),
                defaultValue = name,
                confirmText = stringResource(R.string.common_save),
                onResult = { text ->
                    val trimmed = text?.trim().orEmpty()
                    if (trimmed.isNotEmpty() && trimmed != name) holder.rename(trimmed)
                },
            ),
            onDismiss = { renaming = false },
        )
    }
    linking?.let { (current, done) ->
        PromptModal(
            Prompt(
                title = stringResource(R.string.document_link),
                placeholder = "https://",
                defaultValue = current,
                confirmText = stringResource(R.string.common_save),
                onResult = { text -> if (text != null) done(text.trim().ifEmpty { null }) },
            ),
            onDismiss = { linking = null },
        )
    }
}

private fun hideKeyboard(context: Context, view: DocumentTextView) {
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(view.windowToken, 0)
    view.clearFocus()
}

/** The content column's keyline in a pane [width] wide, for text that scrolls the whole pane's width. */
@Composable
private fun keyline(width: Dp): Dp = LocalWindowLayout.current.content.keyline(width).let { if (width == Dp.Infinity) 16.dp else it }

/**
 * The document's page without its state, for [DocumentScreen] and the
 * layout tests: the bar with [title] and [subtitle], then by [phase] the
 * editor ([editorView]), the Markdown, or a status in its place, and the
 * formatting bar over the keyboard while [toolbar].
 */
@Composable
internal fun DocumentPage(
    title: String,
    subtitle: String?,
    phase: DocumentHolder.Phase,
    toolbar: Boolean,
    active: Set<DocumentTool>,
    onBack: () -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
    onTool: (DocumentTool) -> Unit = {},
    onStyle: (Int) -> Unit = {},
    onDone: () -> Unit = {},
    editorView: @Composable (DocumentEditor) -> Unit,
) {
    PlaceScaffold(title = title, onBack = onBack, tag = DocumentScreenTags.SCREEN, subtitle = subtitle, actions = actions) {
        Column(Modifier.fillMaxSize().imePadding()) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (phase) {
                    DocumentHolder.Phase.Loading -> DocumentStatus(stringResource(R.string.common_loading))
                    is DocumentHolder.Phase.Ready -> editorView(phase.editor)
                    is DocumentHolder.Phase.Markdown ->
                        if (phase.text == null) DocumentStatus(stringResource(R.string.document_unavailable)) else DocumentMarkdown(phase.text)
                    is DocumentHolder.Phase.Unavailable -> DocumentStatus(
                        stringResource(R.string.document_unavailable) + if (phase.reason.isEmpty()) "" else "\n${phase.reason}",
                    )
                    DocumentHolder.Phase.Gone -> DocumentStatus(stringResource(R.string.document_gone))
                }
            }
            if (toolbar && phase is DocumentHolder.Phase.Ready) DocumentToolbar(active, onTool, onStyle, onDone)
        }
    }
}

/**
 * The editor: a [DocumentTextView] the width of the pane, its text held to
 * the column's keylines by its padding, and its [DocumentTextController]
 * (handed out through [onController], null when it goes) made for the
 * editor, and installed again for a reset's new one. The text is built
 * off the main thread from the lines as they are, and built again if a
 * change came meanwhile.
 */
@Composable
internal fun DocumentEditorView(
    editor: DocumentEditor,
    onController: (DocumentTextController?) -> Unit,
    onSelection: (DocumentTextController, Boolean) -> Unit,
    onFocus: (Boolean) -> Unit,
    onLink: (String?, (String?) -> Unit) -> Unit,
) {
    val context = LocalContext.current
    val dark = HappyTheme.colors.dark
    val fontScale = LocalConfiguration.current.fontScale
    val labels = DocumentStyle.Labels(
        picture = stringResource(R.string.document_picture),
        table = stringResource(R.string.document_table),
        unsupported = stringResource(R.string.document_unsupported),
    )
    val style = remember(dark, fontScale) { DocumentStyle(context.resources, dark, labels) }
    val view = remember { DocumentTextView(context) }
    val controller = remember(view) { DocumentTextController(view, editor, style) }
    DisposableEffect(controller) {
        onController(controller)
        var hasFocus = view.hasFocus()
        controller.onSelection = { onSelection(controller, hasFocus) }
        controller.onLink = onLink
        view.setOnFocusChangeListener { _, focus ->
            hasFocus = focus
            onFocus(focus)
            onSelection(controller, focus)
        }
        onDispose {
            view.onFocusChangeListener = null
            controller.detach()
            onController(null)
        }
    }
    // Back on the main thread for the editor and the view, whatever the effect's context resumes on (a test's does on the builder's thread).
    LaunchedEffect(controller, editor, style) {
        withContext(Dispatchers.Main.immediate) {
            var lines: List<DocumentLine>
            var built: CharSequence
            do {
                lines = editor.lines
                val snapshot = lines
                built = withContext(Dispatchers.Default) { style.document(snapshot) }
            } while (editor.lines !== lines)
            view.setTextColor(DocumentTokens.text.of(dark))
            view.highlightColor = (DocumentTokens.link.of(dark) and 0x00FFFFFF) or (0x40 shl 24)
            controller.install(editor, built, style)
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val side = keyline(maxWidth)
        val density = LocalDensity.current
        AndroidView(
            factory = { view },
            update = {
                with(density) {
                    it.setPadding(side.roundToPx(), DocumentScreenSpec.top.roundToPx(), side.roundToPx(), DocumentScreenSpec.bottom.roundToPx())
                }
                it.textSize = DocumentTokens.BODY_SIZE
            },
            modifier = Modifier.fillMaxSize().testTag(DocumentScreenTags.TEXT),
        )
    }
}

/** A document the computer keeps as Markdown only: its source, selectable, in the column. */
@Composable
private fun DocumentMarkdown(text: String) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val side = keyline(maxWidth)
        SelectionContainer {
            Text(
                text,
                style = happyTextStyle(fontSize = DocumentTokens.BODY_SIZE.toInt(), lineHeight = DocumentTokens.BODY_LINE_HEIGHT.toInt()),
                color = HappyTheme.colors.text,
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(start = side, end = side, top = DocumentScreenSpec.top, bottom = DocumentScreenSpec.bottom)
                    .testTag(DocumentScreenTags.MARKDOWN),
            )
        }
    }
}

/** What stands in for the text: centred, at most [DocumentScreenSpec.statusWidth] wide, in the secondary grey. */
@Composable
private fun DocumentStatus(text: String) {
    Box(Modifier.fillMaxSize().padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
        Text(
            text,
            style = happyTextStyle(fontSize = 15, lineHeight = 20),
            color = HappyTheme.colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.testTag(DocumentScreenTags.STATUS).widthIn(max = DocumentScreenSpec.statusWidth).fillMaxWidth(),
        )
    }
}
