package com.slopus.happy.ui.files

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.chat.tools.resultText
import com.slopus.happy.chat.tools.shellControl
import com.slopus.happy.chat.tools.terminalToolCommand
import com.slopus.happy.chat.tools.toolActivityLabel
import com.slopus.happy.ui.chat.ChatTheme
import com.slopus.happy.ui.chat.CodeView
import com.slopus.happy.ui.chat.ToolSection
import com.slopus.happy.ui.chat.rememberToolText
import com.slopus.happy.ui.diff.DarkSyntaxColors
import com.slopus.happy.ui.diff.SyntaxText
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.serialization.json.JsonObject

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
internal fun BashFullView(tool: ToolCall) {
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
