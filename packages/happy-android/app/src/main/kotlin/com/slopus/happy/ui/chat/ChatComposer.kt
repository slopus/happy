package com.slopus.happy.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.SessionState
import com.slopus.happy.ui.autocomplete.ComposerCursor
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Octicon
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object ComposerTags {
    const val COMPOSER = "composer"
    const val STATUS_ROW = "composer.status"
    const val STATUS_TEXT = "composer.status.text"
    const val PANEL = "composer.panel"
    const val INPUT_CONTAINER = "composer.inputContainer"
    const val INPUT = "composer.input"
    const val ACTION_ROW = "composer.actionRow"
    const val PRIMARY = "composer.primary"
}

/** agentInputLayout.ts `MOBILE_COMPOSER_METRICS` and AgentInput.tsx's stylesheet (Android phone). */
object ComposerSpec {
    val containerPaddingHorizontal = 8.dp
    val containerPaddingVertical = 8.dp
    val statusPaddingHorizontal = 16.dp
    val statusPaddingBottom = 4.dp
    val statusMinHeight = 20.dp
    val statusDot = 6.dp
    val statusGap = 4.dp
    val statusText = happyTextStyle(fontSize = 11)
    val shellRadius = 30.dp
    val shellInset = 10.dp
    val shellPaddingTop = 8.dp
    val shellPaddingBottom = 8.dp
    val inputMinHeight = 44.dp
    val inputMaxHeight = 120.dp
    val input = happyTextStyle(fontSize = 16, lineHeight = 22)
    val inputPaddingVertical = 4.dp
    /** (actionSize 42 - addIcon 26) / 2: the caret lines up with the add glyph. */
    val inputPaddingHorizontal = 8.dp
    val actionRowHeight = 42.dp
    val actionRowGap = 2.dp
    val primarySize = 42.dp
    val primaryMarginLeft = 8.dp
    val primaryIcon = 16.dp
    val lockIcon = 14.dp
}

/** The status line above the composer (useSessionStatus → AgentInput `connectionStatus`). */
@Immutable
data class ComposerStatus(val text: String, val color: Color, val pulsing: Boolean)

/** utils/sessionUtils.ts `useSessionStatus` colours. */
object SessionStatusColors {
    val disconnected = Color(0xFF999999)
    val attention = Color(0xFFFF9500)
    val thinking = Color(0xFF007AFF)
    val online = Color(0xFF34C759)
}

/** What the composer's round button does (agentInputPrimaryAction.ts). */
enum class PrimaryAction { Stop, Blocked, Send, Voice, Idle }

/**
 * `resolveAgentInputPrimaryAction`: Stop wins on an empty
 * composer while the agent can be stopped; a non-steerable busy agent
 * locks sending; otherwise text sends.
 */
fun resolvePrimaryAction(
    hasContent: Boolean,
    showAbort: Boolean,
    canAbort: Boolean,
    blocked: Boolean,
    disabled: Boolean = false,
    canVoice: Boolean = false,
): PrimaryAction = when {
    showAbort && canAbort && !hasContent -> PrimaryAction.Stop
    blocked && hasContent -> PrimaryAction.Blocked
    !disabled && hasContent -> PrimaryAction.Send
    !disabled && canVoice -> PrimaryAction.Voice
    else -> PrimaryAction.Idle
}

/**
 * The chat composer on a phone (AgentInput.tsx, compact mobile layout).
 * Spec: 8 around it. Above the card the status row: 16 in, 4 below, at
 * least 20 high; a 6 dot (pulsing while attention or thinking) 4 before
 * 11pt text in the status colour. The card: input.background, radius 30,
 * a hairline glass border, 10 side insets, 8 above and below. The input
 * box is at least 44 high, padded 8/4, the text 16/22 growing to 120 then
 * scrolling, placeholder in the input placeholder colour. Under it the
 * 42-high action row: the middle (pickers) takes the room, then the 42
 * round primary button 8 further in (10 from the middle). Primary looks:
 * send/idle surfaceHighest when it can send else #D1D1D6 (dark #3A3A3C),
 * Octicons arrow-up 16 in text (textSecondary when idle); stop
 * button.primary.background (dark #F5F5F5) with Octicons stop 16 white
 * (dark black); locked surfaceHigh with a 1 divider border and
 * lock-closed 14 textSecondary. A spinner replaces the glyph while
 * stopping. Voice uses surfaceHighest and the bundled 24 voice glyph tinted text.
 * A locked button still takes taps (to refuse them); an idle one
 * doesn't. [panelShake] shakes the card and [primaryShake] the button
 * (Shaker.tsx). With [showDetails] false (reading older messages under
 * the floating dock) the status row and the [bottom] row fade out in
 * place (AnimatedFade).
 */
@Composable
fun ChatComposer(
    text: String,
    onTextChange: (String) -> Unit,
    status: ComposerStatus?,
    primary: PrimaryAction,
    onPrimary: () -> Unit,
    modifier: Modifier = Modifier,
    aborting: Boolean = false,
    middle: @Composable () -> Unit = {},
    /** Above the input inside the panel (the attachment strip). */
    top: @Composable () -> Unit = {},
    /** Over the chat above the composer, taking no room (autocomplete suggestions). */
    overlay: @Composable () -> Unit = {},
    /** Shares the cursor with [overlay]: reported as it moves, placed after an insert; it sees hardware keys first. */
    cursor: ComposerCursor? = null,
    /** Hardware keys the [cursor] didn't take; true when used (the field then never sees it). */
    onKey: (KeyEvent) -> Boolean = { false },
    /** Shakes the card (a refused send). */
    panelShake: ShakeState? = null,
    /** Shakes the primary button (a failed stop). */
    primaryShake: ShakeState? = null,
    /** Under the card, inside the composer (the usage row: week quota and context gauge). */
    bottom: @Composable () -> Unit = {},
    /** `showStatusDetails`: false fades the status row and [bottom] out, keeping their room. */
    showDetails: Boolean = true,
    /** Where the card lands, for what floats just above it (the scroll-to-bottom button). */
    onPanelPositioned: ((LayoutCoordinates) -> Unit)? = null,
) {
    val colors = HappyTheme.colors
    var field by remember { mutableStateOf(TextFieldValue(text, TextRange(text.length))) }
    val placement = cursor?.placement
    val value = when {
        placement != null && placement.text == text -> TextFieldValue(text, placement.selection)
        field.text == text -> field
        else -> TextFieldValue(text, TextRange(text.length))
    }
    SideEffect { cursor?.selection = value.selection }
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    val shell = RoundedCornerShape(ComposerSpec.shellRadius)
    val layout = LocalWindowLayout.current
    Column(
        modifier = modifier
            .testTag(ComposerTags.COMPOSER)
            .fillMaxWidth()
            .padding(horizontal = ComposerSpec.containerPaddingHorizontal, vertical = ComposerSpec.containerPaddingVertical)
            // `innerContainer`: held to layout.maxWidth, centred.
            .contentMaxWidth(layout),
    ) {
        Box(Modifier.fillMaxWidth().height(0.dp).wrapContentHeight(Alignment.Bottom, unbounded = true)) { overlay() }
        if (status != null) AnimatedFade(showDetails) {
            Row(
                modifier = Modifier
                    .testTag(ComposerTags.STATUS_ROW)
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = ComposerSpec.statusMinHeight)
                    .padding(horizontal = ComposerSpec.statusPaddingHorizontal)
                    .padding(bottom = ComposerSpec.statusPaddingBottom),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(ComposerSpec.statusGap),
            ) {
                StatusDot(status.color, Modifier.padding(top = 1.dp), pulsing = status.pulsing, size = ComposerSpec.statusDot)
                Text(status.text, style = ComposerSpec.statusText, color = status.color, modifier = Modifier.testTag(ComposerTags.STATUS_TEXT))
            }
        }
        Column(
            modifier = Modifier
                .then(if (onPanelPositioned != null) Modifier.onGloballyPositioned(onPanelPositioned) else Modifier)
                .shake(panelShake)
                .testTag(ComposerTags.PANEL)
                .fillMaxWidth()
                .clip(shell)
                .background(colors.input.background)
                .border(hairline, ChatTheme.colors.glassBorder, shell)
                .padding(horizontal = ComposerSpec.shellInset)
                .padding(top = ComposerSpec.shellPaddingTop, bottom = ComposerSpec.shellPaddingBottom),
        ) {
            top()
            Box(
                modifier = Modifier
                    .testTag(ComposerTags.INPUT_CONTAINER)
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = ComposerSpec.inputMinHeight)
                    .padding(horizontal = ComposerSpec.inputPaddingHorizontal, vertical = ComposerSpec.inputPaddingVertical),
                contentAlignment = Alignment.CenterStart,
            ) {
                BasicTextField(
                    value = value,
                    onValueChange = { next ->
                        field = next
                        cursor?.placement = null
                        cursor?.selection = next.selection
                        if (next.text != text) onTextChange(next.text)
                    },
                    textStyle = ComposerSpec.input.copy(color = colors.input.text),
                    cursorBrush = SolidColor(colors.input.text),
                    modifier = Modifier
                        .onPreviewKeyEvent { cursor?.onKey?.invoke(it) == true || onKey(it) }
                        .testTag(ComposerTags.INPUT)
                        .fillMaxWidth()
                        .heightIn(max = ComposerSpec.inputMaxHeight),
                    decorationBox = { field ->
                        Box {
                            if (text.isEmpty()) {
                                Text(
                                    stringResource(R.string.session_input_placeholder),
                                    style = ComposerSpec.input,
                                    color = colors.input.placeholder,
                                    maxLines = 1,
                                )
                            }
                            field()
                        }
                    },
                )
            }
            Row(
                modifier = Modifier.testTag(ComposerTags.ACTION_ROW).fillMaxWidth().heightIn(min = ComposerSpec.actionRowHeight),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(ComposerSpec.actionRowGap),
            ) {
                Box(modifier = Modifier.weight(1f).heightIn(min = ComposerSpec.actionRowHeight), contentAlignment = Alignment.CenterStart) {
                    middle()
                }
                // With the row gap on each side: 2 + 8 between the middle and the button, as in RN.
                Spacer(Modifier.width(ComposerSpec.primaryMarginLeft - ComposerSpec.actionRowGap))
                PrimaryButton(primary, aborting, onPrimary, primaryShake)
            }
        }
        AnimatedFade(showDetails) { bottom() }
    }
}

@Composable
private fun PrimaryButton(action: PrimaryAction, aborting: Boolean, onClick: () -> Unit, shake: ShakeState?) {
    val colors = HappyTheme.colors
    val dark = colors.dark
    val background = when (action) {
        PrimaryAction.Stop -> if (dark) Color(0xFFF5F5F5) else colors.button.primaryBackground
        PrimaryAction.Blocked -> colors.surfaceHigh
        PrimaryAction.Send, PrimaryAction.Voice -> colors.surfaceHighest
        PrimaryAction.Idle -> if (dark) Color(0xFF3A3A3C) else Color(0xFFD1D1D6)
    }
    // A locked send still takes the tap, to refuse it.
    val enabled = action != PrimaryAction.Idle
    // Literal in happy-app (AgentInput.tsx accessibilityLabel).
    val label = when (action) {
        PrimaryAction.Stop -> "Stop"
        PrimaryAction.Voice -> "Voice"
        else -> "Send"
    }
    Box(
        modifier = Modifier
            .shake(shake)
            .testTag(ComposerTags.PRIMARY)
            .size(ComposerSpec.primarySize)
            .clip(CircleShape)
            .background(background)
            .then(if (action == PrimaryAction.Blocked) Modifier.border(1.dp, colors.divider, CircleShape) else Modifier)
            .clickable(enabled = enabled && !aborting, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        when {
            aborting -> CircularProgressIndicator(
                Modifier.size(20.dp),
                color = if (action == PrimaryAction.Stop && dark) Color.Black else colors.text,
                strokeWidth = 2.dp,
            )
            action == PrimaryAction.Stop -> Icon(Octicon.Stop, ComposerSpec.primaryIcon, if (dark) Color.Black else Color.White)
            action == PrimaryAction.Blocked -> Icon(Ionicon.LockClosed, ComposerSpec.lockIcon, colors.textSecondary)
            action == PrimaryAction.Voice -> androidx.compose.foundation.Image(
                painter = androidx.compose.ui.res.painterResource(com.slopus.happy.R.drawable.icon_voice_white),
                contentDescription = null,
                colorFilter = androidx.compose.ui.graphics.ColorFilter.tint(colors.text),
                modifier = Modifier.size(24.dp),
            )
            else -> Icon(
                Octicon.ArrowUp,
                ComposerSpec.primaryIcon,
                if (action == PrimaryAction.Send) colors.text else colors.textSecondary,
            )
        }
    }
}

/** Whether Stop belongs on the composer: the agent is busy or waiting on the user. */
fun showsAbort(state: SessionState): Boolean =
    state == SessionState.Thinking || state == SessionState.PermissionRequired || state == SessionState.InputRequired
