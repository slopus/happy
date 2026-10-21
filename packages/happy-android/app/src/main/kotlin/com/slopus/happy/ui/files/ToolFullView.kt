package com.slopus.happy.ui.files

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.prettyJson
import com.slopus.happy.chat.str
import com.slopus.happy.chat.tools.ToolCategory
import com.slopus.happy.chat.tools.isTerminalToolName
import com.slopus.happy.chat.tools.resultText
import com.slopus.happy.chat.tools.toolDisplayTitle
import com.slopus.happy.chat.tools.toolSummaryCategory
import com.slopus.happy.diff.DiffSource
import com.slopus.happy.ui.chat.CodeView
import com.slopus.happy.ui.chat.TaskView
import com.slopus.happy.ui.chat.ToolError
import com.slopus.happy.ui.chat.ToolSection
import com.slopus.happy.ui.chat.rememberToolText
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.diff.DiffChunk
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal object FullViewSpec {
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
                    CodeView(prettyJson(rawJson(message)))
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
        FullSection(Ionicon.LogIn, FullViewSpec.accent, stringResource(R.string.tools_full_view_input_params)) { CodeView(prettyJson(tool.input)) }
    }
    if (tool.state == ToolState.Completed && tool.result != null) {
        FullSection(Ionicon.LogOut, Color(0xFF34C759), stringResource(R.string.tools_full_view_output)) {
            CodeView(tool.result.str ?: prettyJson(tool.result))
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
