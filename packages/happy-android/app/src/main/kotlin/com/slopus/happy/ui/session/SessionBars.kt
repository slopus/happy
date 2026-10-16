package com.slopus.happy.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.AgentGoal
import com.slopus.happy.model.AgentGoalAction
import com.slopus.happy.model.PendingChat
import com.slopus.happy.model.RigActivityIndicator
import com.slopus.happy.model.offeredActions
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ShimmerText
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object SessionBarTags {
    const val GOAL = "session.goal"
    const val GOAL_TEXT = "session.goal.text"
    fun goalAction(action: AgentGoalAction) = "session.goal.${action.wire}"
    const val ACTIVITY = "session.activity"
    fun activity(key: String) = "session.activity.$key"
    const val PENDING = "session.pending"
    const val PENDING_TITLE = "session.pending.title"
    const val PENDING_DETAIL = "session.pending.detail"
}

/** AgentGoalBar.tsx, RigActivityBar.tsx and PendingChatPlaceholder.tsx. */
object SessionBarSpec {
    val goalRadius = 14.dp
    val goalPaddingHorizontal = 12.dp
    val goalPaddingVertical = 10.dp
    val goalMarginBottom = 8.dp
    val goalGap = 10.dp
    val goalIcon = 18.dp
    val goalLabel = happyTextStyle(fontSize = 12, lineHeight = 16, weight = FontWeight.SemiBold)
    val goalText = happyTextStyle(fontSize = 14, lineHeight = 19)
    val goalActionGap = 4.dp
    val goalAction = 30.dp
    val goalActionIcon = 16.dp
    const val PRESSED_OPACITY = 0.8f
    const val DISABLED_OPACITY = 0.6f

    val activityPaddingHorizontal = 16.dp
    val activityPaddingVertical = 5.dp
    val activityGap = 10.dp
    val activityIconGap = 4.dp
    val activityIcon = 12.dp
    val activityText = happyTextStyle(fontSize = 11)

    val pendingPaddingHorizontal = 48.dp
    val pendingIcon = 64.dp
    val pendingIconMarginBottom = 16.dp
    val pendingTitle = happyTextStyle(fontSize = 18, weight = FontWeight.SemiBold)
    val pendingQueued = happyTextStyle(fontSize = 15, lineHeight = 21)
    val pendingQueuedMarginTop = 10.dp
    val pendingPath = happyTextStyle(fontSize = 14)
    val pendingPathMarginTop = 6.dp
}

/**
 * AgentGoalBar: the agent's current goal over the composer. Spec: a row in
 * surfaceHigh with a 1 divider border, radius 14, padded 12/10 and 8 above
 * what follows, 0.8 while pressed (only when it opens something);
 * locate-outline 18 in textSecondary, 10 on the "Current goal" label (12/16
 * semibold secondary) over the goal (14/19, one line, ellipsized); then the
 * actions the agent offers, edit, stop, clear, 4 apart: 30 round buttons
 * with a 16 glyph in the secondary button tint (create-, pause-,
 * trash-outline), surfacePressed while pressed, a spinner at 0.6 while
 * that action runs.
 */
@Composable
fun AgentGoalBar(
    goal: AgentGoal,
    onAction: ((AgentGoalAction) -> Unit)?,
    inFlight: AgentGoalAction?,
    modifier: Modifier = Modifier,
    onPressDetails: (() -> Unit)? = null,
) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(SessionBarSpec.goalRadius)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val description = stringResource(R.string.components_agent_goal_bar_accessibility_label, goal.text)
    Row(
        modifier = modifier
            // One stop even without a press, as RN's Pressable is; the action buttons stay their own.
            .semantics(mergeDescendants = onPressDetails == null) { testTag = SessionBarTags.GOAL }
            .padding(bottom = SessionBarSpec.goalMarginBottom)
            .fillMaxWidth()
            .alpha(if (pressed && onPressDetails != null) SessionBarSpec.PRESSED_OPACITY else 1f)
            .clip(shape)
            .background(colors.surfaceHigh)
            .border(1.dp, colors.divider, shape)
            .then(if (onPressDetails != null) Modifier.clickable(interaction, indication = null, onClick = onPressDetails) else Modifier)
            .semantics { contentDescription = description }
            .padding(horizontal = SessionBarSpec.goalPaddingHorizontal, vertical = SessionBarSpec.goalPaddingVertical),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SessionBarSpec.goalGap),
    ) {
        Icon(Ionicon.LocateOutline, SessionBarSpec.goalIcon, colors.textSecondary)
        Column(Modifier.weight(1f)) {
            Text(
                stringResource(R.string.components_agent_goal_bar_current_goal),
                style = SessionBarSpec.goalLabel,
                color = colors.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                goal.text,
                style = SessionBarSpec.goalText,
                color = colors.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag(SessionBarTags.GOAL_TEXT),
            )
        }
        val actions = if (onAction != null) goal.offeredActions() else emptyList()
        if (actions.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(SessionBarSpec.goalActionGap), verticalAlignment = Alignment.CenterVertically) {
                actions.forEach { action -> GoalActionButton(action, running = inFlight == action) { onAction?.invoke(action) } }
            }
        }
    }
}

@Composable
private fun GoalActionButton(action: AgentGoalAction, running: Boolean, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val label = stringResource(
        when (action) {
            AgentGoalAction.Edit -> R.string.components_agent_goal_bar_edit_goal
            AgentGoalAction.Stop -> R.string.components_agent_goal_bar_stop_goal
            AgentGoalAction.Clear -> R.string.components_agent_goal_bar_clear_goal
        },
    )
    Box(
        modifier = Modifier
            .testTag(SessionBarTags.goalAction(action))
            .size(SessionBarSpec.goalAction)
            .alpha(if (running) SessionBarSpec.DISABLED_OPACITY else 1f)
            .clip(CircleShape)
            .background(if (pressed) colors.surfacePressed else Color.Transparent)
            .clickable(interaction, indication = null, enabled = !running, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        if (running) {
            CircularProgressIndicator(Modifier.size(SessionBarSpec.goalActionIcon), color = colors.textSecondary, strokeWidth = 2.dp)
        } else {
            val icon = when (action) {
                AgentGoalAction.Edit -> Ionicon.CreateOutline
                AgentGoalAction.Stop -> Ionicon.PauseOutline
                AgentGoalAction.Clear -> Ionicon.TrashOutline
            }
            Icon(icon, SessionBarSpec.goalActionIcon, colors.button.secondaryTint)
        }
    }
}

/**
 * RigActivityBar: what a Happy Agent session has running besides the
 * conversation. Spec: wrapping rows 10 apart, padded 16/5; each a 12 glyph
 * (people-, git-network-, terminal-, checkbox-outline) 4 before "{count}
 * agents" (or workflows, processes, tasks), "+{queued} queued" after the
 * count when some wait, 11pt secondary. Nothing when nothing runs.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RigActivityBar(indicators: List<RigActivityIndicator>, modifier: Modifier = Modifier) {
    if (indicators.isEmpty()) return
    val colors = HappyTheme.colors
    FlowRow(
        modifier = modifier
            .testTag(SessionBarTags.ACTIVITY)
            .fillMaxWidth()
            .padding(horizontal = SessionBarSpec.activityPaddingHorizontal, vertical = SessionBarSpec.activityPaddingVertical),
        horizontalArrangement = Arrangement.spacedBy(SessionBarSpec.activityGap),
        verticalArrangement = Arrangement.Center,
    ) {
        indicators.forEach { indicator ->
            val (icon, label) = when (indicator.key) {
                "subagents" -> Ionicon.PeopleOutline to "agents"
                "workflows" -> Ionicon.GitNetworkOutline to "workflows"
                "processes" -> Ionicon.TerminalOutline to "processes"
                else -> Ionicon.CheckboxOutline to "tasks"
            }
            val queued = indicator.queued?.takeIf { it != 0L }?.let { " +$it queued" }.orEmpty()
            Row(
                modifier = Modifier.testTag(SessionBarTags.activity(indicator.key)),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(SessionBarSpec.activityIconGap),
            ) {
                Icon(icon, SessionBarSpec.activityIcon, colors.textSecondary)
                Text("${indicator.count}$queued $label", style = SessionBarSpec.activityText, color = colors.textSecondary)
            }
        }
    }
}

/**
 * PendingChatPlaceholder: a chat no machine has agreed to run yet. Spec:
 * centred, 48 in: chatbubbles-outline 64 in textSecondary, 16 above
 * "Starting a new chat…" (18 semibold, shimmering from textSecondary to
 * text); under it the messages already sent (15/21 text, up to 6 lines,
 * 10 below), else the anchor's directory (14 secondary, one line, 6 below).
 */
@Composable
fun PendingChatPlaceholder(pending: PendingChat, anchorPath: String?, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Column(
        modifier = modifier
            .testTag(SessionBarTags.PENDING)
            .fillMaxSize()
            .padding(horizontal = SessionBarSpec.pendingPaddingHorizontal),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Ionicon.ChatbubblesOutline, SessionBarSpec.pendingIcon, colors.textSecondary, Modifier.padding(bottom = SessionBarSpec.pendingIconMarginBottom))
        ShimmerText(
            text = stringResource(R.string.session_starting_chat),
            style = SessionBarSpec.pendingTitle.copy(textAlign = TextAlign.Center),
            baseColor = colors.textSecondary,
            highlightColor = colors.text,
            modifier = Modifier.testTag(SessionBarTags.PENDING_TITLE),
        )
        when {
            pending.queued.isNotEmpty() -> Text(
                pending.queued.joinToString("\n\n"),
                style = SessionBarSpec.pendingQueued,
                color = colors.text,
                textAlign = TextAlign.Center,
                maxLines = 6,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = SessionBarSpec.pendingQueuedMarginTop).testTag(SessionBarTags.PENDING_DETAIL),
            )
            anchorPath != null -> Text(
                anchorPath,
                style = SessionBarSpec.pendingPath,
                color = colors.textSecondary,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = SessionBarSpec.pendingPathMarginTop).testTag(SessionBarTags.PENDING_DETAIL),
            )
        }
    }
}
