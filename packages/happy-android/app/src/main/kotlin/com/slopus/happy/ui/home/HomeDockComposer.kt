package com.slopus.happy.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max
import androidx.compose.ui.unit.min
import com.slopus.happy.R
import com.slopus.happy.model.AgentType
import com.slopus.happy.model.NewSessionPage
import com.slopus.happy.model.StartButton
import com.slopus.happy.model.StartProgress
import com.slopus.happy.model.sanitizeBotName
import com.slopus.happy.ui.attachments.AttachmentStrip
import com.slopus.happy.ui.attachments.AttachmentStripSpec
import com.slopus.happy.ui.chat.ChatTheme
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Octicon
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.theme.HappyTheme

/**
 * HomeDock.tsx's focused composer: the input (or the bot's name), the
 * picked images over it, then the action row (add image, permission, the
 * model and effort chips, [PrimaryButton]). It grows out of the resting
 * capsule as [progress] runs; [refusal] is the busy refusal's flash.
 */
@Composable
internal fun FocusedComposer(
    state: HomeDockState,
    actions: HomeDockActions,
    button: StartButton,
    progress: Float,
    refusal: Float,
    refuse: () -> Unit,
    open: (NewSessionPage) -> Unit,
    onStop: () -> Unit,
) {
    val colors = HappyTheme.colors
    val options = state.options
    val shape = RoundedCornerShape(HomeDockSpec.composerRadius)
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Column(
        modifier = Modifier
            .testTag(HomeDockTags.COMPOSER)
            .fillMaxWidth()
            .graphicsLayer {
                alpha = 0.72f + 0.28f * reveal(progress, 0f, 0.12f)
                scaleX = 0.96f + 0.04f * progress
            }
            .shadow(if (colors.dark) 4.dp else 2.dp, shape)
            .clip(shape)
            // focusedComposerAnimationShell: the shell grows from the resting dock's height to
            // the composer's, and the composer stays anchored to its bottom (focusedComposerAnchored).
            .layout { measurable, constraints ->
                val placeable = measurable.measure(constraints)
                val shell = composerShellHeight(HomeDockSpec.shellHeight.toPx(), placeable.height, progress)
                layout(placeable.width, shell) { placeable.place(0, shell - placeable.height) }
            }
            .background(colors.input.background)
            .border(hairline(), ChatTheme.colors.glassBorder, shape)
            .padding(horizontal = HomeDockSpec.composerInset, vertical = HomeDockSpec.composerPaddingVertical),
    ) {
        val inputShown = reveal(progress, 0.22f, 0.6f)
        val images = state.attachedImages
        if (images.isNotEmpty()) {
            AttachmentStrip(
                images,
                onRemove = { id -> if (state.phase != null) refuse() else actions.onRemoveImage(id) },
                modifier = Modifier
                    // The strip keeps room for the remove buttons above and below its
                    // thumbnails; the composer grows by the thumbnails and the 8 under
                    // them only (attachmentExtraHeight 72), the buttons reaching into
                    // the shell's padding as they do in happy-app.
                    .layout { measurable, constraints ->
                        val placeable = measurable.measure(constraints)
                        val overflow = AttachmentStripSpec.removeOffset.roundToPx()
                        layout(placeable.width, (placeable.height - 2 * overflow).coerceAtLeast(0)) { placeable.place(0, -overflow) }
                    }
                    .graphicsLayer {
                        alpha = inputShown
                        translationY = 8.dp.toPx() * (1 - inputShown)
                    },
            )
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .graphicsLayer {
                    alpha = inputShown
                    translationY = 8.dp.toPx() * (1 - inputShown)
                }
                .defaultMinSize(minHeight = HomeDockSpec.inputMinHeight)
                .padding(horizontal = HomeDockSpec.inputPaddingHorizontal, vertical = HomeDockSpec.inputPaddingVertical),
            contentAlignment = Alignment.CenterStart,
        ) {
            // The one input is the prompt for a session and the name for a bot, so switching keeps the keyboard.
            val bot = state.bot?.takeIf { it.creating }
            val text = bot?.name ?: state.prompt
            val placeholder = if (bot != null) {
                stringResource(R.string.home_dock_bot_name_placeholder)
            } else {
                stringResource(R.string.home_dock_ask, options?.agent?.name ?: AgentType.Claude.displayName)
            }
            BasicTextField(
                value = text,
                // Locked while starting without taking the keyboard down: the change is refused.
                onValueChange = {
                    when {
                        state.phase != null -> refuse()
                        // A pasted line break becomes a space and the daemon's ceiling is kept.
                        bot != null -> actions.onBotNameChange(sanitizeBotName(it))
                        else -> actions.onPromptChange(it)
                    }
                },
                singleLine = bot != null,
                keyboardOptions = if (bot != null) KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done) else KeyboardOptions.Default,
                keyboardActions = KeyboardActions(onDone = { if (state.canSubmit()) actions.onSubmit() }),
                textStyle = HomeDockSpec.input.copy(color = colors.input.text),
                cursorBrush = SolidColor(colors.text),
                modifier = Modifier
                    .testTag(HomeDockTags.INPUT)
                    .fillMaxWidth()
                    .heightIn(max = HomeDockSpec.inputMaxHeight)
                    .focusRequester(focus),
                decorationBox = { field ->
                    Box {
                        if (text.isEmpty()) {
                            Text(placeholder, style = HomeDockSpec.input, color = colors.textSecondary, maxLines = 1)
                        }
                        field()
                    }
                },
            )
        }
        val actionsShown = reveal(progress, 0.46f, 0.82f)
        Row(
            modifier = Modifier
                .testTag(HomeDockTags.ACTION_ROW)
                .fillMaxWidth()
                .height(HomeDockSpec.actionRowHeight)
                .graphicsLayer {
                    alpha = actionsShown
                    translationY = 7.dp.toPx() * (1 - actionsShown)
                },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(HomeDockSpec.actionRowGap),
        ) {
            // A bot is made from a name and a face: images belong to a first message.
            if (state.canAttachImages && !state.creatingBot) {
                AddImageButton(onClick = { if (state.phase != null) refuse() else actions.onAddImage() })
            }
            // Every chip lives in this one box; send is its sibling, so nothing inside reaches it.
            Row(
                modifier = Modifier.weight(1f).height(HomeDockSpec.actionRowHeight).clipToBounds(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(HomeDockSpec.actionRowGap),
            ) {
                val chip = { page: NewSessionPage -> { if (state.phase != null) refuse() else open(page) } }
                // A bot is configured once made: no permission, model or effort here.
                val permission = options?.permissionLabel?.takeUnless { state.creatingBot }
                if (permission != null) {
                    Chip(permission, HomeDockTags.PERMISSION, pageTitle(NewSessionPage.Permission, false), chip(NewSessionPage.Permission), start = 4.dp, end = 8.dp)
                }
                // Model and effort sit against the send button, the model giving way first.
                Row(
                    modifier = Modifier.weight(1f).padding(start = HomeDockSpec.actionRowGap),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(HomeDockSpec.actionRowGap, Alignment.End),
                ) {
                    if (options != null && !state.creatingBot) {
                        Chip(
                            options.modelChip,
                            HomeDockTags.MODEL,
                            pageTitle(NewSessionPage.Model, false),
                            chip(NewSessionPage.Model).takeIf { options.models.any { it.options.isNotEmpty() } },
                            start = 12.dp,
                            end = 4.dp,
                            modifier = Modifier.weight(1f, fill = false),
                            alignment = Alignment.CenterEnd,
                        )
                    }
                    val effort = options?.effort?.takeUnless { state.creatingBot }
                    if (effort != null) {
                        Text("·", style = HomeDockSpec.chip, color = colors.textSecondary)
                        Chip(
                            effort.name,
                            HomeDockTags.EFFORT,
                            pageTitle(NewSessionPage.Effort, false),
                            chip(NewSessionPage.Effort),
                            start = 4.dp,
                            end = 6.dp,
                            modifier = Modifier.widthIn(min = HomeDockSpec.effortMinWidth),
                            alignment = Alignment.CenterStart,
                        )
                    }
                }
            }
            PrimaryButton(button, refusal, creatingBot = state.creatingBot, onClick = if (button == StartButton.Stop) onStop else actions.onSubmit)
        }
    }
}

/** One of the action row's 40 high chips (permission, model, effort); without [onClick] it shows but takes no press. */
@Composable
private fun Chip(
    text: String,
    tag: String,
    description: String,
    onClick: (() -> Unit)?,
    start: Dp,
    end: Dp,
    modifier: Modifier = Modifier,
    alignment: Alignment = Alignment.Center,
) {
    Box(
        modifier = modifier
            .testTag(tag)
            .height(HomeDockSpec.chipHeight)
            .clip(RoundedCornerShape(HomeDockSpec.chipHeight / 2))
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .semantics { contentDescription = description }
            .padding(start = start, end = end),
        contentAlignment = alignment,
    ) {
        Text(text, style = HomeDockSpec.chip, color = HappyTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** HomeDock's add button: a 42 circle, add 26 in text, glass backgroundSubtle while pressed. */
@Composable
private fun AddImageButton(onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val label = stringResource(R.string.home_dock_add_image)
    Box(
        modifier = Modifier
            .testTag(HomeDockTags.ADD_IMAGE)
            .size(HomeDockSpec.addSize)
            .clip(CircleShape)
            .background(if (pressed) colors.glass.backgroundSubtle else Color.Transparent)
            .clickable(interaction, indication = null, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Icon(Ionicon.Add, HomeDockSpec.addIcon, colors.text)
    }
}

/** The 42 primary button: Send (or Create bot), Stop, or a spinner while the start can't be stopped. */
@Composable
private fun PrimaryButton(button: StartButton, refusal: Float, creatingBot: Boolean, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val filled = button == StartButton.Send || button == StartButton.Stop
    val label = stringResource(
        when {
            button == StartButton.Stop -> R.string.home_dock_stop
            creatingBot -> R.string.home_dock_create_bot
            else -> R.string.home_dock_send
        },
    )
    Box(
        modifier = Modifier
            .padding(start = HomeDockSpec.primaryMarginStart)
            .testTag(HomeDockTags.PRIMARY)
            .size(HomeDockSpec.sendSize)
            .graphicsLayer {
                scaleX = 1 + refusal * 0.1f
                scaleY = 1 + refusal * 0.1f
            }
            .clip(CircleShape)
            .background(if (filled) sendBackground(colors) else colors.surfaceHighest)
            .clickable(enabled = filled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        if (button == StartButton.Stop) {
            // A lighter wash under the glyph: the button is already the darkest thing on screen.
            Box(
                Modifier
                    .matchParentSize()
                    .graphicsLayer { alpha = refusal * 0.55f }
                    .background(if (colors.dark) Color(0xFF4A4A4E) else Color.White),
            )
        }
        when (button) {
            StartButton.Busy -> CircularProgressIndicator(Modifier.size(20.dp), color = colors.textSecondary, strokeWidth = 2.dp)
            StartButton.Stop -> Icon(Octicon.Stop, HomeDockSpec.sendIcon, sendIconColor(colors))
            else -> Icon(Ionicon.ArrowUp, HomeDockSpec.sendIcon, if (button == StartButton.Send) sendIconColor(colors) else colors.textSecondary)
        }
    }
}

/** The 18 high line over the composer naming the start's step, with "To interrupt press stop" while Stop is offered. */
@Composable
internal fun ProgressLine(step: StartProgress, showHint: Boolean, refusal: Float, modifier: Modifier) {
    val colors = HappyTheme.colors
    val text = when (step) {
        is StartProgress.CreatingWorkspace -> stringResource(if (step.workspace) R.string.home_dock_creating_workspace else R.string.home_dock_creating_worktree)
        is StartProgress.Starting -> stringResource(R.string.home_dock_starting, step.agentName)
        StartProgress.CreatingBot -> stringResource(R.string.home_dock_creating_bot)
        StartProgress.Avatar -> stringResource(R.string.home_dock_bot_avatar_progress)
        is StartProgress.Opening -> stringResource(if (step.bot) R.string.home_dock_opening_bot else R.string.home_dock_opening)
    }
    Row(
        modifier = modifier
            .testTag(HomeDockTags.PROGRESS)
            .fillMaxWidth()
            .height(HomeDockSpec.progressRowHeight)
            .padding(horizontal = HomeDockSpec.progressPaddingHorizontal),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HomeDockSpec.progressGap),
    ) {
        StatusDot(colors.status.connecting, pulsing = true, size = 6.dp)
        Text(
            text,
            style = HomeDockSpec.progressText,
            color = colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false).testTag(HomeDockTags.PROGRESS_TEXT),
        )
        if (showHint) {
            Spacer(Modifier.weight(1f))
            Text(
                stringResource(R.string.home_dock_interrupt_hint),
                style = HomeDockSpec.progressText,
                color = lerp(colors.textSecondary, colors.text, refusal),
                maxLines = 1,
                modifier = Modifier.testTag(HomeDockTags.PROGRESS_HINT),
            )
        }
    }
}
