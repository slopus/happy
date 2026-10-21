package com.slopus.happy.ui.home

import androidx.compose.animation.core.Easing
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max
import com.slopus.happy.R
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.model.NewSessionLabels
import com.slopus.happy.model.NewSessionOptions
import com.slopus.happy.model.NewSessionPage
import com.slopus.happy.model.StartPhase
import com.slopus.happy.model.isValidBotName
import com.slopus.happy.ui.chat.ChatTheme
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.theme.HappyColors
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlin.math.roundToInt

object HomeDockTags {
    const val DOCK = "homeDock"
    const val SCRIM = "homeDock.scrim"
    const val CAPSULE = "homeDock.capsule"
    const val CAPSULE_TEXT = "homeDock.capsule.text"
    const val CAPSULE_SEND = "homeDock.capsule.send"
    const val FOCUS = "homeDock.focus"
    const val BACKDROP = "homeDock.backdrop"
    const val ROWS = "homeDock.rows"
    const val OFFLINE_HELP = "homeDock.offlineHelp"
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

    /** openFocusMode starts focusPresentation one 16 ms timer after the composer mounts. */
    const val FOCUS_OPEN_DELAY_MS = 16L
    const val FOCUS_OPEN_MS = 340
    /** closeFocusMode. */
    const val FOCUS_CLOSE_MS = 180
    /** Easing.out(Easing.cubic), exactly; Compose's EaseOutCubic is a Bézier near it. */
    val focusOpenEasing = Easing { 1 - (1 - it) * (1 - it) * (1 - it) }
    /** Easing.in(Easing.cubic). */
    val focusCloseEasing = Easing { it * it * it }
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

    // new/index.tsx's offline help, under the machine row of the standalone screen.
    val offlinePaddingHorizontal = 12.dp
    val offlinePaddingVertical = 10.dp
    val offlineGap = 8.dp
    val offlineIcon = 14.dp
    val offlineTitle = happyTextStyle(fontSize = 13, weight = FontWeight.SemiBold)
    val offlineTitleGap = 4.dp
    val offlineText = happyTextStyle(fontSize = 12, lineHeight = 18)
    const val OFFLINE_ROWS_ALPHA = 0.4f
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
    /** Session | Bot, while the computer's Happy Agent makes bots; null otherwise. */
    val bot: HomeDockBot? = null,
) {
    val creatingBot: Boolean get() = bot?.creating == true
}

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
    /** Session | Bot: true makes a bot. */
    val onBotKindChange: (Boolean) -> Unit = {},
    val onBotNameChange: (String) -> Unit = {},
    val onBotFacePick: (Int) -> Unit = {},
    val onBotFacesRoll: () -> Unit = {},
    val onOpenUrl: (String) -> Unit = {},
)

internal val HomeDockState.attachedImages get() = if (canAttachImages && !creatingBot) images else emptyList()

/** A bot needs a name the daemon accepts; a session, text or a picture. */
internal fun HomeDockState.canSubmit() = phase == null &&
    if (creatingBot) isValidBotName(bot!!.name) else prompt.isNotBlank() || attachedImages.isNotEmpty()

internal fun sendBackground(colors: HappyColors) = if (colors.dark) Color(0xFFF5F5F5) else colors.button.primaryBackground

internal fun sendIconColor(colors: HappyColors) = if (colors.dark) Color(0xFF111111) else colors.button.primaryTint

/** focusedComposerAnimationStyle's height: the resting dock's [resting] at 0, the composer's [full] at 1. */
internal fun composerShellHeight(resting: Float, full: Int, progress: Float): Int =
    (resting + (full - resting) * progress.coerceIn(0f, 1f)).roundToInt()

/** How far along [progress] a piece of the reveal is, between [start] and [end]. */
internal fun reveal(progress: Float, start: Float, end: Float) = ((progress - start) / (end - start)).coerceIn(0f, 1f)

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
