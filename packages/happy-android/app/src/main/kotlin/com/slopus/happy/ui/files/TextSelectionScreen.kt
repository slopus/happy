package com.slopus.happy.ui.files

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.HeaderBackButton
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle
import java.util.UUID

/**
 * persistence.ts `storeTempText` / `retrieveTempText`: long text handed to
 * the text selection screen by id rather than through the route. In memory
 * only; a process restart drops it, which the screen reports as expired.
 */
object TempText {
    private val texts = java.util.concurrent.ConcurrentHashMap<String, String>()

    fun store(text: String): String = UUID.randomUUID().toString().also { texts[it] = text }

    fun retrieve(id: String): String? = texts[id]
}

object TextSelectionTags {
    const val COPY = "textSelection.copy"
    const val PANEL = "textSelection.panel"
    const val TEXT = "textSelection.text"
}

/**
 * text-selection.tsx: "Select Text" with back, and a 24 copy-outline in
 * the right slot (padding 8, 8 from the edge; textSecondary and inert
 * while there is no text). The text in a glass panel 16 in from every
 * edge (radius 22, glass backgroundStrong, hairline glass border),
 * scrolling, padded 16 (and the navigation bar + 16 below): mono 14/20 in
 * the text colour, at least 200 high, selectable. While [text] is null:
 * "Loading..." 16 textSecondary, centred, 50 down.
 */
@Composable
fun TextSelectionScreen(text: String?, onBack: () -> Unit, onCopy: () -> Unit) {
    val colors = HappyTheme.colors
    val copyLabel = stringResource(R.string.common_copy)
    val enabled = !text.isNullOrEmpty()
    Screen(
        header = {
            Header(
                title = stringResource(R.string.text_selection_title),
                left = { HeaderBackButton(onClick = onBack) },
                right = {
                    Box(
                        Modifier
                            .padding(end = 8.dp)
                            .testTag(TextSelectionTags.COPY)
                            .clip(RoundedCornerShape(8.dp))
                            .clickable(enabled = enabled, role = Role.Button, onClick = onCopy)
                            .semantics { contentDescription = copyLabel }
                            .padding(8.dp),
                    ) {
                        Icon(Ionicon.CopyOutline, 24.dp, if (enabled) colors.header.tint else colors.textSecondary)
                    }
                },
            )
        },
    ) {
        if (text == null) {
            Text(
                stringResource(R.string.common_loading),
                style = happyTextStyle(fontSize = 16),
                color = colors.textSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 50.dp).align(Alignment.TopCenter),
            )
            return@Screen
        }
        val shape = RoundedCornerShape(22.dp)
        val border = if (colors.dark) Color(1f, 1f, 1f, 0.14f) else Color(1f, 1f, 1f, 0.82f)
        Box(
            Modifier
                .fillMaxSize()
                .padding(16.dp)
                .testTag(TextSelectionTags.PANEL)
                .clip(shape)
                .background(colors.glass.backgroundStrong)
                .border(0.5.dp, border, shape),
        ) {
            Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                SelectionContainer {
                    Text(
                        text,
                        style = happyTextStyle(fontSize = 14, lineHeight = 20, family = PlexMono),
                        color = colors.text,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp)
                            .windowInsetsPadding(WindowInsets.navigationBars)
                            .padding(bottom = 16.dp)
                            .heightIn(min = 200.dp)
                            .testTag(TextSelectionTags.TEXT),
                    )
                }
            }
        }
    }
}
