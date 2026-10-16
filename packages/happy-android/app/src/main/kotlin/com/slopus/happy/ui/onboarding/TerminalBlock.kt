package com.slopus.happy.ui.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle

sealed interface TerminalLine {
    val text: String

    data class Command(override val text: String) : TerminalLine
    data class Comment(override val text: String) : TerminalLine
}

object TerminalBlockTags {
    const val BLOCK = "terminalBlock"
    const val LINE = "terminalBlock.line"
    const val PROMPT = "terminalBlock.prompt"
}

/**
 * TerminalBlock.tsx. The palette is the terminal on happy.engineering, dark
 * in both themes.
 */
object TerminalBlockSpec {
    val background = Color(0xFF14352F)
    val border = Color(0xFF24463F)
    val text = Color(0xFFF0EBE0)
    val prompt = Color(0xFF6FAE74)
    val comment = Color(0xFF8FAE8A)
    val radius = 14.dp
    val borderWidth = 1.dp
    val paddingVertical = 14.dp
    val paddingHorizontal = 18.dp
    val line = happyTextStyle(fontSize = 14, lineHeight = 24, family = PlexMono)
    const val PROMPT = "$ "
}

/**
 * A few shell lines the way the website draws them: full width, 1 border,
 * radius 14, 14/18 padding inside the border; mono 14/24 lines; a green `$ ` before each
 * command and muted comments. Every line can be selected and copied, and a
 * selection never takes in the prompt (RN's `selectable={false}` on it).
 */
@Composable
fun TerminalBlock(lines: List<TerminalLine>, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(TerminalBlockSpec.radius)
    SelectionContainer(
        modifier = modifier
            .fillMaxWidth()
            .testTag(TerminalBlockTags.BLOCK)
            .clip(shape)
            .background(TerminalBlockSpec.background)
            .border(TerminalBlockSpec.borderWidth, TerminalBlockSpec.border, shape),
    ) {
        Column(
            // RN pads inside the border.
            modifier = Modifier.padding(
                horizontal = TerminalBlockSpec.paddingHorizontal + TerminalBlockSpec.borderWidth,
                vertical = TerminalBlockSpec.paddingVertical + TerminalBlockSpec.borderWidth,
            ),
        ) {
            lines.forEach { line ->
                when (line) {
                    is TerminalLine.Comment -> Text(
                        text = line.text,
                        style = TerminalBlockSpec.line,
                        color = TerminalBlockSpec.comment,
                        modifier = Modifier.testTag(TerminalBlockTags.LINE),
                    )
                    is TerminalLine.Command -> Row(modifier = Modifier.testTag(TerminalBlockTags.LINE)) {
                        DisableSelection {
                            Text(
                                text = TerminalBlockSpec.PROMPT,
                                style = TerminalBlockSpec.line,
                                color = TerminalBlockSpec.prompt,
                                modifier = Modifier.testTag(TerminalBlockTags.PROMPT),
                            )
                        }
                        Text(text = line.text, style = TerminalBlockSpec.line, color = TerminalBlockSpec.text, modifier = Modifier.weight(1f))
                    }
                }
            }
        }
    }
}
