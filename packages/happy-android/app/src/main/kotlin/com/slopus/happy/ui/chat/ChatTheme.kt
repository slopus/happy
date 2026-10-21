package com.slopus.happy.ui.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import com.slopus.happy.ui.theme.HappyTheme

/**
 * The chat's colours from happy-app's theme.ts that the shared palette does
 * not carry (message, syntax, diff, permission button and terminal colours),
 * light and dark, Android branch.
 */
@Immutable
data class ChatColors(
    val userMessageText: Color,
    val agentMessageText: Color,
    val agentEventText: Color,
    val syntaxKeyword: Color,
    val syntaxString: Color,
    val syntaxComment: Color,
    val syntaxNumber: Color,
    val syntaxFunction: Color,
    val syntaxBrackets: List<Color>,
    val syntaxDefault: Color,
    val diffAddedBg: Color,
    val diffAddedText: Color,
    val diffRemovedBg: Color,
    val diffRemovedText: Color,
    val diffContextText: Color,
    val diffLineNumberText: Color,
    val diffOutline: Color,
    val allowBackground: Color,
    val denyBackground: Color,
    val allowAllBackground: Color,
    val buttonText: Color,
    val inactiveBackground: Color,
    val inactiveBorder: Color,
    val inactiveText: Color,
    val selectedBackground: Color,
    val selectedBorder: Color,
    val selectedText: Color,
    val terminalBackground: Color,
    val terminalPrompt: Color,
    val terminalStdout: Color,
    val terminalStderr: Color,
    val radioActive: Color,
    val radioInactive: Color,
    val glassBorder: Color,
    val gitAdded: Color,
    val gitRemoved: Color,
)

private fun c(hex: Long) = Color(hex or 0xFF000000)

val LightChatColors = ChatColors(
    userMessageText = c(0x000000), agentMessageText = c(0x000000), agentEventText = c(0x666666),
    syntaxKeyword = c(0x1d4ed8), syntaxString = c(0x059669), syntaxComment = c(0x6b7280), syntaxNumber = c(0x0891b2),
    syntaxFunction = c(0x9333ea),
    syntaxBrackets = listOf(c(0xff6b6b), c(0x4ecdc4), c(0x45b7d1), c(0xf7b731), c(0x5f27cd)),
    syntaxDefault = c(0x374151),
    diffAddedBg = c(0xE6FFED), diffAddedText = c(0x24292E), diffRemovedBg = c(0xFFEEF0), diffRemovedText = c(0x24292E),
    diffContextText = c(0x586069), diffLineNumberText = c(0x959DA5), diffOutline = c(0xE0E0E0),
    allowBackground = c(0x34C759), denyBackground = c(0xFF3B30), allowAllBackground = c(0x007AFF), buttonText = c(0xFFFFFF),
    inactiveBackground = c(0xE5E5EA), inactiveBorder = c(0xD1D1D6), inactiveText = c(0x8E8E93),
    selectedBackground = c(0xF2F2F7), selectedBorder = c(0xD1D1D6), selectedText = c(0x3C3C43),
    terminalBackground = c(0x1E1E1E), terminalPrompt = c(0x34C759), terminalStdout = c(0xE0E0E0), terminalStderr = c(0xFFB86C),
    radioActive = c(0x007AFF), radioInactive = c(0xC0C0C0),
    glassBorder = Color(0xD1FFFFFF),
    gitAdded = c(0x22c55e), gitRemoved = c(0xef4444),
)

val DarkChatColors = ChatColors(
    userMessageText = c(0xFFFFFF), agentMessageText = c(0xFFFFFF), agentEventText = c(0x8E8E93),
    syntaxKeyword = c(0x569CD6), syntaxString = c(0xCE9178), syntaxComment = c(0x6A9955), syntaxNumber = c(0xB5CEA8),
    syntaxFunction = c(0xDCDCAA),
    syntaxBrackets = listOf(c(0xFFD700), c(0xDA70D6), c(0x179FFF), c(0xFF8C00), c(0x00FF00)),
    syntaxDefault = c(0xD4D4D4),
    diffAddedBg = c(0x0D2E1F), diffAddedText = c(0xC9D1D9), diffRemovedBg = c(0x3F1B23), diffRemovedText = c(0xC9D1D9),
    diffContextText = c(0x8B949E), diffLineNumberText = c(0x6E7681), diffOutline = c(0x30363D),
    allowBackground = c(0x32D74B), denyBackground = c(0xFF453A), allowAllBackground = c(0x0A84FF), buttonText = c(0xFFFFFF),
    inactiveBackground = c(0x2C2C2E), inactiveBorder = c(0x38383A), inactiveText = c(0x8E8E93),
    selectedBackground = c(0x1C1C1E), selectedBorder = c(0x38383A), selectedText = c(0xFFFFFF),
    terminalBackground = c(0x1E1E1E), terminalPrompt = c(0x32D74B), terminalStdout = c(0xE0E0E0), terminalStderr = c(0xFFB86C),
    radioActive = c(0x0A84FF), radioInactive = c(0x48484A),
    // glass.border, rgba(255, 255, 255, 0.14).
    glassBorder = Color(0x24FFFFFF),
    gitAdded = c(0x34C759), gitRemoved = c(0xFF453A),
)

object ChatTheme {
    val colors: ChatColors
        @Composable @ReadOnlyComposable
        get() = if (HappyTheme.colors.dark) DarkChatColors else LightChatColors
}

/** utils/userMessageBubbleColor.ts: the six bubble presets, `gray` by default. */
@Immutable
data class BubblePalette(val background: Color, val border: Color, val indicator: Color)

fun userMessageBubblePalette(name: String?, dark: Boolean): BubblePalette {
    val light = mapOf(
        "blue" to BubblePalette(c(0xE8F2FF), c(0x9CC9FF), c(0x0A84FF)),
        "green" to BubblePalette(c(0xE9F7EF), c(0x96D6AE), c(0x34C759)),
        "purple" to BubblePalette(c(0xF0EBFF), c(0xB7A2FF), c(0x7D68CF)),
        "rose" to BubblePalette(c(0xFFF0F5), c(0xF3A4BF), c(0xD85D85)),
        "sand" to BubblePalette(c(0xF1E7D0), c(0xD9C292), c(0xB28B3D)),
        "gray" to BubblePalette(c(0xf0eee6), c(0xf0eee6), c(0x8E8E93)),
    )
    val darkPalettes = mapOf(
        "blue" to BubblePalette(c(0x17324D), c(0x2F6EA8), c(0x64B5FF)),
        "green" to BubblePalette(c(0x173A27), c(0x3D8B58), c(0x65D385)),
        "purple" to BubblePalette(c(0x2B214A), c(0x7D68CF), c(0xB8A8FF)),
        "rose" to BubblePalette(c(0x462232), c(0xC85E82), c(0xFF9DBB)),
        "sand" to BubblePalette(c(0x3A3326), c(0x8D7A55), c(0xE8C878)),
        "gray" to BubblePalette(c(0x2C2C2E), c(0x2C2C2E), c(0x8E8E93)),
    )
    val palettes = if (dark) darkPalettes else light
    return palettes[name] ?: palettes.getValue("gray")
}
