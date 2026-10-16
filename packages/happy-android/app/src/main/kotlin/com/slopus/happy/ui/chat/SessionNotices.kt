package com.slopus.happy.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.ResumeCommandBlock
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay

object SessionNoticeTags {
    const val CLI_WARNING = "chat.cliWarning"
    const val INACTIVE = "chat.inactive"
    const val INACTIVE_TEXT = "chat.inactive.text"
    const val RESUME = "chat.inactive.resume"
    const val RESUME_COMMAND = "chat.inactive.command"
}

/** SessionView.tsx's CLI warning pill and `InactiveArchivedHint`. */
object SessionNoticeSpec {
    val pillTop = 8.dp
    val pillBackground = Color(0xFFFFF3CD)
    val pillText = Color(0xFF856404)
    val pillIcon = Color(0xFFFF9500)
    val pillPaddingHorizontal = 14.dp
    val pillPaddingVertical = 7.dp
    val pillGlyph = 14.dp
    val pillIconGap = 6.dp
    val pillCloseGap = 8.dp
    val pillElevation = 4.dp
    val pillLabel = happyTextStyle(fontSize = 12, weight = FontWeight.SemiBold)

    val hintPaddingTop = 12.dp
    val hintPaddingBottom = 10.dp
    val hintGap = 10.dp
    val hintTextPaddingHorizontal = 8.dp
    val hintTextGap = 4.dp
    val hintText = happyTextStyle(fontSize = 13, lineHeight = 18)
    val buttonHeight = 44.dp
    val buttonRadius = 18.dp
    val buttonMarginHorizontal = 8.dp
    val buttonLabel = happyTextStyle(fontSize = 15, weight = FontWeight.SemiBold)
    const val RESUMING_OPACITY = 0.6f
    val commandMinHeight = 48.dp
    val commandPaddingHorizontal = 16.dp
    val commandPaddingVertical = 12.dp
    val commandGap = 8.dp
    val commandText = happyTextStyle(fontSize = 13, lineHeight = 18, family = FontFamily.Monospace)
    val commandIcon = 16.dp
    val copied = Color(0xFF30D158)
    const val COPIED_MS = 2_000L
}

/**
 * The CLI warning pill (SessionView.tsx): centred, 8 below the header, a
 * fully round #FFF3CD pill padded 14/7 at elevation 4; warning-outline 14
 * #FF9500, 6 before "CLI Update Required" 12 semibold #856404, then close 14
 * #856404 8 after. The same colours in both themes, as in happy-app. A tap
 * acknowledges this CLI version on this machine.
 */
@Composable
fun CliWarningPill(onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(percent = 50)
    Row(
        modifier = modifier
            .padding(top = SessionNoticeSpec.pillTop)
            .testTag(SessionNoticeTags.CLI_WARNING)
            .shadow(SessionNoticeSpec.pillElevation, shape)
            .clip(shape)
            .background(SessionNoticeSpec.pillBackground)
            .clickable(role = Role.Button, onClick = onDismiss)
            .padding(horizontal = SessionNoticeSpec.pillPaddingHorizontal, vertical = SessionNoticeSpec.pillPaddingVertical),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Ionicon.WarningOutline, SessionNoticeSpec.pillGlyph, SessionNoticeSpec.pillIcon, Modifier.padding(end = SessionNoticeSpec.pillIconGap))
        Text(stringResource(R.string.session_info_cli_version_outdated), style = SessionNoticeSpec.pillLabel, color = SessionNoticeSpec.pillText)
        Icon(Ionicon.Close, SessionNoticeSpec.pillGlyph, SessionNoticeSpec.pillText, Modifier.padding(start = SessionNoticeSpec.pillCloseGap))
    }
}

/** What `InactiveArchivedHint` offers: Resume when it can run, else the terminal command (if there is one). */
@Immutable
data class InactiveHint(val canResume: Boolean, val resuming: Boolean, val resumeCommand: ResumeCommandBlock?)

/**
 * `InactiveArchivedHint`, above the composer of a disconnected Happy CLI
 * session. Spec: 12 above, 10 below, 10 between its parts. "This session is
 * inactive." (and, without Resume, "To resume it from the terminal:") in
 * 13/18 agentEventText, 8 in, 4 apart. Then either the Resume button — 44
 * high, radius 18, surfaceHigh (surfacePressed while pressed), a hairline
 * divider border, 8 in, "Resume Session" 15 semibold, a spinner and 0.6
 * while resuming — or the command block: at least 48 high, radius 18,
 * surface (surfacePressed while pressed), hairline divider border, padded
 * 16/12, its lines in 13/18 monospace, copy-outline 16 textSecondary 8
 * after (a #30D158 checkmark for 2 s once copied). A tap copies.
 */
@Composable
fun InactiveArchivedHint(hint: InactiveHint, onResume: () -> Unit, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val resumeLabel = stringResource(R.string.session_info_resume_session)
    val chat = ChatTheme.colors
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    val shape = RoundedCornerShape(SessionNoticeSpec.buttonRadius)
    Column(
        modifier = modifier
            .testTag(SessionNoticeTags.INACTIVE)
            .fillMaxWidth()
            .padding(top = SessionNoticeSpec.hintPaddingTop, bottom = SessionNoticeSpec.hintPaddingBottom),
        verticalArrangement = Arrangement.spacedBy(SessionNoticeSpec.hintGap),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = SessionNoticeSpec.hintTextPaddingHorizontal),
            verticalArrangement = Arrangement.spacedBy(SessionNoticeSpec.hintTextGap),
        ) {
            Text(
                stringResource(R.string.session_inactive_archived),
                style = SessionNoticeSpec.hintText,
                color = chat.agentEventText,
                modifier = Modifier.testTag(SessionNoticeTags.INACTIVE_TEXT),
            )
            if (!hint.canResume && hint.resumeCommand != null) {
                Text(stringResource(R.string.session_resume_from_terminal), style = SessionNoticeSpec.hintText, color = chat.agentEventText)
            }
        }
        if (hint.canResume) {
            val interaction = remember { MutableInteractionSource() }
            val pressed by interaction.collectIsPressedAsState()
            Box(
                modifier = Modifier
                    .padding(horizontal = SessionNoticeSpec.buttonMarginHorizontal)
                    .testTag(SessionNoticeTags.RESUME)
                    .fillMaxWidth()
                    .height(SessionNoticeSpec.buttonHeight)
                    .alpha(if (hint.resuming) SessionNoticeSpec.RESUMING_OPACITY else 1f)
                    .clip(shape)
                    .background(if (pressed) colors.surfacePressed else colors.surfaceHigh)
                    .border(hairline, colors.divider, shape)
                    .clickable(interactionSource = interaction, indication = null, enabled = !hint.resuming, role = Role.Button, onClick = onResume)
                    // The spinner replaces the label; TalkBack still names the button.
                    .then(if (hint.resuming) Modifier.semantics { contentDescription = resumeLabel } else Modifier),
                contentAlignment = Alignment.Center,
            ) {
                if (hint.resuming) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = colors.text, strokeWidth = 2.dp)
                } else {
                    Text(resumeLabel, style = SessionNoticeSpec.buttonLabel, color = colors.text)
                }
            }
        } else if (hint.resumeCommand != null) {
            ResumeCommandCopyBlock(hint.resumeCommand)
        }
    }
}

@Composable
private fun ResumeCommandCopyBlock(block: ResumeCommandBlock) {
    val colors = HappyTheme.colors
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    val shape = RoundedCornerShape(SessionNoticeSpec.buttonRadius)
    val copy = rememberCopyText()
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(SessionNoticeSpec.COPIED_MS)
            copied = false
        }
    }
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Row(
        modifier = Modifier
            .testTag(SessionNoticeTags.RESUME_COMMAND)
            .fillMaxWidth()
            .heightIn(min = SessionNoticeSpec.commandMinHeight)
            .clip(shape)
            .background(if (pressed) colors.surfacePressed else colors.surface)
            .border(hairline, colors.divider, shape)
            .clickable(interactionSource = interaction, indication = null, role = Role.Button) {
                copy(block.copyText)
                copied = true
            }
            .padding(horizontal = SessionNoticeSpec.commandPaddingHorizontal, vertical = SessionNoticeSpec.commandPaddingVertical),
        horizontalArrangement = Arrangement.spacedBy(SessionNoticeSpec.commandGap),
        verticalAlignment = Alignment.Top,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            for (line in block.lines) Text(line, style = SessionNoticeSpec.commandText, color = colors.text)
        }
        Icon(
            if (copied) Ionicon.Checkmark else Ionicon.CopyOutline,
            SessionNoticeSpec.commandIcon,
            if (copied) SessionNoticeSpec.copied else colors.textSecondary,
            Modifier.padding(top = 1.dp),
        )
    }
}
