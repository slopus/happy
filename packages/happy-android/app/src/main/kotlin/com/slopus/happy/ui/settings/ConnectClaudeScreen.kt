package com.slopus.happy.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.ui.theme.rgba

object ConnectClaudeTags {
    const val TITLE = "connectClaude.title"
    const val BODY = "connectClaude.body"
    const val TERMINAL = "connectClaude.terminal"
}

/** settings/connect/claude.tsx `OAuthViewUnsupported` styles, Android branch. */
object ConnectClaudeSpec {
    val padding = 20.dp
    val title = happyTextStyle(fontSize = 18, weight = FontWeight.SemiBold)
    val titleGap = 20.dp
    val body = happyTextStyle(fontSize = 14)
    val bodyGap = 24.dp
    val terminalRadius = 18.dp
    val terminalPadding = 16.dp
    val terminalMinWidth = 280.dp
    val command = happyTextStyle(fontSize = 14, family = FontFamily.Monospace)
    val prompt = Color(0xFF00FF00)

    /** theme.ts glass.border, which HappyColors does not carry. */
    fun glassBorder(dark: Boolean) = if (dark) rgba(255, 255, 255, 0.14f) else rgba(255, 255, 255, 0.82f)
}

/**
 * Settings > Connect to Claude (settings/connect/claude.tsx). happy-app
 * ships the OAuth flow commented out, so this is its unsupported view: a
 * column centred in the screen, padded 20, of "Connect Claude" (18
 * semibold, 20 under it), "Run the following command in your terminal:"
 * (14, secondary, centred, 24 under it), and a terminal card at least 280
 * wide (radius 18, 16 padding, strong glass with a hairline glass border
 * and a soft shadow) showing a green "$ " and `happy connect claude` in
 * 14 monospace. happy-app draws the command white, unreadable on the light
 * theme's glass; it is the text colour here, as happy-ios does.
 */
@Composable
fun ConnectClaudeScreen(onBack: () -> Unit) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(ConnectClaudeSpec.terminalRadius)
    val command = "happy connect claude"
    Screen(header = { StackHeader("Connect to Claude", onBack) }) {
        Column(
            modifier = Modifier.fillMaxSize().padding(ConnectClaudeSpec.padding),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                "Connect Claude",
                style = ConnectClaudeSpec.title,
                color = colors.text,
                modifier = Modifier.padding(bottom = ConnectClaudeSpec.titleGap).testTag(ConnectClaudeTags.TITLE),
            )
            Text(
                "Run the following command in your terminal:",
                style = ConnectClaudeSpec.body,
                color = colors.textSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(bottom = ConnectClaudeSpec.bodyGap).testTag(ConnectClaudeTags.BODY),
            )
            Box(
                modifier = Modifier
                    .widthIn(min = ConnectClaudeSpec.terminalMinWidth)
                    .testTag(ConnectClaudeTags.TERMINAL)
                    .shadow(8.dp, shape)
                    .clip(shape)
                    .background(colors.glass.backgroundStrong)
                    .border(hairline(), ConnectClaudeSpec.glassBorder(colors.dark), shape)
                    .padding(ConnectClaudeSpec.terminalPadding),
            ) {
                Text(
                    buildAnnotatedString {
                        withStyle(SpanStyle(color = ConnectClaudeSpec.prompt)) { append("$ ") }
                        append(command)
                    },
                    style = ConnectClaudeSpec.command,
                    color = colors.text,
                )
            }
        }
    }
}
