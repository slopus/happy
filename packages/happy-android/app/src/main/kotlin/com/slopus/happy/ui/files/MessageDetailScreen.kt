package com.slopus.happy.ui.files

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.chat.tools.PatchEntry
import com.slopus.happy.chat.tools.PatchInput
import com.slopus.happy.chat.tools.ToolCategory
import com.slopus.happy.chat.tools.isTerminalToolName
import com.slopus.happy.chat.tools.materializeUnifiedDiffPatch
import com.slopus.happy.chat.tools.patchChanges
import com.slopus.happy.chat.tools.patchInput
import com.slopus.happy.chat.tools.presentTool
import com.slopus.happy.chat.tools.resolvePath
import com.slopus.happy.chat.tools.resultText
import com.slopus.happy.chat.tools.shellControl
import com.slopus.happy.chat.tools.terminalToolCommand
import com.slopus.happy.chat.tools.toolActivityLabel
import com.slopus.happy.chat.tools.toolDisplayTitle
import com.slopus.happy.chat.tools.toolSummaryCategory
import com.slopus.happy.chat.tools.unifiedDiffFileName
import com.slopus.happy.diff.DiffSource
import com.slopus.happy.diff.DiffStats
import com.slopus.happy.diff.FileChangeKind
import com.slopus.happy.ui.chat.ChatTheme
import com.slopus.happy.ui.chat.CodeView
import com.slopus.happy.ui.chat.TaskView
import com.slopus.happy.ui.chat.ToolError
import com.slopus.happy.ui.chat.ToolSection
import com.slopus.happy.ui.chat.rememberToolText
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.diff.DarkSyntaxColors
import com.slopus.happy.ui.diff.DiffChunk
import com.slopus.happy.ui.diff.DiffFileHeader
import com.slopus.happy.ui.diff.DiffFileSummary
import com.slopus.happy.ui.diff.SyntaxText
import com.slopus.happy.ui.diff.diffPalette
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

object MessageDetailTags {
    const val SPINNER = "messageDetail.spinner"
    const val CONTENT = "messageDetail.content"
    const val TEXT = "messageDetail.text"
    const val COMMAND = "messageDetail.command"
    const val SECTION = "messageDetail.section"
    const val PATCH_FILE = "messageDetail.patchFile"
    const val EDIT_HEADER = "messageDetail.editHeader"
    const val RAW_JSON = "messageDetail.rawJson"
}

/** What the screen draws a message with: the session's folder and agent, the line-number setting, dev mode. */
data class MessageDetailEnvironment(
    val path: String? = null,
    val flavor: String? = null,
    val showLineNumbers: Boolean = false,
    val devMode: Boolean = false,
)

/** ToolHeader.tsx: the tool's title (a terminal tool's activity), "Message" otherwise. */
@Composable
fun messageDetailTitle(message: ChatMessage?, env: MessageDetailEnvironment): String {
    val fallback = stringResource(R.string.common_message)
    val tool = (message as? ChatMessage.ToolCallMessage) ?: return fallback
    val text = rememberToolText()
    return remember(tool, text, env) {
        if (isTerminalToolName(tool.tool.name)) toolActivityLabel(tool.tool, text)
        else presentTool(tool, text, compactToolCalls = false, flavor = env.flavor, path = env.path)?.title ?: toolDisplayTitle(tool.tool, text)
    }
}

/**
 * session/[id]/message/[messageId].tsx: the plain header (the tool's title,
 * centred, back), then a spinner until the session and its messages are in
 * and [message] is found. A tool call is its ToolFullView; agent and user
 * text is the text alone, 16/24, padded 16.
 *
 * Deviation: the text scrolls and is selectable. happy-app's is a plain
 * Text in a non-scrolling view, which cuts off a long message.
 */
@Composable
fun MessageDetailScreen(
    message: ChatMessage?,
    loaded: Boolean,
    env: MessageDetailEnvironment,
    onBack: () -> Unit,
    focusFile: String? = null,
) {
    val colors = HappyTheme.colors
    Screen(header = { StackHeader(messageDetailTitle(message, env), onBack, TitleAlignment.Center) }) {
        when {
            !loaded || message == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(20.dp).testTag(MessageDetailTags.SPINNER), color = colors.textSecondary, strokeWidth = 2.dp)
            }
            message is ChatMessage.ToolCallMessage -> ToolFullView(message, env, focusFile)
            message is ChatMessage.AgentText -> PlainText(message.text)
            message is ChatMessage.UserText -> PlainText(message.text)
        }
    }
}

@Composable
private fun PlainText(text: String) {
    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        SelectionContainer {
            Text(text, style = happyTextStyle(fontSize = 16, lineHeight = 24), color = HappyTheme.colors.text, modifier = Modifier.testTag(MessageDetailTags.TEXT))
        }
    }
}

private object FullViewSpec {
    val sectionTitle = happyTextStyle(fontSize = 17, weight = FontWeight.SemiBold)
    val description = happyTextStyle(fontSize = 14, lineHeight = 20)
    val errorText = happyTextStyle(fontSize = 14, lineHeight = 20)
    val emptyTitle = happyTextStyle(fontSize = 16, weight = FontWeight.SemiBold)
    val emptySubtitle = happyTextStyle(fontSize = 14)
    val accent = Color(0xFF5856D6)
}

/**
 * ToolFullView.tsx: scrolling, 12 above and 32 below. Edit-type tools run
 * edge to edge; the rest 16 in. A tool with its own full view draws it
 * (terminal command, diffs, the task's tools), then, unless it is a
 * terminal tool, its error or "Output". Held to the content max width,
 * centred; readable (non-edit) content at most 800 wide. Others: Description, Input
 * Parameters and Output / Error sections (17 semibold titles after a 20
 * glyph, 8 apart, 12 above the content, 28 below each), or "Tool completed
 * successfully" over a 48 checkmark when there was no output. Dev mode
 * adds the raw JSON.
 */
@Composable
fun ToolFullView(message: ChatMessage.ToolCallMessage, env: MessageDetailEnvironment, focusFile: String? = null) {
    val tool = message.tool
    val special = fullViewKind(tool.name)
    val wide = toolSummaryCategory(tool.name) == ToolCategory.Edit
    val layout = LocalWindowLayout.current
    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Column(
            Modifier
                .padding(top = 12.dp, bottom = 32.dp)
                // contentWrapper: layout.maxWidth, centred; readable content at most 800.
                .contentMaxWidth(layout)
                .then(if (wide) Modifier else Modifier.wrapContentWidth().widthIn(max = 800.dp).fillMaxWidth())
                .padding(horizontal = if (wide) (if (layout.width > 700.dp) 16.dp else 0.dp) else 16.dp)
                .testTag(MessageDetailTags.CONTENT),
        ) {
            if (special != null) {
                SpecializedFullView(special, message, env, focusFile)
                if (!isTerminalToolName(tool.name)) {
                    val result = resultText(tool.result)
                    if (tool.state == ToolState.Error) ToolError(result ?: stringResource(R.string.tools_full_view_error))
                    else if (tool.state == ToolState.Completed && tool.result != null) {
                        ToolSection(title = stringResource(R.string.tools_full_view_output)) { CodeView(result.orEmpty()) }
                    }
                }
            } else {
                GenericFullView(tool)
            }
            if (env.devMode) {
                FullSection(Ionicon.CodeSlash, Color(0xFFFF9500), stringResource(R.string.tools_full_view_raw_json_dev_mode), Modifier.testTag(MessageDetailTags.RAW_JSON)) {
                    CodeView(pretty(rawJson(message)))
                }
            }
        }
    }
}

private enum class FullViewKind { Bash, Patch, Diff, Edit, Write, MultiEdit, Task }

/** views/_all.tsx `toolFullViewRegistry`, terminal tools falling back to the command view. */
private fun fullViewKind(name: String): FullViewKind? = when (name) {
    "Bash", "CodexBash" -> FullViewKind.Bash
    "CodexPatch", "GeminiPatch", "apply_patch" -> FullViewKind.Patch
    "CodexDiff", "GeminiDiff" -> FullViewKind.Diff
    "Edit", "search_replace" -> FullViewKind.Edit
    "Write", "write" -> FullViewKind.Write
    "MultiEdit" -> FullViewKind.MultiEdit
    "Task", "Agent" -> FullViewKind.Task
    else -> if (isTerminalToolName(name)) FullViewKind.Bash else null
}

@Composable
private fun SpecializedFullView(kind: FullViewKind, message: ChatMessage.ToolCallMessage, env: MessageDetailEnvironment, focusFile: String?) {
    val tool = message.tool
    val input = tool.input.obj
    when (kind) {
        FullViewKind.Bash -> BashFullView(tool)
        FullViewKind.Edit -> {
            val path = input?.get("file_path").str
            Box(Modifier.padding(bottom = 28.dp)) {
                DiffChunk(DiffSource.Contents(path ?: "file.txt", input?.get("old_string").str.orEmpty(), input?.get("new_string").str.orEmpty()), showLineNumbers = true)
            }
        }
        FullViewKind.Write -> {
            val path = input?.get("file_path").str
            val content = input?.get("content").str ?: "<no contents>"
            Box(Modifier.padding(bottom = 12.dp)) { DiffChunk(DiffSource.Contents(path ?: "file.txt", "", content), showLineNumbers = env.showLineNumbers) }
        }
        FullViewKind.MultiEdit -> MultiEditFullView(input)
        FullViewKind.Patch -> PatchFullView(tool, env, focusFile)
        FullViewKind.Diff -> CodexDiffFullView(input, env)
        FullViewKind.Task -> TaskView(message)
    }
}

/** MultiEditViewFull.tsx: each edit under "Edit i of n" (14 semibold #5856D6, a "Replace All" pill 8 after), 16 rules between. */
@Composable
private fun MultiEditFullView(input: Map<String, JsonElement>?) {
    val edits = input?.get("edits").arr?.mapNotNull { it.obj }.orEmpty()
    if (edits.isEmpty()) return
    val path = input?.get("file_path").str
    Column(Modifier.padding(bottom = 28.dp)) {
        edits.forEachIndexed { index, edit ->
            Row(Modifier.padding(bottom = 8.dp).testTag(MessageDetailTags.EDIT_HEADER), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.tools_multi_edit_edit_number, index + 1, edits.size),
                    style = happyTextStyle(fontSize = 14, weight = FontWeight.SemiBold),
                    color = FullViewSpec.accent,
                )
                if ((edit["replace_all"] as? JsonPrimitive)?.content == "true") {
                    Text(
                        stringResource(R.string.tools_multi_edit_replace_all),
                        style = happyTextStyle(fontSize = 12, weight = FontWeight.SemiBold),
                        color = Color.White,
                        modifier = Modifier.padding(start = 8.dp).clip(RoundedCornerShape(12.dp)).background(FullViewSpec.accent).padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                }
            }
            DiffChunk(DiffSource.Contents(path ?: "file.txt", edit["old_string"].str.orEmpty(), edit["new_string"].str.orEmpty()), showLineNumbers = true)
            if (index < edits.lastIndex) Spacer(Modifier.padding(vertical = 16.dp).fillMaxWidth().height(1.dp).background(Color(0xFFE5E5EA)))
        }
    }
}

/**
 * CodexPatchViewFull: 12 in, 16 apart, 28 below; each file a card on the
 * surface colour (radius 8, 1 divider border) with its header (and the
 * destination of a move) over its diff. [focusFile] narrows it to the
 * file that was tapped, when it is still there. A patch with no readable
 * files shows "Update file" over the raw patch.
 */
@Composable
private fun PatchFullView(tool: ToolCall, env: MessageDetailEnvironment, focusFile: String?) {
    val all = remember(tool.input) { patchChanges(tool.input)?.entries?.map { it.key to it.value }.orEmpty() }
    val focused = focusFile?.let { f -> all.filter { it.first == f } }.orEmpty()
    val entries = focused.ifEmpty { all }
    if (entries.isEmpty()) {
        val raw = tool.input.obj?.get("patch").str ?: tool.input.obj?.get("input").str ?: tool.input?.let(::resultText)
        ToolSection(title = stringResource(R.string.tools_names_apply_changes)) { if (raw != null) CodeView(raw) }
        return
    }
    Column(Modifier.padding(horizontal = 12.dp).padding(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        for ((file, change) in entries) PatchFileCard(file, change, env)
    }
}

@Composable
private fun PatchFileCard(file: String, change: PatchEntry, env: MessageDetailEnvironment) {
    val colors = HappyTheme.colors
    val palette = diffPalette()
    val path = resolvePath(file, env.path)
    val movePath = change.movePath?.let { resolvePath(it, env.path) }
    val fileName = file.substringAfterLast('/')
    val diff = remember(change, file) {
        when (val input = patchInput(change)) {
            is PatchInput.Patch -> materializeUnifiedDiffPatch(input.patch, file, change.kindType).let { DiffSource.Patch(it) to DiffStats.countPatch(it) }
            is PatchInput.Pair -> (if (input.oldText.isEmpty() && input.newText.isEmpty()) null else DiffSource.Contents(fileName, input.oldText, input.newText)) to
                DiffStats.countContents(input.oldText, input.newText)
            null -> null to null
        }
    }
    val shape = RoundedCornerShape(8.dp)
    Column(Modifier.fillMaxWidth().testTag(MessageDetailTags.PATCH_FILE).clip(shape).background(colors.surface).border(1.dp, colors.divider, shape)) {
        Column(Modifier.background(palette.hunkBg)) {
            DiffFileHeader(
                DiffFileSummary(
                    path,
                    when {
                        movePath != null -> FileChangeKind.Renamed
                        change.kindType == "add" -> FileChangeKind.Added
                        change.kindType == "delete" -> FileChangeKind.Deleted
                        else -> FileChangeKind.Modified
                    },
                    diff.second?.additions ?: 0,
                    diff.second?.deletions ?: 0,
                ),
            )
            if (movePath != null) {
                Text(movePath, style = happyTextStyle(fontSize = 12, family = PlexMono), color = palette.textSecondary, modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 9.dp))
            }
        }
        diff.first?.let { DiffChunk(it, showLineNumbers = env.showLineNumbers) }
    }
}

/** CodexDiffViewFull: the `unified_diff` in one such card, under a header naming the file. */
@Composable
private fun CodexDiffFullView(input: Map<String, JsonElement>?, env: MessageDetailEnvironment) {
    val patch = input?.get("unified_diff").str ?: return
    val fileName = (input?.get("path") ?: input?.get("filePath")).str ?: unifiedDiffFileName(patch)
    val stats = remember(patch) { DiffStats.countPatch(patch) }
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(8.dp)
    Column(Modifier.padding(horizontal = 12.dp).padding(bottom = 28.dp).fillMaxWidth().clip(shape).background(colors.surface).border(1.dp, colors.divider, shape)) {
        if (fileName != null) DiffFileHeader(DiffFileSummary(fileName, FileChangeKind.Modified, stats.additions, stats.deletions))
        DiffChunk(DiffSource.Patch(patch), showLineNumbers = env.showLineNumbers)
    }
}

/** toolResult.ts `getTerminalToolResult`. */
internal data class TerminalResult(val stdout: String?, val stderr: String?, val error: String?)

internal fun terminalResult(tool: ToolCall): TerminalResult {
    val record = tool.result as? JsonObject
    val structured = record != null && listOf("stdout", "stderr", "output").any { record[it].str != null }
    return TerminalResult(
        stdout = if (structured) record["stdout"].str ?: record["output"].str else if (tool.state == ToolState.Completed) resultText(tool.result) else null,
        stderr = if (structured) record["stderr"].str else null,
        error = if (tool.state == ToolState.Error) resultText(record?.get("error") ?: tool.result) else null,
    )
}

/** BashViewFull.tsx: the command view, full width, with the input sent to a shell under it. */
@Composable
private fun BashFullView(tool: ToolCall) {
    val text = rememberToolText()
    val command = terminalToolCommand(tool.name, tool.input)
    val result = terminalResult(tool)
    val chars = remember(tool) {
        if (shellControl(tool.name, tool.input) == null) null
        else (if (tool.name == "write_stdin") tool.input.obj?.get("chars") else tool.input.obj?.get("input")).str?.ifEmpty { null }
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        CommandView(
            command = command ?: toolActivityLabel(tool, text),
            prompt = if (command != null) "$" else "",
            stdout = result.stdout,
            stderr = result.stderr,
            error = if (tool.state == ToolState.Error) result.error?.ifEmpty { null } ?: stringResource(R.string.tools_full_view_error) else null,
            hideEmptyOutput = tool.state == ToolState.Running,
            commandLanguage = if (command != null) "bash" else null,
        )
        if (chars != null) ToolSection(title = stringResource(R.string.tool_view_input)) { CodeView(chars) }
    }
}

private object TerminalColors {
    val command = Color(0xFFE0E0E0)
    fun error(dark: Boolean) = if (dark) Color(0xFFFF6B6B) else Color(0xFFFF5555)
    fun emptyOutput(dark: Boolean) = if (dark) Color(0xFF7B7B93) else Color(0xFF6272A4)
}

/**
 * CommandView.tsx, as the detail page draws it: the terminal background,
 * radius 8, padding 16; the prompt (mono 14/20 semibold, prompt colour)
 * and the command (mono 14/20); stdout, stderr and the error (mono 13/18,
 * 8 above each); "[Command completed with no output]" italic when there
 * is nothing. Command and output are coloured by Prism with the dark
 * palette (bash and shell-session), selectable.
 */
@Composable
private fun CommandView(
    command: String,
    prompt: String,
    stdout: String?,
    stderr: String?,
    error: String?,
    hideEmptyOutput: Boolean,
    commandLanguage: String?,
) {
    val chat = ChatTheme.colors
    val dark = HappyTheme.colors.dark
    val commandStyle = happyTextStyle(fontSize = 14, lineHeight = 20, family = PlexMono)
    val outputStyle = happyTextStyle(fontSize = 13, lineHeight = 18, family = PlexMono)
    Column(
        Modifier
            .fillMaxWidth()
            .testTag(MessageDetailTags.COMMAND)
            .clip(RoundedCornerShape(8.dp))
            .background(chat.terminalBackground)
            .padding(16.dp),
    ) {
        SelectionContainer {
            Column {
                Row {
                    if (prompt.isNotEmpty()) Text("$prompt ", style = commandStyle.copy(fontWeight = FontWeight.SemiBold), color = chat.terminalPrompt)
                    Terminal(command, commandStyle, TerminalColors.command, commandLanguage, Modifier.weight(1f))
                }
                if (!stdout.isNullOrBlank()) Terminal(stdout, outputStyle, chat.terminalStdout, "shell-session", Modifier.padding(top = 8.dp))
                if (!stderr.isNullOrBlank()) Terminal(stderr, outputStyle, chat.terminalStderr, "shell-session", Modifier.padding(top = 8.dp))
                if (error != null) Text(error, style = outputStyle, color = TerminalColors.error(dark), modifier = Modifier.padding(top = 8.dp))
                if (stdout.isNullOrEmpty() && stderr.isNullOrEmpty() && error == null && !hideEmptyOutput) {
                    Text(
                        "[Command completed with no output]",
                        style = outputStyle.copy(fontStyle = FontStyle.Italic),
                        color = TerminalColors.emptyOutput(dark),
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun Terminal(code: String, style: androidx.compose.ui.text.TextStyle, color: Color, language: String?, modifier: Modifier) {
    if (language == null) Text(code, style = style, color = color, modifier = modifier)
    else SyntaxText(code, language, style, color, modifier, colors = DarkSyntaxColors)
}

@Composable
private fun GenericFullView(tool: ToolCall) {
    val colors = HappyTheme.colors
    val text = rememberToolText()
    val description = tool.description ?: tool.title?.let { toolDisplayTitle(tool, text) }
    if (description != null) {
        FullSection(Ionicon.InformationCircle, FullViewSpec.accent, stringResource(R.string.tools_full_view_description)) {
            Text(description, style = FullViewSpec.description, color = colors.textSecondary)
        }
    }
    if (tool.input != null) {
        FullSection(Ionicon.LogIn, FullViewSpec.accent, stringResource(R.string.tools_full_view_input_params)) { CodeView(pretty(tool.input)) }
    }
    if (tool.state == ToolState.Completed && tool.result != null) {
        FullSection(Ionicon.LogOut, Color(0xFF34C759), stringResource(R.string.tools_full_view_output)) {
            CodeView(tool.result.str ?: pretty(tool.result))
        }
    }
    if (tool.state == ToolState.Error && tool.result != null) {
        FullSection(Ionicon.CloseCircle, Color(0xFFFF3B30), stringResource(R.string.tools_full_view_error)) {
            val box = colors.boxError
            val shape = RoundedCornerShape(8.dp)
            Text(
                resultText(tool.result).orEmpty(),
                style = FullViewSpec.errorText,
                color = box.text,
                modifier = Modifier.fillMaxWidth().clip(shape).background(box.background).border(1.dp, box.border, shape).padding(16.dp),
            )
        }
    }
    if (tool.state == ToolState.Completed && tool.result == null) {
        Column(
            Modifier.fillMaxWidth().padding(bottom = 28.dp).padding(vertical = 48.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(Ionicon.CheckmarkCircleOutline, 48.dp, Color(0xFF34C759))
            Text(stringResource(R.string.tools_full_view_completed), style = FullViewSpec.emptyTitle, color = colors.text)
            Text(stringResource(R.string.tools_full_view_no_output), style = FullViewSpec.emptySubtitle, color = colors.textSecondary)
        }
    }
}

@Composable
private fun FullSection(icon: Ionicon, tint: Color, title: String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(modifier.fillMaxWidth().padding(bottom = 28.dp).testTag(MessageDetailTags.SECTION)) {
        Row(Modifier.padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(icon, 20.dp, tint)
            Text(title, style = FullViewSpec.sectionTitle, color = HappyTheme.colors.text)
        }
        content()
    }
}

private val PrettyJson = Json { prettyPrint = true; prettyPrintIndent = "  " }

private fun pretty(element: JsonElement) = PrettyJson.encodeToString(JsonElement.serializer(), element)

/** The dev-mode dump: the call's fields as stored. Children are listed by id. */
private fun rawJson(message: ChatMessage.ToolCallMessage): JsonElement {
    val tool = message.tool
    return buildJsonObject {
        put("name", tool.name)
        tool.title?.let { put("title", it) }
        put("state", tool.state.name.lowercase())
        tool.description?.let { put("description", it) }
        tool.input?.let { put("input", it) }
        tool.result?.let { put("result", it) }
        put("createdAt", tool.createdAt)
        tool.startedAt?.let { put("startedAt", it) }
        tool.completedAt?.let { put("completedAt", it) }
        tool.permission?.let { put("permission", it.status.name.lowercase()) }
        put("messages", kotlinx.serialization.json.JsonArray(message.children.map { JsonPrimitive(it.id) }))
    }
}
