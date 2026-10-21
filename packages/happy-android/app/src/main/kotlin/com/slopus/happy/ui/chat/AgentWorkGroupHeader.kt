package com.slopus.happy.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.AgentWorkGroup
import com.slopus.happy.chat.WorkHeaderPlacement
import com.slopus.happy.chat.formatWorkDuration
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object AgentWorkGroupHeaderTags {
    const val HEADER = "workGroup.header"
    const val LABEL = "workGroup.label"
    const val CHEVRON = "workGroup.chevron"
}

/** AgentWorkGroupHeader.tsx. */
object AgentWorkGroupHeaderSpec {
    val marginVertical = 8.dp
    val marginHorizontal = 16.dp
    val minHeight = 28.dp
    val paddingVertical = 4.dp
    val gap = 6.dp
    val radius = 4.dp
    val text = happyTextStyle(fontSize = 13, lineHeight = 20)
    val chevron = 13.dp
    const val PRESSED_OPACITY = 0.6f
}

/**
 * AgentWorkGroupHeader: the one-line toggle for a finished turn's work. It
 * never grows; the group's rows are list items inserted beside it. Spec:
 * centred in the chat's max width, 8 above and below; the row 16 in, at
 * least 28 high, 4 above and below, radius 4, 0.6 while pressed; "Worked
 * {duration}" (or "Hide" for the [WorkHeaderPlacement.Trailing] copy under
 * an open group) 13/20 secondary, one line, then 6 on a 13 chevron in
 * textSecondary: forward while folded, up while open and on "Hide". Both
 * copies are exactly as tall, so collapsing from the trailing one puts the
 * reader back where they tapped.
 */
@Composable
fun AgentWorkGroupHeader(
    group: AgentWorkGroup,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    placement: WorkHeaderPlacement = WorkHeaderPlacement.Leading,
) {
    val colors = HappyTheme.colors
    val trailing = placement == WorkHeaderPlacement.Trailing
    val duration = (group.completedAt ?: group.startedAt) - group.startedAt
    val label = if (trailing) stringResource(R.string.tool_group_hide) else stringResource(R.string.tool_group_worked_for, formatWorkDuration(duration))
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Row(
        modifier = modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .padding(vertical = AgentWorkGroupHeaderSpec.marginVertical, horizontal = AgentWorkGroupHeaderSpec.marginHorizontal)
            .testTag(AgentWorkGroupHeaderTags.HEADER)
            .fillMaxWidth()
            .defaultMinSize(minHeight = AgentWorkGroupHeaderSpec.minHeight)
            .alpha(if (pressed) AgentWorkGroupHeaderSpec.PRESSED_OPACITY else 1f)
            .clip(RoundedCornerShape(AgentWorkGroupHeaderSpec.radius))
            .clickable(interaction, indication = null, role = Role.Button, onClick = onToggle)
            // TalkBack says whether the turn is folded, and offers the other way.
            .semantics { if (trailing || expanded) collapse { onToggle(); true } else expand { onToggle(); true } }
            .padding(vertical = AgentWorkGroupHeaderSpec.paddingVertical),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(AgentWorkGroupHeaderSpec.gap),
    ) {
        Text(
            label,
            style = AgentWorkGroupHeaderSpec.text,
            color = colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false).testTag(AgentWorkGroupHeaderTags.LABEL),
        )
        Icon(
            if (trailing || expanded) Ionicon.ChevronUp else Ionicon.ChevronForward,
            AgentWorkGroupHeaderSpec.chevron,
            colors.textSecondary,
            Modifier.testTag(AgentWorkGroupHeaderTags.CHEVRON),
        )
    }
}
