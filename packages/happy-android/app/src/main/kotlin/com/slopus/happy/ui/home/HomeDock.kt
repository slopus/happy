package com.slopus.happy.ui.home

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.EaseOutCubic
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max
import androidx.compose.ui.unit.min
import com.slopus.happy.R
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.model.AgentType
import com.slopus.happy.model.NewSessionLabels
import com.slopus.happy.model.NewSessionOptions
import com.slopus.happy.model.NewSessionPage
import com.slopus.happy.model.StartButton
import com.slopus.happy.model.StartPhase
import com.slopus.happy.model.StartProgress
import com.slopus.happy.model.resolveStartButton
import com.slopus.happy.model.resolveStartProgress
import com.slopus.happy.ui.attachments.AttachmentStrip
import com.slopus.happy.ui.attachments.AttachmentStripSpec
import com.slopus.happy.ui.chat.ChatTheme
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Octicon
import com.slopus.happy.ui.components.PickerSheetOption
import com.slopus.happy.ui.components.PickerSheetPanel
import com.slopus.happy.ui.components.PickerSheetSection
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.theme.HappyColors
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.launch

object HomeDockTags {
    const val DOCK = "homeDock"
    const val SCRIM = "homeDock.scrim"
    const val CAPSULE = "homeDock.capsule"
    const val CAPSULE_TEXT = "homeDock.capsule.text"
    const val CAPSULE_SEND = "homeDock.capsule.send"
    const val FOCUS = "homeDock.focus"
    const val BACKDROP = "homeDock.backdrop"
    const val ROWS = "homeDock.rows"
    fun row(page: NewSessionPage) = "homeDock.row.${page.name}"
    const val COMPOSER = "homeDock.composer"
    const val INPUT = "homeDock.input"
    const val ACTION_ROW = "homeDock.actionRow"
    const val PERMISSION = "homeDock.permission"
    const val MODEL = "homeDock.model"
    const val EFFORT = "homeDock.effort"
    const val PRIMARY = "homeDock.primary"
    const val ADD_IMAGE = "homeDock.addImage"
    const val PROGRESS = "homeDock.progress"
    const val PROGRESS_TEXT = "homeDock.progress.text"
    const val PROGRESS_HINT = "homeDock.progress.hint"
}

/** HomeDock.tsx and agentInputLayout.ts on an Android phone. */
object HomeDockSpec {
    /** MOBILE_HOME_DOCK_CONTENT_INSET: what the list leaves free under its last row for the dock. */
    val contentInset = 108.dp
    val paddingHorizontal = 16.dp
    val paddingTop = 8.dp
    val minPaddingBottom = 10.dp

    // The resting capsule (resolveMobileCollapsedComposerGeometry).
    val shellHeight = 56.dp
    val shellRadius = 28.dp
    val contentPadding = 7.dp
    val contentGap = 4.dp
    /** Puts the text at the tangent where the capsule's round end meets its straight edge. */
    val inputPaddingStart = 21.dp
    val inputPaddingEnd = 4.dp
    val text = happyTextStyle(fontSize = 17)

    val sendSize = 42.dp
    val sendIcon = 16.dp

    // The focused dock.
    val configPaddingHorizontal = 24.dp
    val progressRowHeight = 18.dp
    /** The rows hold the status line's gap open whether or not it is filled. */
    val configPaddingBottom = progressRowHeight + 4.dp
    val rowGap = 1.dp
    val rowMinHeight = 42.dp
    val rowPaddingHorizontal = 6.dp
    val rowRadius = 12.dp
    val rowContentGap = 12.dp
    val rowIconBox = 24.dp
    val rowIcon = 21.dp
    val composerAreaPaddingHorizontal = 16.dp
    val composerAreaPaddingBottom = 8.dp
    val progressPaddingHorizontal = 16.dp
    val progressGap = 6.dp
    val progressText = happyTextStyle(fontSize = 11)

    // MOBILE_COMPOSER_METRICS.
    val composerRadius = 30.dp
    val composerInset = 10.dp
    val composerPaddingVertical = 8.dp
    val inputMinHeight = 44.dp
    val inputMaxHeight = 120.dp
    val inputPaddingHorizontal = 8.dp
    val inputPaddingVertical = 4.dp
    val input = happyTextStyle(fontSize = 16, lineHeight = 22)
    val actionRowHeight = 42.dp
    val actionRowGap = 2.dp
    val primaryMarginStart = 8.dp
    val chipHeight = 40.dp
    val effortMinWidth = 64.dp
    /** The add-image button (MOBILE_ICON_ACTION_GEOMETRY): a 42 circle around a 26 add glyph. */
    val addSize = 42.dp
    val addIcon = 26.dp
    val chip = happyTextStyle(fontSize = 14)

    // The Android picker panel's share of the window with the keyboard down.
    const val SHEET_HEIGHT_FRACTION = 0.5f
    val sheetMinHeight = 168.dp
    /** The composer and what sits around it, which the panel must leave room for. */
    val sheetReservedHeight = 320.dp
}

/** What the dock shows. [prompt] is the dock's own text; the draft takes it at Send. */
@Immutable
class HomeDockState(
    val prompt: String,
    val options: NewSessionOptions?,
    val labels: NewSessionLabels,
    val phase: StartPhase?,
    val focused: Boolean,
    /** The scrim behind the resting capsule, only over a list. */
    val showScrim: Boolean = true,
    val canCancel: Boolean = true,
    /** The images going with the first message. */
    val images: List<AttachmentPreview> = emptyList(),
    /** False while making a bot: a bot takes no first message, so no images either. */
    val canAttachImages: Boolean = true,
)

@Immutable
class HomeDockActions(
    val onPromptChange: (String) -> Unit,
    val onFocusChange: (Boolean) -> Unit,
    /** Send. The dock stays open until the session exists; the caller closes it. */
    val onSubmit: () -> Unit,
    /** Stop: hands the composer back at once. */
    val onCancel: () -> Unit,
    val onSelect: (NewSessionPage, String) -> Unit,
    /** A picker is opening (the worktree one lists git worktrees again). */
    val onOpenPicker: (NewSessionPage) -> Unit,
    val onHarnessHelp: () -> Unit,
    /** The add-image chooser (paste or pick). */
    val onAddImage: () -> Unit = {},
    val onRemoveImage: (id: String) -> Unit = {},
)

private val HomeDockState.attachedImages get() = if (canAttachImages) images else emptyList()

private fun HomeDockState.canSubmit() = phase == null && (prompt.isNotBlank() || attachedImages.isNotEmpty())

private fun sendBackground(colors: HappyColors) = if (colors.dark) Color(0xFFF5F5F5) else colors.button.primaryBackground

private fun sendIconColor(colors: HappyColors) = if (colors.dark) Color(0xFF111111) else colors.button.primaryTint

/** How far along [progress] a piece of the reveal is, between [start] and [end]. */
private fun reveal(progress: Float, start: Float, end: Float) = ((progress - start) / (end - start)).coerceIn(0f, 1f)

/**
 * The resting home dock, over the bottom of the list. Spec: 16 either
 * side, 8 above, max(10, nav bar) below. A 56 high capsule (radius 28,
 * input.background, hairline glass border, a soft shadow), 7 in at both
 * ends: the 17pt text 21 from the shell edge ("Plan, ask, build…" in
 * textSecondary until something is typed), tapping it opens the
 * composer; then, 4 on, the 42 round send button, surfaceHighest until
 * there is text, then primary (#F5F5F5 in dark), an arrow-up 16 in its
 * tint (textSecondary when idle), a spinner while a session is starting.
 * Over a list, a scrim fades in from the capsule's midpoint down.
 */
@Composable
fun HomeDock(state: HomeDockState, actions: HomeDockActions, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    Box(modifier = modifier.testTag(HomeDockTags.DOCK).fillMaxWidth()) {
        if (state.showScrim) {
            Box(
                modifier = Modifier
                    .testTag(HomeDockTags.SCRIM)
                    .matchParentSize()
                    // Clear down to the capsule's midpoint, then feathering over what scrolls beneath.
                    .padding(top = HomeDockSpec.paddingTop + HomeDockSpec.shellHeight / 2)
                    .background(Brush.verticalGradient(listOf(colors.grouped.background.copy(alpha = 0f), colors.grouped.background))),
            )
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = HomeDockSpec.paddingHorizontal)
                .padding(top = HomeDockSpec.paddingTop, bottom = max(HomeDockSpec.minPaddingBottom, navBottom)),
        ) {
            val shape = RoundedCornerShape(HomeDockSpec.shellRadius)
            val canSubmit = state.canSubmit()
            Row(
                modifier = Modifier
                    .testTag(HomeDockTags.CAPSULE)
                    .fillMaxWidth()
                    .height(HomeDockSpec.shellHeight)
                    .shadow(if (colors.dark) 4.dp else 2.dp, shape)
                    .clip(shape)
                    .background(colors.input.background)
                    .border(hairline(), ChatTheme.colors.glassBorder, shape)
                    .padding(horizontal = HomeDockSpec.contentPadding),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(HomeDockSpec.contentGap),
            ) {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .clickable(interactionSource = null, indication = null) { actions.onFocusChange(true) }
                        .padding(start = HomeDockSpec.inputPaddingStart, end = HomeDockSpec.inputPaddingEnd),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    Text(
                        state.prompt.ifEmpty { stringResource(R.string.home_dock_placeholder) },
                        style = HomeDockSpec.text,
                        color = if (state.prompt.isEmpty()) colors.textSecondary else colors.text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.testTag(HomeDockTags.CAPSULE_TEXT),
                    )
                }
                val send = stringResource(R.string.home_dock_send)
                Box(
                    modifier = Modifier
                        .testTag(HomeDockTags.CAPSULE_SEND)
                        .size(HomeDockSpec.sendSize)
                        .clip(CircleShape)
                        .background(if (canSubmit) sendBackground(colors) else colors.surfaceHighest)
                        .clickable(enabled = canSubmit, role = Role.Button, onClick = actions.onSubmit)
                        .semantics { contentDescription = send },
                    contentAlignment = Alignment.Center,
                ) {
                    if (state.phase != null) {
                        CircularProgressIndicator(Modifier.size(20.dp), color = colors.textSecondary, strokeWidth = 2.dp)
                    } else {
                        Icon(Ionicon.ArrowUp, HomeDockSpec.sendIcon, if (canSubmit) sendIconColor(colors) else colors.textSecondary)
                    }
                }
            }
        }
    }
}

/**
 * The focused dock, over the whole screen (HomeDock.tsx focus mode,
 * Android branch). Spec: the screen dims to 88% (black in dark, white in
 * light); a tap there closes the composer, or the open picker first, and
 * while a session is starting is refused (a haptic, and the hint and Stop
 * flash) — Back reads the same way. At the bottom, over the keyboard:
 * the rows, 24 either side, 22 above the composer area, 1 apart — MACHINE,
 * PROJECT, WORKTREE (WORKSPACE for a Happy Agent project) and HARNESS
 * ("Help" with no harness on the computer), each at least 42 high, 6 in,
 * radius 12, a 21 glyph centred in a 24 box 12 before the 17pt value.
 * A row or a chip opens its picker in place of the rows: the panel is
 * max(168, min(half the window, the window less the status bar, 320 and
 * the keyboard)) high. Then the composer, 16 either side and 8 over the
 * nav bar or keyboard: radius 30, input.background, hairline glass
 * border, 10 in, 8 above and below; the attached images' strip over the
 * input (AgentInputAttachmentStrip); the input box at least 44, 8/4 in,
 * text 16/22 up to 120 ("Ask Claude Code", "Ask Codex", "Ask {name}");
 * the 42 action row: the 42 round add-image button (add 26), 2 on the
 * permission word (40 high, 4/8 in, 14pt), then
 * pushed right the model (12/4 in, the one that gives way) · effort (at
 * least 64, 4/6 in); 10 on, the 42 primary button: Send, Stop (Octicons
 * stop) or a spinner, filled for Send and Stop. While starting, an 18
 * high line sits in the gap above the composer: a 6 pulsing connecting
 * dot, 6 on the step in 11pt, and "To interrupt press stop" at the end
 * while Stop is offered. Rows reveal one after another as it opens.
 * [standalone] is the new-session screen: nothing is dimmed, and only
 * Back leaves.
 */
@Composable
fun HomeDockFocus(state: HomeDockState, actions: HomeDockActions, modifier: Modifier = Modifier, standalone: Boolean = false) {
    val colors = HappyTheme.colors
    val options = state.options
    val starting = state.phase != null
    // An open picker comes back with a recreated activity, as the composer's do.
    var page by rememberSaveable { mutableStateOf<NewSessionPage?>(null) }
    val progress = remember { Animatable(0f) }
    LaunchedEffect(Unit) { progress.animateTo(1f, tween(340, easing = EaseOutCubic)) }
    val refusal = remember { Animatable(0f) }
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val refuse: () -> Unit = {
        haptics.performHapticFeedback(HapticFeedbackType.Reject)
        scope.launch {
            refusal.snapTo(0f)
            refusal.animateTo(1f, tween(90))
            refusal.animateTo(0f, tween(130))
            refusal.animateTo(1f, tween(90))
            refusal.animateTo(0f, tween(340))
        }
    }
    val close = { actions.onFocusChange(false) }
    // resolveHomeDockPickerBackAction / resolveHomeDockBackdropPressAction (Android draws no native menus).
    val back = {
        when {
            starting -> refuse()
            page != null -> page = null
            else -> close()
        }
    }
    val backdropPress = {
        when {
            starting -> refuse()
            page != null -> page = null
            !standalone -> close()
        }
    }
    val open = { next: NewSessionPage ->
        if (starting) {
            refuse()
        } else {
            actions.onOpenPicker(next)
            page = next
        }
    }
    BackHandler(onBack = back)

    BoxWithConstraints(modifier = modifier.fillMaxSize().testTag(HomeDockTags.FOCUS)) {
        val windowHeight = maxHeight
        val density = LocalDensity.current
        Box(
            modifier = Modifier
                .testTag(HomeDockTags.BACKDROP)
                .fillMaxSize()
                .graphicsLayer { alpha = reveal(progress.value, 0f, 0.35f) }
                .then(
                    if (standalone) {
                        Modifier
                    } else {
                        Modifier.background(if (colors.dark) Color.Black.copy(alpha = 0.88f) else Color.White.copy(alpha = 0.88f))
                    },
                )
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = backdropPress),
        )
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = HomeDockSpec.configPaddingHorizontal)
                    .padding(bottom = HomeDockSpec.configPaddingBottom),
                contentAlignment = Alignment.BottomCenter,
            ) {
                val current = page
                if (current != null && options != null) {
                    val statusTop = with(density) { WindowInsets.statusBars.getTop(this).toDp() }
                    val ime = with(density) { WindowInsets.ime.getBottom(this).toDp() }
                    val sheetMax = max(
                        HomeDockSpec.sheetMinHeight,
                        min(windowHeight * HomeDockSpec.SHEET_HEIGHT_FRACTION, windowHeight - statusTop - HomeDockSpec.sheetReservedHeight - ime),
                    )
                    PickerPanel(current, options, state.labels, { page = null }, actions, Modifier.heightIn(max = sheetMax))
                    // The sheet is one surface, so its refusal is the whole sheet.
                    if (starting) Box(Modifier.matchParentSize().clickable(interactionSource = null, indication = null, onClick = refuse))
                } else if (options != null) {
                    EnvironmentRows(options, progress.value, onOpen = open, onHelp = { if (starting) refuse() else actions.onHarnessHelp() })
                }
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = HomeDockSpec.composerAreaPaddingHorizontal)
                    .padding(bottom = HomeDockSpec.composerAreaPaddingBottom),
            ) {
                val button = resolveStartButton(state.canSubmit(), state.phase, state.canCancel)
                FocusedComposer(state, actions, button, progress.value, refusal.value, refuse, open, onStop = {
                    actions.onCancel()
                    close()
                })
                val agentName = options?.agent?.name ?: AgentType.Claude.displayName
                resolveStartProgress(state.phase, agentName, options?.picksWorkspaces == true)?.let { step ->
                    ProgressLine(step, showHint = button == StartButton.Stop, refusal.value, Modifier.offset(y = -HomeDockSpec.progressRowHeight))
                }
            }
        }
    }
}

@Composable
private fun EnvironmentRows(options: NewSessionOptions, progress: Float, onOpen: (NewSessionPage) -> Unit, onHelp: () -> Unit) {
    val rows = buildList {
        add(Triple(NewSessionPage.Machine, Ionicon.DesktopOutline, options.machine?.name ?: stringResource(R.string.home_dock_select_machine)))
        add(Triple(NewSessionPage.Project, Ionicon.FolderOutline, options.project?.name ?: "~"))
        val worktreeFallback = stringResource(if (options.picksWorkspaces) R.string.home_dock_main else R.string.home_dock_no_worktree)
        add(Triple(NewSessionPage.Worktree, Ionicon.GitBranchOutline, options.worktree?.name ?: worktreeFallback))
        add(
            if (options.hasHarness) {
                Triple(NewSessionPage.Agent, Ionicon.HardwareChipOutline, options.agent.name)
            } else {
                Triple(NewSessionPage.Agent, Ionicon.HelpCircleOutline, stringResource(R.string.home_dock_harness_help))
            },
        )
    }
    val labels = mapOf(
        NewSessionPage.Machine to stringResource(R.string.home_dock_row_machine),
        NewSessionPage.Project to stringResource(R.string.home_dock_row_project),
        NewSessionPage.Worktree to stringResource(if (options.picksWorkspaces) R.string.home_dock_row_workspace else R.string.home_dock_row_worktree),
        NewSessionPage.Agent to stringResource(R.string.home_dock_row_harness),
    )
    val helpLabel = stringResource(R.string.home_dock_harness_help_label)
    val colors = HappyTheme.colors
    Column(modifier = Modifier.testTag(HomeDockTags.ROWS).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(HomeDockSpec.rowGap)) {
        rows.forEachIndexed { index, (page, icon, value) ->
            val start = 0.18f + index * 0.09f
            val shown = reveal(progress, start, start + 0.28f)
            val help = page == NewSessionPage.Agent && !options.hasHarness
            val description = if (help) helpLabel else "${labels.getValue(page)}: $value"
            Row(
                modifier = Modifier
                    .testTag(HomeDockTags.row(page))
                    .fillMaxWidth()
                    .graphicsLayer {
                        alpha = shown
                        translationY = 10.dp.toPx() * (1 - shown)
                    }
                    .defaultMinSize(minHeight = HomeDockSpec.rowMinHeight)
                    .clip(RoundedCornerShape(HomeDockSpec.rowRadius))
                    .clickable(role = Role.Button) { if (help) onHelp() else onOpen(page) }
                    .semantics { contentDescription = description }
                    .padding(horizontal = HomeDockSpec.rowPaddingHorizontal),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(HomeDockSpec.rowContentGap),
            ) {
                Box(Modifier.size(HomeDockSpec.rowIconBox), contentAlignment = Alignment.Center) {
                    Icon(icon, HomeDockSpec.rowIcon, colors.text)
                }
                Text(value, style = HomeDockSpec.text, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun pageTitle(page: NewSessionPage, picksWorkspaces: Boolean): String = stringResource(
    when (page) {
        NewSessionPage.Machine -> R.string.home_dock_picker_machine
        NewSessionPage.Project -> R.string.home_dock_picker_project
        NewSessionPage.Worktree -> if (picksWorkspaces) R.string.home_dock_picker_workspace else R.string.home_dock_picker_worktree
        NewSessionPage.Agent -> R.string.home_dock_picker_harness
        NewSessionPage.Model -> R.string.agent_input_model_title
        NewSessionPage.Permission -> R.string.agent_input_permission_mode_title
        NewSessionPage.Effort -> R.string.agent_input_effort_title
    },
)

/** The Android picker, drawn in place of the rows so the composer keeps its keyboard. */
@Composable
private fun PickerPanel(
    page: NewSessionPage,
    options: NewSessionOptions,
    labels: NewSessionLabels,
    onClose: () -> Unit,
    actions: HomeDockActions,
    modifier: Modifier,
) {
    val titles = NewSessionPage.entries.associateWith { pageTitle(it, options.picksWorkspaces) }
    val title = titles.getValue(page)
    val (sections, selectedKey) = remember(options, page, labels, titles) { options.sections(page, labels, titles::getValue) }
    PickerSheetPanel(title = title, onClose = onClose, modifier = modifier) {
        sections.forEachIndexed { index, section ->
            // The panel already names the choice, so a group named the same is left bare.
            PickerSheetSection(section.key, section.title?.takeIf { it != title }, separated = index > 0)
            for (option in section.options) {
                PickerSheetOption(
                    key = option.key,
                    label = option.name,
                    // A second line that only repeats its group's heading says nothing new.
                    description = option.description?.takeIf { it != section.title },
                    selected = !option.action && option.key == selectedKey,
                    disabled = option.disabled,
                    action = option.action,
                    onClick = {
                        actions.onSelect(page, option.key)
                        onClose()
                    },
                )
            }
        }
    }
}

@Composable
private fun FocusedComposer(
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
            val placeholder = stringResource(R.string.home_dock_ask, options?.agent?.name ?: AgentType.Claude.displayName)
            BasicTextField(
                value = state.prompt,
                // Locked while starting without taking the keyboard down: the change is refused.
                onValueChange = { if (state.phase != null) refuse() else actions.onPromptChange(it) },
                textStyle = HomeDockSpec.input.copy(color = colors.input.text),
                cursorBrush = SolidColor(colors.text),
                modifier = Modifier
                    .testTag(HomeDockTags.INPUT)
                    .fillMaxWidth()
                    .heightIn(max = HomeDockSpec.inputMaxHeight)
                    .focusRequester(focus),
                decorationBox = { field ->
                    Box {
                        if (state.prompt.isEmpty()) {
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
            if (state.canAttachImages) {
                AddImageButton(onClick = { if (state.phase != null) refuse() else actions.onAddImage() })
            }
            // Every chip lives in this one box; send is its sibling, so nothing inside reaches it.
            Row(
                modifier = Modifier.weight(1f).height(HomeDockSpec.actionRowHeight).clipToBounds(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(HomeDockSpec.actionRowGap),
            ) {
                val chip = { page: NewSessionPage -> { if (state.phase != null) refuse() else open(page) } }
                val permission = options?.permissionLabel
                if (permission != null) {
                    Chip(permission, HomeDockTags.PERMISSION, pageTitle(NewSessionPage.Permission, false), chip(NewSessionPage.Permission), start = 4.dp, end = 8.dp)
                }
                // Model and effort sit against the send button, the model giving way first.
                Row(
                    modifier = Modifier.weight(1f).padding(start = HomeDockSpec.actionRowGap),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(HomeDockSpec.actionRowGap, Alignment.End),
                ) {
                    if (options != null) {
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
                    val effort = options?.effort
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
            PrimaryButton(button, refusal, onClick = if (button == StartButton.Stop) onStop else actions.onSubmit)
        }
    }
}

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

@Composable
private fun PrimaryButton(button: StartButton, refusal: Float, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val filled = button == StartButton.Send || button == StartButton.Stop
    val label = stringResource(if (button == StartButton.Stop) R.string.home_dock_stop else R.string.home_dock_send)
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

@Composable
private fun ProgressLine(step: StartProgress, showHint: Boolean, refusal: Float, modifier: Modifier) {
    val colors = HappyTheme.colors
    val text = when (step) {
        is StartProgress.CreatingWorkspace -> stringResource(if (step.workspace) R.string.home_dock_creating_workspace else R.string.home_dock_creating_worktree)
        is StartProgress.Starting -> stringResource(R.string.home_dock_starting, step.agentName)
        StartProgress.Opening -> stringResource(R.string.home_dock_opening)
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
