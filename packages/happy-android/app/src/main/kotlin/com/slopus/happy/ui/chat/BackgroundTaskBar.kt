package com.slopus.happy.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.BackgroundTask
import com.slopus.happy.chat.BackgroundTaskStatus
import com.slopus.happy.chat.backgroundTasksForDisplay
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.call.SheetStatusIcons
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.TrackOverlay
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay

object BackgroundTaskTags {
    const val CHIP = "chat.tasks.chip"
    const val CHIP_LABEL = "chat.tasks.chip.label"
    const val SHEET = "chat.tasks.sheet"
    const val SHEET_TITLE = "chat.tasks.title"
    fun row(id: String) = "chat.tasks.row.$id"
    fun status(id: String) = "chat.tasks.row.$id.status"
    fun title(id: String) = "chat.tasks.row.$id.title"
    fun meta(id: String) = "chat.tasks.row.$id.meta"
    fun detail(id: String) = "chat.tasks.row.$id.detail"
}

/** The chip over the composer and the sheet it opens (this app's own; no happy-app counterpart). */
object BackgroundTaskSpec {
    val chipRadius = 14.dp
    val chipPaddingHorizontal = 12.dp
    val chipPaddingVertical = 8.dp
    val chipGap = 8.dp
    val chipIcon = 16.dp
    val chipChevron = 14.dp
    val chipText = happyTextStyle(fontSize = 12, lineHeight = 16, weight = FontWeight.SemiBold)
    val chipMarginBottom = 8.dp

    val sheetTitle = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold)
    val sheetTitlePadding = 24.dp
    val sheetTitleMarginBottom = 8.dp
    val rowPaddingHorizontal = 20.dp
    val rowPaddingVertical = 10.dp
    val rowGap = 12.dp
    val rowGlyphBox = 20.dp
    val rowGlyph = 18.dp
    val rowSpinner = 14.dp
    val rowTitle = happyTextStyle(fontSize = 14, lineHeight = 19, weight = FontWeight.Medium)
    val rowMeta = happyTextStyle(fontSize = 12, lineHeight = 16)
    val rowDetail = happyTextStyle(fontSize = 13, lineHeight = 18)
    val rowCommand = happyTextStyle(fontSize = 12, lineHeight = 17, family = FontFamily.Monospace)
    val rowGapTight = 2.dp
}

/**
 * The session's background tasks as one pill over the composer: what is
 * running ("2 running"), or what finished while nothing runs ("1 finished").
 * Spec: a row in surfaceHigh with a 1 divider border, radius 14, padded 12/8,
 * a 16 terminal glyph 8 before its 12/16 semibold label, then a 14 chevron; 8
 * above the composer. A tap opens [BackgroundTaskSheet].
 */
@Composable
fun BackgroundTaskChip(tasks: List<BackgroundTask>, onClick: () -> Unit, modifier: Modifier = Modifier) {
    if (tasks.isEmpty()) return
    val colors = HappyTheme.colors
    val running = tasks.count { it.isRunning }
    val label = if (running > 0) {
        pluralResource(R.plurals.chat_tasks_running, running, running)
    } else {
        pluralResource(R.plurals.chat_tasks_finished, tasks.size, tasks.size)
    }
    val shape = RoundedCornerShape(BackgroundTaskSpec.chipRadius)
    Row(
        modifier = modifier
            .testTag(BackgroundTaskTags.CHIP)
            .clip(shape)
            .background(colors.surfaceHigh)
            .border(1.dp, colors.divider, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = BackgroundTaskSpec.chipPaddingHorizontal, vertical = BackgroundTaskSpec.chipPaddingVertical),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(BackgroundTaskSpec.chipGap),
    ) {
        Icon(Ionicon.TerminalOutline, BackgroundTaskSpec.chipIcon, colors.textSecondary)
        Text(
            label,
            style = BackgroundTaskSpec.chipText,
            color = colors.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.testTag(BackgroundTaskTags.CHIP_LABEL),
        )
        Icon(Ionicon.ChevronUp, BackgroundTaskSpec.chipChevron, colors.textSecondary)
    }
}

/**
 * Every task the chat knows about, in [com.slopus.happy.chat.backgroundTasksForDisplay]'s
 * order, in a Material bottom sheet: a 17/22 semibold title, then one row per
 * task, 20/10 padded, a 20 glyph box (a 14 spinner while running, a
 * checkmark-circle in success, a close-circle in the error colour, a close in
 * secondary) 12 before its 14/19 medium title, then 12/16 secondary status and
 * how long ago ("Running · 3 minutes ago"), its notification summary in 13/18
 * secondary (two lines) and a background command in 12/17 monospace (one
 * line). Times refresh every 30 s while it is open.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BackgroundTaskSheet(tasks: List<BackgroundTask>, onDismiss: () -> Unit) {
    val colors = HappyTheme.colors
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val shown = remember(tasks) { backgroundTasksForDisplay(tasks) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(TASK_CLOCK_MS)
            now = System.currentTimeMillis()
        }
    }
    TrackOverlay(true, onDismiss)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheet,
        containerColor = colors.surface,
        modifier = Modifier.testTag(BackgroundTaskTags.SHEET),
    ) {
        SheetStatusIcons()
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 8.dp)) {
            Text(
                stringResource(R.string.chat_tasks_title),
                style = BackgroundTaskSpec.sheetTitle,
                color = colors.text,
                modifier = Modifier
                    .padding(horizontal = BackgroundTaskSpec.sheetTitlePadding)
                    .padding(bottom = BackgroundTaskSpec.sheetTitleMarginBottom)
                    .testTag(BackgroundTaskTags.SHEET_TITLE),
            )
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                shown.forEachIndexed { index, task ->
                    if (index > 0) HorizontalDivider(thickness = 0.5.dp, color = colors.divider)
                    BackgroundTaskRow(task, now)
                }
            }
        }
    }
}

@Composable
private fun BackgroundTaskRow(task: BackgroundTask, now: Long) {
    val colors = HappyTheme.colors
    val meta: String = metaLine(task, now)
    Row(
        modifier = Modifier
            .testTag(BackgroundTaskTags.row(task.id))
            .fillMaxWidth()
            .padding(horizontal = BackgroundTaskSpec.rowPaddingHorizontal, vertical = BackgroundTaskSpec.rowPaddingVertical),
        horizontalArrangement = Arrangement.spacedBy(BackgroundTaskSpec.rowGap),
    ) {
        BackgroundTaskGlyph(task, Modifier.padding(top = BackgroundTaskSpec.rowGapTight).testTag(BackgroundTaskTags.status(task.id)))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(BackgroundTaskSpec.rowGapTight)) {
            Text(
                text = task.title,
                color = colors.text,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                style = BackgroundTaskSpec.rowTitle,
                modifier = Modifier.testTag(BackgroundTaskTags.title(task.id)),
            )
            Text(
                text = meta,
                color = if (task.status == BackgroundTaskStatus.Failed) colors.warningCritical else colors.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = BackgroundTaskSpec.rowMeta,
                modifier = Modifier.testTag(BackgroundTaskTags.meta(task.id)),
            )
            val summary = task.summary?.takeIf { it.isNotBlank() }
            val detail = summary ?: task.command
            if (detail != null) {
                val command = summary == null
                Text(
                    text = detail,
                    color = colors.textSecondary,
                    maxLines = if (command) 1 else 2,
                    overflow = TextOverflow.Ellipsis,
                    style = if (command) BackgroundTaskSpec.rowCommand else BackgroundTaskSpec.rowDetail,
                    modifier = Modifier.testTag(BackgroundTaskTags.detail(task.id)),
                )
            }
        }
    }
}

@Composable
private fun BackgroundTaskGlyph(task: BackgroundTask, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Box(modifier.size(BackgroundTaskSpec.rowGlyphBox), contentAlignment = Alignment.Center) {
        when (task.status) {
            BackgroundTaskStatus.Running -> {
                CircularProgressIndicator(
                    modifier = Modifier.size(BackgroundTaskSpec.rowSpinner),
                    color = colors.textSecondary,
                    strokeWidth = 2.dp,
                )
            }
            BackgroundTaskStatus.Completed -> { Icon(Ionicon.CheckmarkCircle, BackgroundTaskSpec.rowGlyph, colors.success) }
            BackgroundTaskStatus.Failed -> { Icon(Ionicon.CloseCircle, BackgroundTaskSpec.rowGlyph, colors.warningCritical) }
            BackgroundTaskStatus.Cancelled -> { Icon(Ionicon.Close, BackgroundTaskSpec.rowGlyph, colors.textSecondary) }
        }
    }
}

/** "Running · 3 minutes ago" (or just the status when it never started here). */
@Composable
private fun metaLine(task: BackgroundTask, now: Long): String {
    val status = stringResource(
        when (task.status) {
            BackgroundTaskStatus.Running -> R.string.chat_tasks_status_running
            BackgroundTaskStatus.Completed -> R.string.chat_tasks_status_completed
            BackgroundTaskStatus.Failed -> R.string.chat_tasks_status_failed
            BackgroundTaskStatus.Cancelled -> R.string.chat_tasks_status_cancelled
        },
    )
    val at = if (task.isRunning) task.startedAt else task.finishedAt ?: task.startedAt
    if (at == null) return status
    val ago = formatRelativeTime(LocalResources.current, at, now)
    return stringResource(R.string.chat_tasks_status_time, status, ago)
}

private const val TASK_CLOCK_MS = 30_000L
