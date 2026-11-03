package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.chat.prettyJson
import com.slopus.happy.chat.str
import com.slopus.happy.conversation.AskPhase
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.Presentation
import com.slopus.happy.conversation.Question
import com.slopus.happy.conversation.ToolKind
import com.slopus.happy.conversation.ToolMessage
import com.slopus.happy.conversation.ToolPatch
import com.slopus.happy.conversation.ToolPlan
import com.slopus.happy.conversation.ToolReview
import com.slopus.happy.conversation.ToolSubagent
import com.slopus.happy.conversation.ToolUse
import com.slopus.happy.conversation.ToolValue
import com.slopus.happy.diff.DiffSource
import com.slopus.happy.diff.FileChangeKind
import com.slopus.happy.text.Words
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.barInsetTop
import com.slopus.happy.ui.diff.DiffFileItem
import com.slopus.happy.ui.diff.DiffFilesList
import com.slopus.happy.ui.files.CommandView
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyColors
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject

object ToolCallTags {
    const val SCREEN = "tool.screen"
    const val HEADER = "tool.header"
    const val HEADER_TITLE = "tool.header.title"
    const val TILE = "tool.header.tile"
    const val STATUS = "tool.status"
    const val SECTION = "tool.section"
    const val HEADING = "tool.heading"
    const val CARD = "tool.card"
    const val FIELD = "tool.field"
    const val BLOCK = "tool.block"
    const val OPERATION = "tool.operation"
    const val STEP = "tool.step"
    const val REVIEW = "tool.review"
    const val ERROR = "tool.error"
    const val RAW = "tool.raw"
    const val RAW_TOGGLE = "tool.raw.toggle"
    const val NOTE = "tool.note"
    const val MISSING = "tool.missing"
}

/**
 * The measures of a tool call's screen (iOS ToolDetailViewController):
 * one column on the surface, held to the content width and 16 in, 12
 * under the bar and 32 above the end.
 *
 * The header card: surfaceHigh, radius 16, padded 14; a 36 icon tile
 * (radius 10, surfaceHighest, its 18 glyph in textSecondary), 12 before
 * the 17/22 semibold kind ("Terminal") over the 13/18 tool name in
 * textSecondary when it says something else; then the status pill, at
 * least 24 high, padded 10 across, 12/16 semibold in its colour over 14%
 * of it ("Running" behind a 10 spinner, "Completed", "Failed").
 *
 * Each section: 24 above, a 13/18 capitals heading in textSecondary 4 in,
 * 8 above its card. Cards are surfaceHigh, radius 16. A field is padded
 * 14 across and 10 down: its 13/18 name in textSecondary over its 15/20
 * value (13/20 mono for paths, ids and commands; a link in textLink),
 * hairlines 14 in between. Long text is a block: 13/18 (mono where it is
 * code), padded 12, on surfaceHighest, radius 10, selectable. A list is
 * bullets, an object a card of its own inside. The raw JSON is last and
 * folded: a 15/20 row with a chevron opens the 12/16 mono text.
 */
object ToolCallSpec {
    val side = 16.dp
    val top = 12.dp
    val bottom = 32.dp
    val radius = 16.dp
    val headerPadding = 14.dp
    val tile = 36.dp
    val tileRadius = 10.dp
    val tileGlyph = 18.dp
    val tileGap = 12.dp
    val pillHeight = 24.dp
    val pillPadding = 10.dp
    val pillSpinner = 10.dp
    val sectionTop = 24.dp
    val headingInset = 4.dp
    val headingGap = 8.dp
    val fieldPaddingH = 14.dp
    val fieldPaddingV = 10.dp
    val blockPadding = 12.dp
    val blockRadius = 10.dp
    val kind = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold)
    val name = happyTextStyle(fontSize = 13, lineHeight = 18)
    val pill = happyTextStyle(fontSize = 12, lineHeight = 16, weight = FontWeight.SemiBold)
    val heading = happyTextStyle(fontSize = 13, lineHeight = 18)
    val label = happyTextStyle(fontSize = 13, lineHeight = 18)
    val value = happyTextStyle(fontSize = 15, lineHeight = 20)
    val valueMono = happyTextStyle(fontSize = 13, lineHeight = 20, family = FontFamily.Monospace)
    val block = happyTextStyle(fontSize = 13, lineHeight = 18)
    val blockMono = happyTextStyle(fontSize = 13, lineHeight = 18, family = FontFamily.Monospace)
    val raw = happyTextStyle(fontSize = 12, lineHeight = 16, family = FontFamily.Monospace)
    val note = happyTextStyle(fontSize = 13, lineHeight = 18)

    /** The status pill's colour: links blue while it runs, success once done, destructive when it failed. */
    fun statusColor(colors: HappyColors, status: String): Color = when (status) {
        "running" -> colors.textLink
        "failed" -> colors.textDestructive
        else -> colors.success
    }
}

/** A tool call's screen as its entry has read it. */
@Immutable
data class ToolCallScreenState(
    /** The call as held, or as read whole; null until found. */
    val call: Block.ToolCall? = null,
    /** Looking for it: in the chat under this page, then in history. */
    val reading: Boolean = true,
    /** Its raw data is being read whole (it was left out or cut). */
    val readingWhole: Boolean = false,
    /** Reading it whole failed; what is shown is what the chat held. */
    val wholeFailed: Boolean = false,
    /** Why it couldn't be found at all. */
    val error: String? = null,
    /** One file of its edit, alone: the screen is that file's diff. */
    val file: String? = null,
)

class ToolCallActions(
    val onBack: () -> Unit = {},
    /** One file of the call's edit, on a screen of its own. */
    val onOpenFile: (String) -> Unit = {},
)

/**
 * A tool call on its own screen (iOS ToolDetailViewController), opened by
 * a tap on its line: titled with what the line says of it (the command,
 * the file, the query), the header card ([ToolCallSpec]) saying what kind
 * of thing it did and where it stands, then what it did, drawn from its
 * typed presentation where the daemon sent one: a command as the
 * terminal's panel with its output; an edit as each file's diff from the
 * hunks as sent (line numbers, +/− gutter, syntax colour; no diffing
 * here), each file opening on its own; a look around as its steps; a
 * search as its query and sources. Without one, its arguments as the
 * vendors' tools name them: a plan as its checklist, a subagent as its
 * title, model and instructions, a page read as its address, a question as
 * it was asked and answered, a message as who it went to and what it
 * said; anything else as its arguments and result in fields
 * ([ToolValue]). A failed call says why. Then the review, if the call
 * crossed the automatic one, and last its raw JSON, folded. With [state]'s
 * `file` the screen is that one file's diff, titled with its name.
 */
@Composable
fun ToolCallScreen(state: ToolCallScreenState, actions: ToolCallActions) {
    val colors = HappyTheme.colors
    val res = LocalContext.current.resources
    val call = state.call
    val title = when {
        state.file != null -> state.file.substringAfterLast('/')
        call != null -> remember(call, res) { ToolWords.of(ToolUse(call.name, call.status, call.presentation), res).subject }.ifEmpty { ToolWords.humanize(call.name, res) }
        else -> ""
    }
    Screen(header = { StackHeader(title, actions.onBack) }, ground = colors.surface, modifier = Modifier.testTag(ToolCallTags.SCREEN)) {
        when {
            call == null && state.reading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(20.dp), color = colors.textSecondary, strokeWidth = 2.dp)
            }
            call == null -> Text(
                state.error ?: stringResource(R.string.tool_unavailable),
                style = ToolCallSpec.note.copy(fontSize = ToolCallSpec.value.fontSize),
                color = colors.textSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.Center).padding(32.dp).testTag(ToolCallTags.MISSING),
            )
            call.presentation is Presentation.FileDiff -> DiffBody(call, call.presentation, state, actions)
            else -> PlainBody(call, state)
        }
    }
}

/** An edit: its files' diffs in one list, under the header and over the review. */
@Composable
private fun DiffBody(call: Block.ToolCall, diff: Presentation.FileDiff, state: ToolCallScreenState, actions: ToolCallActions) {
    val files = if (state.file != null) diff.files.filter { it.path == state.file } else diff.files
    val items = remember(files) { files.map(::diffItem) }
    val alone = state.file != null
    val width = Modifier.contentMaxWidth(LocalWindowLayout.current)
    DiffFilesList(
        items = items,
        header = if (alone) null else {
            { Column(width.padding(horizontal = ToolCallSpec.side).padding(top = ToolCallSpec.top, bottom = ToolCallSpec.sectionTop)) { HeaderCard(call) } }
        },
        footer = {
            Column(width.padding(horizontal = ToolCallSpec.side)) {
                val omitted = files.filter { it.omittedLines > 0 }
                for (file in omitted) Note(pluralStringResource(R.plurals.tool_diff_more_lines, file.omittedLines, file.omittedLines, ToolWords.fileName(file.path)))
                if (!alone && diff.omittedFiles > 0) Note(pluralStringResource(R.plurals.tool_diff_more_files, diff.omittedFiles, diff.omittedFiles))
                if (!alone) Trailer(call, state)
            }
        },
        // With several files, each opens on its own; one is already all there is.
        onOpenFile = if (alone || files.size < 2) null else actions.onOpenFile,
    )
}

/** One file of an edit as the diff list draws it: its hunks as a patch, or why there is nothing to draw. */
internal fun diffItem(file: Presentation.FileDiff.File): DiffFileItem = DiffFileItem(
    path = file.path,
    kind = when (file.kind) {
        "add" -> FileChangeKind.Added
        "delete" -> FileChangeKind.Deleted
        else -> FileChangeKind.Modified
    },
    additions = file.added ?: file.hunks.sumOf { h -> h.lines.count { it.kind == "add" } },
    deletions = file.deleted ?: file.hunks.sumOf { h -> h.lines.count { it.kind == "delete" } },
    source = if (file.hunks.any { it.lines.isNotEmpty() }) DiffSource.Patch(ToolPatch.of(file)) else null,
    message = if (file.hunks.none { it.lines.isNotEmpty() }) Words.ours(R.string.files_no_changes) else null,
)

/** Everything but an edit: one scrolling column. */
@Composable
private fun PlainBody(call: Block.ToolCall, state: ToolCallScreenState) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Spacer(Modifier.height(barInsetTop()))
        Column(
            Modifier
                .contentMaxWidth(LocalWindowLayout.current)
                .padding(horizontal = ToolCallSpec.side)
                .padding(top = ToolCallSpec.top, bottom = ToolCallSpec.bottom),
        ) {
            HeaderCard(call)
            Content(call)
            Trailer(call, state)
        }
    }
}

/** What follows what the call did: why it failed, its review, its raw JSON, and whether more is being read. */
@Composable
private fun ColumnScope.Trailer(call: Block.ToolCall, state: ToolCallScreenState) {
    val kind = ToolKind.of(call.name, call.presentation)
    if (call.failed && kind != ToolKind.Terminal) {
        ToolValue.resultText(call.result)?.takeIf { it.isNotBlank() }?.let { ErrorBox(it) }
    }
    call.review?.let { Review(it, call.elevated) }
    when {
        state.readingWhole -> Note(stringResource(R.string.tool_reading_whole), spinner = true)
        state.wholeFailed -> Note(stringResource(R.string.tool_whole_failed))
    }
    if (call.arguments != null || call.result != null) RawData(call)
    Spacer(Modifier.height(ToolCallSpec.bottom))
}

/** What the call is and where it stands. */
@Composable
private fun HeaderCard(call: Block.ToolCall) {
    val colors = HappyTheme.colors
    val res = LocalContext.current.resources
    val kind = ToolKind.of(call.name, call.presentation)
    val kindTitle = kindTitle(kind, call.presentation)
    val name = remember(call.name, res) { ToolWords.humanize(call.name, res) }
    val glyph = ToolWords.glyph(call.name, call.presentation, failed = false)
    Row(
        Modifier
            .fillMaxWidth()
            .testTag(ToolCallTags.HEADER)
            .semantics(mergeDescendants = true) {}
            .clip(RoundedCornerShape(ToolCallSpec.radius))
            .background(colors.surfaceHigh)
            .padding(ToolCallSpec.headerPadding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(ToolCallSpec.tile).testTag(ToolCallTags.TILE).clip(RoundedCornerShape(ToolCallSpec.tileRadius)).background(colors.surfaceHighest),
            contentAlignment = Alignment.Center,
        ) {
            when (glyph) {
                is ToolGlyph.Ion -> Icon(glyph.icon, ToolCallSpec.tileGlyph, colors.textSecondary)
                is ToolGlyph.Oct -> Icon(glyph.icon, ToolCallSpec.tileGlyph, colors.textSecondary)
            }
        }
        Spacer(Modifier.width(ToolCallSpec.tileGap))
        Column(Modifier.weight(1f)) {
            Text(kindTitle, style = ToolCallSpec.kind, color = colors.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag(ToolCallTags.HEADER_TITLE).semantics { heading() })
            if (!name.equals(kindTitle, ignoreCase = true)) {
                Text(name, style = ToolCallSpec.name, color = colors.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.width(8.dp))
        StatusPill(call.status)
    }
}

@Composable
private fun kindTitle(kind: ToolKind, presentation: Presentation?): String = stringResource(
    when (kind) {
        ToolKind.Terminal -> R.string.tools_names_terminal
        ToolKind.FileEdit -> R.string.tool_kind_file_edit
        ToolKind.Exploration -> R.string.tool_kind_exploration
        ToolKind.Search -> if ((presentation as? Presentation.Search)?.target == "x") R.string.tool_kind_x_search else R.string.tools_names_search
        ToolKind.WebPage -> R.string.tool_kind_web_page
        ToolKind.Subagent -> R.string.turn_tool_subagent
        ToolKind.Plan -> R.string.tool_kind_plan
        ToolKind.Message -> R.string.common_message
        ToolKind.Question -> R.string.tools_names_question
        ToolKind.Media -> R.string.tool_kind_media
        ToolKind.Artifact -> R.string.conversation_artifact
        ToolKind.ToolCall -> R.string.tool_kind_tool_call
    },
)

@Composable
private fun StatusPill(status: String) {
    val colors = HappyTheme.colors
    val tint = ToolCallSpec.statusColor(colors, status)
    Row(
        Modifier
            .heightIn(min = ToolCallSpec.pillHeight)
            .testTag(ToolCallTags.STATUS)
            .clip(CircleShape)
            .background(tint.copy(alpha = 0.14f))
            .padding(horizontal = ToolCallSpec.pillPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (status == "running") CircularProgressIndicator(Modifier.size(ToolCallSpec.pillSpinner), color = tint, strokeWidth = 1.5.dp)
        Text(
            stringResource(
                when (status) {
                    "running" -> R.string.tool_status_running
                    "failed" -> R.string.turn_failed
                    else -> R.string.turn_completed
                },
            ),
            style = ToolCallSpec.pill,
            color = tint,
            maxLines = 1,
        )
    }
}

/** What the call did, by its presentation, else by its tool's own arguments, else as fields. */
@Composable
private fun ColumnScope.Content(call: Block.ToolCall) {
    when (val p = call.presentation) {
        is Presentation.Command -> Section(stringResource(R.string.tools_names_terminal)) {
            CommandView(command = p.command, prompt = "$", stdout = p.output, stderr = null, error = null, hideEmptyOutput = call.running, commandLanguage = "bash")
        }
        is Presentation.Terminal -> Section(stringResource(R.string.tools_names_terminal)) {
            CommandView(command = p.input, prompt = ">", stdout = ToolValue.resultText(call.result), stderr = null, error = null, hideEmptyOutput = true, commandLanguage = null)
            p.command?.let { Fields(listOf(ToolValue.Field("command", stringResource(R.string.tool_field_running), ToolValue.Text(it, mono = true))), Modifier.padding(top = 8.dp)) }
        }
        is Presentation.Exploration -> Section(stringResource(R.string.tool_kind_exploration)) { Operations(p.operations) }
        is Presentation.Search -> {
            Section(stringResource(R.string.tool_field_query)) { TextBlock(p.query, mono = false) }
            if (p.sources.isNotEmpty()) Section(stringResource(R.string.tool_section_sources)) {
                Fields(p.sources.map { ToolValue.Field(it.url, it.title.ifEmpty { it.url }, ToolValue.Text(it.url, link = true)) })
            }
        }
        is Presentation.UserInput -> call.id?.let { id ->
            AskRow(ConversationRow.Ask(ConversationRowBuilder.askKey(id), Question(id, "answered", null, p.prompts, null, false, p.answers), AskPhase.Answered), null, Modifier.padding(top = ToolCallSpec.sectionTop))
        }
        else -> ByName(call)
    }
}

/** A call no presentation stands for: its tool's own view where it has one, else its arguments and result as fields. */
@Composable
private fun ColumnScope.ByName(call: Block.ToolCall) {
    val args = call.arguments as? JsonObject
    var shown: Set<String> = emptySet()
    when (ToolKind.of(call.name, call.presentation)) {
        ToolKind.Plan -> ToolPlan.of(call.name, call.arguments)?.let { plan ->
            shown = setOf("plan", "todos", "explanation", "merge")
            plan.explanation?.let { Section(stringResource(R.string.tool_field_explanation)) { TextBlock(it, mono = false) } }
            Section(stringResource(R.string.tool_section_steps)) { Steps(plan) }
        }
        ToolKind.Subagent -> ToolSubagent.of(call.arguments)?.let { subagent ->
            shown = ToolSubagent.SHOWN
            val fields = listOfNotNull(
                subagent.title?.let { ToolValue.Field("title", stringResource(R.string.tool_field_title), ToolValue.Text(it)) },
                subagent.model?.let { ToolValue.Field("model", stringResource(R.string.tool_field_model), ToolValue.Text(it, mono = true)) },
            )
            if (fields.isNotEmpty()) Section(stringResource(R.string.turn_tool_subagent)) { Fields(fields) }
            subagent.prompt?.let { Section(stringResource(R.string.tool_section_instructions)) { MarkdownBlock(it) } }
        }
        ToolKind.Message -> ToolMessage.of(call.arguments)?.let { message ->
            shown = ToolMessage.SHOWN
            message.to?.let { Section(stringResource(R.string.tool_field_to)) { Fields(listOf(ToolValue.Field("to", stringResource(R.string.tool_field_to), ToolValue.Text(it, mono = true)))) } }
            Section(stringResource(R.string.common_message)) { MarkdownBlock(message.text) }
        }
        ToolKind.WebPage -> args?.get("url").str?.let { url ->
            shown = setOf("url", "prompt")
            Section(stringResource(R.string.tool_kind_web_page)) {
                Fields(listOfNotNull(ToolValue.Field("url", stringResource(R.string.tool_field_address), ToolValue.Text(url, link = true))))
            }
            args?.get("prompt").str?.let { Section(stringResource(R.string.tool_field_prompt)) { TextBlock(it, mono = false) } }
        }
        ToolKind.Question -> call.id?.let { id -> Question.asked(id, call.arguments, call.output) }?.let { question ->
            shown = setOf("questions", "question", "context", "header", "options", "multiSelect", "id")
            val phase = if (question.status == "answered") AskPhase.Answered else AskPhase.Pending
            AskRow(ConversationRow.Ask(ConversationRowBuilder.askKey(question.id), question, phase), null, Modifier.padding(top = ToolCallSpec.sectionTop))
        }
        ToolKind.Terminal -> args?.let { a ->
            val command = a["cmd"].str ?: a["command"].str
            val input = a["chars"].str ?: a["input"].str
            if (command != null || input != null) {
                shown = setOf("cmd", "command", "chars", "input")
                Section(stringResource(R.string.tools_names_terminal)) {
                    CommandView(
                        command = command ?: input.orEmpty(),
                        prompt = if (command != null) "$" else ">",
                        stdout = ToolValue.resultText(call.result),
                        stderr = null,
                        error = null,
                        hideEmptyOutput = call.running || call.result == null,
                        commandLanguage = if (command != null) "bash" else null,
                    )
                }
            }
        }
        else -> Unit
    }
    // The arguments the view above didn't show, and the result.
    val rest = args?.let { a -> JsonObject(a.filterKeys { it !in shown }) }
    ToolValue.of(rest ?: call.arguments.takeIf { args == null })?.let { Section(stringResource(R.string.tool_section_arguments)) { Value(it) } }
    val terminalShown = ToolKind.of(call.name, null) == ToolKind.Terminal && "cmd" in shown
    if (!call.failed && !terminalShown && ToolKind.of(call.name, null) != ToolKind.Question) {
        ToolValue.result(call.result)?.let { Section(stringResource(R.string.tool_section_result)) { Value(it) } }
    }
}

/** A section: its heading in capitals, then its [content]. */
@Composable
private fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = ToolCallSpec.sectionTop).testTag(ToolCallTags.SECTION)) {
        Text(
            title.uppercase(),
            style = ToolCallSpec.heading,
            color = HappyTheme.colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = ToolCallSpec.headingInset, bottom = ToolCallSpec.headingGap).testTag(ToolCallTags.HEADING).semantics { heading() },
        )
        content()
    }
}

/** A surfaceHigh card. */
@Composable
private fun Card(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .testTag(ToolCallTags.CARD)
            .clip(RoundedCornerShape(ToolCallSpec.radius))
            .background(HappyTheme.colors.surfaceHigh),
        content = content,
    )
}

/** Any value: words in a card's field, a block, bullets, fields, or JSON. */
@Composable
private fun Value(value: ToolValue) {
    when (value) {
        is ToolValue.Fields -> Fields(value.fields)
        is ToolValue.Block -> TextBlock(value.text, value.mono)
        is ToolValue.Json -> TextBlock(value.text, mono = true)
        is ToolValue.Text -> Card { Box(Modifier.padding(horizontal = ToolCallSpec.fieldPaddingH, vertical = ToolCallSpec.fieldPaddingV)) { InlineValue(value) } }
        is ToolValue.Items -> Card { Column(Modifier.padding(horizontal = ToolCallSpec.fieldPaddingH, vertical = ToolCallSpec.fieldPaddingV)) { Items(value) } }
        ToolValue.Empty -> Unit
    }
}

/** Fields in one card, hairlines between them. */
@Composable
private fun Fields(fields: List<ToolValue.Field>, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Card(modifier) {
        fields.forEachIndexed { index, field ->
            if (index > 0) HorizontalDivider(Modifier.padding(start = ToolCallSpec.fieldPaddingH), thickness = 0.5.dp, color = colors.divider)
            Column(
                Modifier
                    .fillMaxWidth()
                    .testTag(ToolCallTags.FIELD)
                    .padding(horizontal = ToolCallSpec.fieldPaddingH, vertical = ToolCallSpec.fieldPaddingV),
            ) {
                Text(field.label, style = ToolCallSpec.label, color = colors.textSecondary)
                Spacer(Modifier.height(2.dp))
                FieldValue(field.value)
            }
        }
    }
}

/** A field's value inside its card: nested fields go in a card of their own on the surface. */
@Composable
private fun FieldValue(value: ToolValue) {
    when (value) {
        is ToolValue.Text -> InlineValue(value)
        is ToolValue.Block -> TextBlock(value.text, value.mono, Modifier.padding(top = 4.dp))
        is ToolValue.Json -> TextBlock(value.text, mono = true, modifier = Modifier.padding(top = 4.dp))
        is ToolValue.Items -> Items(value)
        is ToolValue.Fields -> Box(Modifier.padding(top = 4.dp).clip(RoundedCornerShape(ToolCallSpec.blockRadius)).background(HappyTheme.colors.surfaceHighest)) {
            Column { value.fields.forEach { field -> NestedField(field) } }
        }
        ToolValue.Empty -> Unit
    }
}

@Composable
private fun NestedField(field: ToolValue.Field) {
    Column(Modifier.fillMaxWidth().padding(horizontal = ToolCallSpec.blockPadding, vertical = 8.dp)) {
        Text(field.label, style = ToolCallSpec.label, color = HappyTheme.colors.textSecondary)
        FieldValue(field.value)
    }
}

@Composable
private fun Items(value: ToolValue.Items) {
    val colors = HappyTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (item in value.items) {
            Row {
                Text("•", style = ToolCallSpec.value, color = colors.textSecondary, modifier = Modifier.padding(end = 8.dp))
                Box(Modifier.weight(1f)) { FieldValue(item) }
            }
        }
    }
}

@Composable
private fun InlineValue(value: ToolValue.Text) {
    val colors = HappyTheme.colors
    if (value.link) {
        val uri = LocalUriHandler.current
        Text(
            value.text,
            style = ToolCallSpec.value.copy(textDecoration = TextDecoration.Underline),
            color = colors.textLink,
            modifier = Modifier.clickable(role = Role.Button) { runCatching { uri.openUri(value.text) } },
        )
    } else {
        SelectionContainer { Text(value.text, style = if (value.mono) ToolCallSpec.valueMono else ToolCallSpec.value, color = colors.text) }
    }
}

/** Long text in a block of its own, selectable. */
@Composable
private fun TextBlock(text: String, mono: Boolean, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    SelectionContainer(
        modifier
            .fillMaxWidth()
            .testTag(ToolCallTags.BLOCK)
            .clip(RoundedCornerShape(ToolCallSpec.blockRadius))
            .background(colors.surfaceHighest)
            .padding(ToolCallSpec.blockPadding),
    ) {
        Text(text, style = if (mono) ToolCallSpec.blockMono else ToolCallSpec.block, color = colors.text)
    }
}

/** Words the agent wrote, as Markdown, in a card. */
@Composable
private fun MarkdownBlock(text: String) {
    val blocks = remember(text) { parseMarkdown(text) }
    Card { Box(Modifier.padding(horizontal = ToolCallSpec.fieldPaddingH, vertical = ToolCallSpec.fieldPaddingV)) { MarkdownView(blocks) } }
}

/** A look around, a row per step: what it did and to what. */
@Composable
private fun Operations(operations: List<Presentation.Exploration.Operation>) {
    val colors = HappyTheme.colors
    Card {
        operations.forEachIndexed { index, op ->
            if (index > 0) HorizontalDivider(Modifier.padding(start = ToolCallSpec.fieldPaddingH), thickness = 0.5.dp, color = colors.divider)
            val (icon, verb, subject) = when (op.kind) {
                "list" -> Triple(Ionicon.FolderOutline, stringResource(R.string.tool_op_list), op.target.orEmpty())
                "read" -> Triple(Ionicon.DocumentTextOutline, stringResource(R.string.turn_read), op.name.orEmpty())
                else -> Triple(
                    Ionicon.SearchOutline,
                    stringResource(R.string.tools_names_search),
                    listOfNotNull(op.query, op.path?.let { stringResource(R.string.tool_op_in, it) }).joinToString(" ").ifEmpty { op.command.orEmpty() },
                )
            }
            Row(
                Modifier.fillMaxWidth().testTag(ToolCallTags.OPERATION).padding(horizontal = ToolCallSpec.fieldPaddingH, vertical = ToolCallSpec.fieldPaddingV),
                verticalAlignment = Alignment.Top,
            ) {
                Icon(icon, 16.dp, colors.textSecondary, Modifier.padding(top = 2.dp))
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(verb, style = ToolCallSpec.label, color = colors.textSecondary)
                    SelectionContainer { Text(subject, style = ToolCallSpec.valueMono, color = colors.text) }
                    if (op.kind == "search" && op.command != null && (op.query != null || op.path != null)) {
                        Text(op.command, style = ToolCallSpec.raw, color = colors.textSecondary, modifier = Modifier.padding(top = 2.dp))
                    }
                }
            }
        }
    }
}

/** A plan's steps, each with its mark: done ticked, the one under way a filled dot, cancelled struck through. */
@Composable
private fun Steps(plan: ToolPlan) {
    val colors = HappyTheme.colors
    Card {
        plan.items.forEachIndexed { index, item ->
            if (index > 0) HorizontalDivider(Modifier.padding(start = 44.dp), thickness = 0.5.dp, color = colors.divider)
            Row(
                Modifier.fillMaxWidth().testTag(ToolCallTags.STEP).padding(horizontal = ToolCallSpec.fieldPaddingH, vertical = ToolCallSpec.fieldPaddingV),
                verticalAlignment = Alignment.Top,
            ) {
                val (icon, tint) = when (item.status) {
                    ToolPlan.Status.Done -> Ionicon.CheckmarkCircle to colors.success
                    ToolPlan.Status.Active -> Ionicon.TimeOutline to colors.textLink
                    ToolPlan.Status.Cancelled -> Ionicon.RemoveCircleOutline to colors.textSecondary
                    ToolPlan.Status.Pending -> Ionicon.EllipseOutline to colors.textSecondary
                }
                Icon(icon, 18.dp, tint, Modifier.padding(top = 1.dp))
                Spacer(Modifier.width(12.dp))
                Text(
                    item.text,
                    style = ToolCallSpec.value.copy(
                        textDecoration = if (item.status == ToolPlan.Status.Cancelled) TextDecoration.LineThrough else null,
                        fontWeight = if (item.status == ToolPlan.Status.Active) FontWeight.SemiBold else null,
                    ),
                    color = if (item.status == ToolPlan.Status.Done || item.status == ToolPlan.Status.Cancelled) colors.textSecondary else colors.text,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/** How the automatic reviewer judged the call, and whether it ran with Full access. */
@Composable
private fun Review(review: ToolReview, elevated: Boolean?) {
    val colors = HappyTheme.colors
    Section(stringResource(R.string.tool_section_review)) {
        val decision = when (review.outcome) {
            "allowed" -> stringResource(R.string.tool_review_allowed) to colors.success
            "denied" -> stringResource(R.string.tool_review_denied) to colors.textDestructive
            else -> stringResource(R.string.tool_review_unproven) to colors.textSecondary
        }
        Card(Modifier.testTag(ToolCallTags.REVIEW)) {
            val rows = buildList<Pair<String, @Composable () -> Unit>> {
                add(stringResource(R.string.tool_review_decision) to { Text(decision.first, style = ToolCallSpec.value.copy(fontWeight = FontWeight.SemiBold), color = decision.second) })
                review.kind?.let { kind ->
                    val why = stringResource(if (kind == "timed_out") R.string.tool_review_timed_out else R.string.tool_review_unavailable)
                    add(stringResource(R.string.tool_review_why) to { Text(why, style = ToolCallSpec.value, color = colors.text) })
                }
                review.risk?.let { risk ->
                    val high = risk == "high" || risk == "critical"
                    val words = levelName(risk)
                    add(stringResource(R.string.tool_review_risk) to { Text(words, style = ToolCallSpec.value, color = if (high) colors.textDestructive else colors.text) })
                }
                review.userAuthorization?.let { level ->
                    val words = levelName(level)
                    add(stringResource(R.string.tool_review_asked) to { Text(words, style = ToolCallSpec.value, color = colors.text) })
                }
                elevated?.let { full ->
                    val words = stringResource(if (full) R.string.tool_review_full_access else R.string.tool_review_sandbox)
                    add(stringResource(R.string.tool_review_access) to { Text(words, style = ToolCallSpec.value, color = colors.text) })
                }
            }
            rows.forEachIndexed { index, (label, value) ->
                if (index > 0) HorizontalDivider(Modifier.padding(start = ToolCallSpec.fieldPaddingH), thickness = 0.5.dp, color = colors.divider)
                Row(
                    Modifier.fillMaxWidth().testTag(ToolCallTags.FIELD).padding(horizontal = ToolCallSpec.fieldPaddingH, vertical = ToolCallSpec.fieldPaddingV),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(label, style = ToolCallSpec.value, color = colors.textSecondary, modifier = Modifier.weight(1f).padding(end = 12.dp))
                    value()
                }
            }
        }
        if (review.reason.isNotBlank()) TextBlock(review.reason, mono = false, modifier = Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun levelName(level: String): String = stringResource(
    when (level) {
        "low" -> R.string.tool_level_low
        "medium" -> R.string.tool_level_medium
        "high" -> R.string.tool_level_high
        "critical" -> R.string.tool_level_critical
        else -> R.string.tool_level_unknown
    },
)

/** Why a call failed, in the error box's colours. */
@Composable
private fun ErrorBox(text: String) {
    val box = HappyTheme.colors.boxError
    Section(stringResource(R.string.tools_full_view_error)) {
        SelectionContainer(
            Modifier
                .fillMaxWidth()
                .testTag(ToolCallTags.ERROR)
                .clip(RoundedCornerShape(ToolCallSpec.blockRadius))
                .background(box.background)
                .padding(ToolCallSpec.blockPadding),
        ) {
            Text(text, style = ToolCallSpec.blockMono, color = box.text)
        }
    }
}

/** The call's raw arguments and result as JSON, last and folded. */
@Composable
private fun RawData(call: Block.ToolCall) {
    val colors = HappyTheme.colors
    var open by rememberSaveable { mutableStateOf(false) }
    val json = remember(call) {
        prettyJson(
            buildJsonObject {
                call.arguments?.let { put("arguments", it) }
                call.result?.let { put("result", it) }
            },
        )
    }
    Column(Modifier.fillMaxWidth().padding(top = ToolCallSpec.sectionTop).testTag(ToolCallTags.RAW)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(ToolCallSpec.radius))
                .background(colors.surfaceHigh)
                .clickable(role = Role.Button) { open = !open }
                .testTag(ToolCallTags.RAW_TOGGLE)
                .padding(horizontal = ToolCallSpec.fieldPaddingH, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Ionicon.CodeSlash, 16.dp, colors.textSecondary)
            Spacer(Modifier.width(10.dp))
            Text(stringResource(R.string.tool_section_raw), style = ToolCallSpec.value, color = colors.text, modifier = Modifier.weight(1f))
            Icon(if (open) Ionicon.ChevronDown else Ionicon.ChevronForward, 16.dp, colors.textSecondary)
        }
        if (open) {
            SelectionContainer(
                Modifier
                    .padding(top = 8.dp)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(ToolCallSpec.blockRadius))
                    .background(colors.surfaceHighest)
                    .padding(ToolCallSpec.blockPadding),
            ) {
                Text(json, style = ToolCallSpec.raw, color = colors.text)
            }
        }
    }
}

/** A quiet line under what is shown: lines or files left out, or the whole call on its way. */
@Composable
private fun Note(text: String, spinner: Boolean = false) {
    val colors = HappyTheme.colors
    Row(Modifier.fillMaxWidth().padding(top = 16.dp).testTag(ToolCallTags.NOTE), verticalAlignment = Alignment.CenterVertically) {
        if (spinner) {
            CircularProgressIndicator(Modifier.size(12.dp), color = colors.textSecondary, strokeWidth = 1.5.dp)
            Spacer(Modifier.width(8.dp))
        }
        Text(text, style = ToolCallSpec.note, color = colors.textSecondary)
    }
}
