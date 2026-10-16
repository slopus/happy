package com.slopus.happy.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.slopus.happy.chat.tools.parseToolUseError
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme

/**
 * ToolSectionView.tsx: 12 below; a title in 13 semibold textSecondary
 * uppercase, 6 above the content. Full width bleeds over the card's 12
 * side padding and 8 top padding, flush under the header.
 */
@Composable
fun ToolSection(title: String? = null, fullWidth: Boolean = false, content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = ToolSpec.sectionMarginBottom)
            .then(if (fullWidth) Modifier.outset(start = ToolSpec.contentPaddingHorizontal, top = ToolSpec.contentPaddingTop, end = ToolSpec.contentPaddingHorizontal) else Modifier)
            .testTag(ToolTags.SECTION),
    ) {
        if (title != null) {
            Text(
                title.uppercase(),
                style = ToolSpec.sectionTitle,
                color = HappyTheme.colors.textSecondary,
                modifier = Modifier
                    .padding(bottom = ToolSpec.sectionTitleMarginBottom)
                    .then(if (fullWidth) Modifier.padding(horizontal = ToolSpec.contentPaddingHorizontal) else Modifier)
                    .testTag(ToolTags.SECTION_TITLE),
            )
        }
        content()
    }
}

/**
 * ToolError.tsx: boxError fill and 1 border, radius 6, padding 12, 12
 * below, at most 115 high; 13 text in the box's text colour. A tool-use
 * error shows its message alone, after a 16 warning glyph, 8 apart.
 */
@Composable
fun ToolError(message: String, modifier: Modifier = Modifier) {
    val box = HappyTheme.colors.boxError
    val toolUse = parseToolUseError(message)
    val shape = RoundedCornerShape(ToolSpec.errorRadius)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(bottom = ToolSpec.sectionMarginBottom)
            .testTag(ToolTags.ERROR)
            .heightIn(max = ToolSpec.errorMaxHeight)
            .clip(shape)
            .background(box.background)
            .border(1.dp, box.border, shape)
            .padding(ToolSpec.errorPadding),
        horizontalArrangement = Arrangement.spacedBy(ToolSpec.errorGap),
    ) {
        if (toolUse != null) Icon(Ionicon.Warning, ToolSpec.errorIcon, HappyTheme.colors.boxWarning.text)
        Text(toolUse?.ifEmpty { message } ?: message, style = ToolSpec.errorText, color = box.text, modifier = Modifier.weight(1f))
    }
}

/** CodeView.tsx: surfaceHigh, radius 6, padding 12, mono 12/18 in the text colour. */
@Composable
fun CodeView(code: String, modifier: Modifier = Modifier) {
    Text(
        code,
        style = ToolSpec.code,
        color = HappyTheme.colors.text,
        modifier = modifier
            .fillMaxWidth()
            .testTag(ToolTags.CODE)
            .clip(RoundedCornerShape(ToolSpec.codeRadius))
            .background(HappyTheme.colors.surfaceHigh)
            .padding(ToolSpec.codePadding),
    )
}
