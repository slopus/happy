package com.slopus.happy.ui.documents

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.theme.HappyTheme

/**
 * iOS's `DocumentToolbarLayout.Metrics`: a 56 bar of 44 buttons 2 apart, in
 * a capsule 8 from the edge with 4 inside it, which scrolls when they don't
 * fit, and the hide-keyboard button in its own capsule 8 after it.
 */
object DocumentToolbarSpec {
    val height = 56.dp
    val button = 44.dp
    val spacing = 2.dp
    val margin = 8.dp
    val padding = 4.dp
    val gap = 8.dp
    val buttonCorner = 12.dp
    val glyph = 22.dp
}

object DocumentToolbarTags {
    const val BAR = "document.toolbar"
    const val STRIP = "document.toolbar.strip"
    const val STYLE = "document.tool.style"
    const val DONE = "document.tool.done"
    fun tool(tool: DocumentTool) = "document.tool.${tool.name.lowercase()}"
}

private val toolGlyphs: List<Pair<DocumentTool, ImageVector>> by lazy {
    listOf(
        DocumentTool.Bold to DocumentSymbols.Bold,
        DocumentTool.Italic to DocumentSymbols.Italic,
        DocumentTool.Strike to DocumentSymbols.Strike,
        DocumentTool.Code to DocumentSymbols.Code,
        DocumentTool.Link to DocumentSymbols.Link,
        DocumentTool.Bullets to DocumentSymbols.Bullets,
        DocumentTool.Numbers to DocumentSymbols.Numbers,
        DocumentTool.Checklist to DocumentSymbols.Checklist,
        DocumentTool.Quote to DocumentSymbols.Quote,
        DocumentTool.CodeBlock to DocumentSymbols.CodeBlock,
        DocumentTool.Outdent to DocumentSymbols.Outdent,
        DocumentTool.Indent to DocumentSymbols.Indent,
        DocumentTool.Divider to DocumentSymbols.Divider,
    )
}

@Composable
private fun toolTitle(tool: DocumentTool): String = stringResource(
    when (tool) {
        DocumentTool.Bold -> R.string.document_bold
        DocumentTool.Italic -> R.string.document_italic
        DocumentTool.Strike -> R.string.document_strike
        DocumentTool.Code -> R.string.document_code
        DocumentTool.Link -> R.string.document_link
        DocumentTool.Bullets -> R.string.document_bullets
        DocumentTool.Numbers -> R.string.document_numbers
        DocumentTool.Checklist -> R.string.document_checklist
        DocumentTool.Quote -> R.string.document_quote
        DocumentTool.CodeBlock -> R.string.document_code_block
        DocumentTool.Outdent -> R.string.document_outdent
        DocumentTool.Indent -> R.string.document_indent
        DocumentTool.Divider -> R.string.document_divider
    },
)

/**
 * The formatting bar over the keyboard (iOS's `DocumentToolbar`, spec in
 * [DocumentToolbarSpec]): the text style menu (Text, Heading 1 to 3) and
 * the tools in a strip that scrolls, then a button that puts the keyboard
 * away. A tool is lit (document link colour on its faint fill) while the
 * selection has it; TalkBack reads it as selected.
 */
@Composable
fun DocumentToolbar(
    active: Set<DocumentTool>,
    onTool: (DocumentTool) -> Unit,
    onStyle: (Int) -> Unit,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = HappyTheme.colors
    val dark = colors.dark
    val ink = Color(DocumentTokens.tool.of(dark))
    val capsule = RoundedCornerShape(50)
    val fill = colors.surfaceHigh
    Row(
        modifier.testTag(DocumentToolbarTags.BAR).fillMaxWidth().height(DocumentToolbarSpec.height).padding(horizontal = DocumentToolbarSpec.margin),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(DocumentToolbarSpec.gap),
    ) {
        Box(Modifier.testTag(DocumentToolbarTags.STRIP).weight(1f).clip(capsule).background(fill)) {
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(DocumentToolbarSpec.padding),
                horizontalArrangement = Arrangement.spacedBy(DocumentToolbarSpec.spacing),
            ) {
                StyleButton(ink, onStyle)
                for ((tool, glyph) in toolGlyphs) {
                    ToolButton(glyph, toolTitle(tool), tool in active, ink, Modifier.testTag(DocumentToolbarTags.tool(tool))) { onTool(tool) }
                }
            }
        }
        Box(Modifier.clip(capsule).background(fill).padding(DocumentToolbarSpec.padding)) {
            ToolButton(DocumentSymbols.HideKeyboard, stringResource(R.string.document_hide_keyboard), false, ink, Modifier.testTag(DocumentToolbarTags.DONE), onDone)
        }
    }
}

@Composable
private fun ToolButton(glyph: ImageVector, title: String, lit: Boolean, ink: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val dark = HappyTheme.colors.dark
    IconButton(
        onClick = onClick,
        modifier = modifier
            .size(DocumentToolbarSpec.button)
            .clip(RoundedCornerShape(DocumentToolbarSpec.buttonCorner))
            .background(if (lit) Color(DocumentTokens.toolActiveFill.of(dark)) else Color.Transparent)
            .semantics { selected = lit },
    ) {
        Icon(glyph, title, Modifier.size(DocumentToolbarSpec.glyph), tint = if (lit) Color(DocumentTokens.toolActive.of(dark)) else ink)
    }
}

/** iOS's style button, whose menu is its primary action: Text, Heading 1, 2, 3. */
@Composable
private fun StyleButton(ink: Color, onStyle: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        ToolButton(DocumentSymbols.TextStyle, stringResource(R.string.document_text_style), false, ink, Modifier.testTag(DocumentToolbarTags.STYLE)) { open = true }
        HappyDropdownMenu(open, onDismissRequest = { open = false }) {
            HappyMenuItem(stringResource(R.string.document_text), onClick = { open = false; onStyle(0) })
            for (level in 1..3) HappyMenuItem(stringResource(R.string.document_heading, level), onClick = { open = false; onStyle(level) })
        }
    }
}
