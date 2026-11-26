package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.slopus.happy.chat.BackgroundTask
import com.slopus.happy.chat.ContextUsage
import com.slopus.happy.chat.UsageLimits
import com.slopus.happy.usage.usageRowState
import com.slopus.happy.ui.usage.ComposerUsageRow
import com.slopus.happy.ui.usage.LocalUsageDisplay
import com.slopus.happy.ui.usage.UsageRowTags

/** The one row above the composer card, in the composer's own 8 inset. */
object ComposerInfoSpec {
    /** The 10 shell inset: the gauge's right edge is Send's, and the chip's left the card's. */
    val endInset = 10.dp
    val bottom = 8.dp
    val minHeight = 32.dp
}

/**
 * The row directly above the composer card: the background-task pill
 * ([BackgroundTaskChip]) at the start while there is any task, then the
 * context gauge and week figure ([ComposerUsageRow]) at the end, 10 in from
 * the card's edge (its shell inset) so the 14 ring ends on Send's right
 * edge. The row is at least 32 high, its chip's height, and 8 above the
 * card. It
 * holds the pill's sheet, closing it when the last task goes. Nothing at
 * all when there are neither tasks nor usage.
 */
@Composable
fun ComposerInfoRow(
    tasks: List<BackgroundTask>,
    usage: ContextUsage?,
    limits: UsageLimits?,
    sessionKey: Any?,
    modifier: Modifier = Modifier,
) {
    val display = LocalUsageDisplay.current
    val state = remember(usage, limits, display) {
        usageRowState(usage, limits, display.alwaysShowContextSize, display.showRemaining)
    }
    if (tasks.isEmpty() && state.isEmpty) return
    var tasksOpen by remember(sessionKey) { mutableStateOf(false) }
    Row(
        modifier = modifier
            .testTag(UsageRowTags.ROW)
            .fillMaxWidth()
            .defaultMinSize(minHeight = ComposerInfoSpec.minHeight)
            .padding(end = ComposerInfoSpec.endInset)
            .padding(bottom = ComposerInfoSpec.bottom),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (tasks.isNotEmpty()) BackgroundTaskChip(tasks, onClick = { tasksOpen = true })
        Spacer(Modifier.weight(1f))
        if (!state.isEmpty) ComposerUsageRow(state, usage)
    }
    // The last task going takes the sheet with it.
    if (tasksOpen && tasks.isNotEmpty()) BackgroundTaskSheet(tasks, onDismiss = { tasksOpen = false })
}
