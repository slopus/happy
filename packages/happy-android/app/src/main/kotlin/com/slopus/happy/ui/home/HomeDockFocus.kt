package com.slopus.happy.ui.home

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
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
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max
import androidx.compose.ui.unit.min
import com.slopus.happy.R
import com.slopus.happy.model.AgentType
import com.slopus.happy.model.NewSessionLabels
import com.slopus.happy.model.NewSessionOptions
import com.slopus.happy.model.NewSessionPage
import com.slopus.happy.model.StartButton
import com.slopus.happy.model.resolveStartButton
import com.slopus.happy.model.resolveStartProgress
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.PickerSheetOption
import com.slopus.happy.ui.components.PickerSheetPanel
import com.slopus.happy.ui.components.PickerSheetSection
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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
 * while Stop is offered. Opening (openFocusMode, a frame after mounting,
 * 340 ms ease-out cubic): the backdrop fades in over the first 35%; the
 * composer's shell grows from the resting dock's 56 to its height with the
 * composer anchored to its bottom, from 0.96 wide and 0.72 opaque (opaque
 * by 12%); the input and attachments rise 8 into place over 22-60%, the
 * action row 7 over 46-82%, and the rows one after another. Closing runs
 * it back in 180 ms ease-in cubic (closeFocusMode) before the dock returns.
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
    LaunchedEffect(Unit) {
        delay(HomeDockSpec.FOCUS_OPEN_DELAY_MS)
        progress.animateTo(1f, tween(HomeDockSpec.FOCUS_OPEN_MS, easing = HomeDockSpec.focusOpenEasing))
    }
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
    val focusManager = LocalFocusManager.current
    // The standalone screen leaves with its navigation transition.
    val close: () -> Unit = {
        if (standalone) {
            actions.onFocusChange(false)
        } else {
            focusManager.clearFocus()
            scope.launch {
                progress.animateTo(0f, tween(HomeDockSpec.FOCUS_CLOSE_MS, easing = HomeDockSpec.focusCloseEasing))
                actions.onFocusChange(false)
            }
        }
    }
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
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = backdropPress)
                // Nothing to read: TalkBack closes focus mode with Back.
                .semantics { hideFromAccessibility() },
        )
        // Session | Bot at the top of the screen, revealed first (HomeDock.tsx focusHeader).
        if (state.bot != null && !standalone) {
            BotKindHeader(
                state.creatingBot,
                onChange = { bot -> if (starting) refuse() else actions.onBotKindChange(bot) },
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .windowInsetsPadding(WindowInsets.statusBars)
                    .padding(top = 8.dp, start = HomeDockSpec.configPaddingHorizontal, end = HomeDockSpec.configPaddingHorizontal)
                    .graphicsLayer { alpha = reveal(progress.value, 0.18f, 0.46f) },
            )
        }
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)),
        ) {
            if (state.bot != null && standalone) {
                BotKindHeader(
                    state.creatingBot,
                    onChange = { bot -> if (starting) refuse() else actions.onBotKindChange(bot) },
                    modifier = Modifier.padding(horizontal = HomeDockSpec.configPaddingHorizontal).padding(bottom = HomeDockSpec.configPaddingBottom),
                )
            }
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
                    Column {
                        EnvironmentRows(
                            options,
                            progress.value,
                            botOnly = state.creatingBot,
                            // Only the standalone screen says so; the dock refuses at Send, as HomeDock.tsx does.
                            offline = standalone && options.agentMachineOffline,
                            onOpen = open,
                            onHelp = { if (starting) refuse() else actions.onHarnessHelp() },
                        )
                        // A bot lives on a computer and nowhere else: the faces take the place of the other rows.
                        val bot = state.bot
                        if (bot != null && bot.creating) {
                            BotFacePicker(
                                bot,
                                onPick = { if (starting) refuse() else actions.onBotFacePick(it) },
                                onRoll = { if (starting) refuse() else actions.onBotFacesRoll() },
                                onOpenUrl = actions.onOpenUrl,
                                modifier = Modifier.graphicsLayer { alpha = reveal(progress.value, 0.18f + 0.09f, 0.18f + 0.09f + 0.28f) },
                            )
                        }
                    }
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
                resolveStartProgress(state.phase, agentName, options?.picksWorkspaces == true, state.creatingBot)?.let { step ->
                    ProgressLine(step, showHint = button == StartButton.Stop, refusal.value, Modifier.offset(y = -HomeDockSpec.progressRowHeight))
                }
            }
        }
    }
}

/**
 * The machine, place, checkout and harness rows. When [offline], the help
 * new/index.tsx shows follows the machine row and the rows under it fade to
 * 0.4 and take no presses: only another machine helps.
 */
@Composable
private fun EnvironmentRows(
    options: NewSessionOptions,
    progress: Float,
    botOnly: Boolean,
    offline: Boolean,
    onOpen: (NewSessionPage) -> Unit,
    onHelp: () -> Unit,
) {
    val rows = buildList {
        add(Triple(NewSessionPage.Machine, Ionicon.DesktopOutline, options.machine?.name ?: stringResource(R.string.home_dock_select_machine)))
        if (botOnly) return@buildList
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
            val blocked = offline && index > 0
            Row(
                modifier = Modifier
                    .testTag(HomeDockTags.row(page))
                    .fillMaxWidth()
                    .graphicsLayer {
                        alpha = shown * (if (blocked) HomeDockSpec.OFFLINE_ROWS_ALPHA else 1f)
                        translationY = 10.dp.toPx() * (1 - shown)
                    }
                    .defaultMinSize(minHeight = HomeDockSpec.rowMinHeight)
                    .clip(RoundedCornerShape(HomeDockSpec.rowRadius))
                    .clickable(enabled = !blocked, role = Role.Button) { if (help) onHelp() else onOpen(page) }
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
            if (offline && index == 0) OfflineHelp(rig = options.resolvedAgent == AgentType.Rig, alpha = shown)
        }
    }
}

/** new/index.tsx's offline help: what to try on the computer, then "switch machines". */
@Composable
private fun OfflineHelp(rig: Boolean, alpha: Float) {
    val colors = HappyTheme.colors
    val help = stringResource(if (rig) R.string.home_dock_happy_agent_offline else R.string.machine_offline_help)
    Row(
        modifier = Modifier
            .testTag(HomeDockTags.OFFLINE_HELP)
            .fillMaxWidth()
            .graphicsLayer { this.alpha = alpha }
            .semantics(mergeDescendants = true) {}
            .padding(horizontal = HomeDockSpec.offlinePaddingHorizontal, vertical = HomeDockSpec.offlinePaddingVertical),
        horizontalArrangement = Arrangement.spacedBy(HomeDockSpec.offlineGap),
    ) {
        Icon(Ionicon.CloudOfflineOutline, HomeDockSpec.offlineIcon, colors.status.disconnected)
        Column(Modifier.weight(1f)) {
            Text(
                stringResource(R.string.new_session_machine_offline),
                style = HomeDockSpec.offlineTitle,
                color = colors.status.disconnected,
                modifier = Modifier.padding(bottom = HomeDockSpec.offlineTitleGap),
            )
            Text(help + "\n" + stringResource(R.string.new_session_switch_machines_hint), style = HomeDockSpec.offlineText, color = colors.textSecondary)
        }
    }
}

@Composable
internal fun pageTitle(page: NewSessionPage, picksWorkspaces: Boolean): String = stringResource(
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
