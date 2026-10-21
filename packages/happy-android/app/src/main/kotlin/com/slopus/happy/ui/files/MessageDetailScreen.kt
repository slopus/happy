package com.slopus.happy.ui.files

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.tools.isTerminalToolName
import com.slopus.happy.chat.tools.presentTool
import com.slopus.happy.chat.tools.toolActivityLabel
import com.slopus.happy.chat.tools.toolDisplayTitle
import com.slopus.happy.ui.chat.rememberToolText
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

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
