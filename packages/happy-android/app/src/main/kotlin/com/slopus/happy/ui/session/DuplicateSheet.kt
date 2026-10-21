package com.slopus.happy.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.slopus.happy.R
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.resume.ResumeOps
import com.slopus.happy.resume.ResumeOutcome
import com.slopus.happy.resume.ResumeTexts
import com.slopus.happy.resume.SessionResumer
import com.slopus.happy.sync.ForkOptions
import com.slopus.happy.sync.ForkSource
import com.slopus.happy.sync.MachineOps
import com.slopus.happy.sync.RewindPoint
import com.slopus.happy.sync.RewindPointsResult
import com.slopus.happy.sync.SpawnSessionResult
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.launch

/** Resume, fork and duplicate (ops.ts); tests use a fake. */
interface SessionContinuations {
    /** [SessionResumer]: with the session's mode picks, refreshed and re-pinned once running. */
    suspend fun resume(machineId: String, sessionId: String, metadata: SessionMetadata?, texts: ResumeTexts): ResumeOutcome
    suspend fun fork(source: ForkSource, options: ForkOptions = ForkOptions()): SpawnSessionResult
    suspend fun rewindPoints(source: ForkSource): RewindPointsResult
}

/** [SessionContinuations] over the signed-in account's [MachineOps]. */
class LiveSessionContinuations(
    private val ops: () -> MachineOps?,
    private val resumer: SessionResumer,
    private val resumeOps: () -> ResumeOps?,
) : SessionContinuations {
    override suspend fun resume(machineId: String, sessionId: String, metadata: SessionMetadata?, texts: ResumeTexts): ResumeOutcome =
        resumer.resume(resumeOps(), sessionId, machineId, metadata, texts)

    override suspend fun fork(source: ForkSource, options: ForkOptions): SpawnSessionResult =
        ops()?.forkAndSpawn(source, options) ?: SpawnSessionResult.Error(SIGNED_OUT)

    override suspend fun rewindPoints(source: ForkSource): RewindPointsResult {
        val ops = ops() ?: return RewindPointsResult.Error(SIGNED_OUT)
        return when (source) {
            is ForkSource.Claude -> ops.claudeRewindPoints(source.machineId, source.directory, source.claudeSessionId)
            is ForkSource.Codex -> ops.codexRewindPoints(source.machineId, source.directory, source.codexThreadId)
        }
    }

    private companion object {
        const val SIGNED_OUT = "Not signed in"
    }
}

object DuplicateSheetTags {
    const val SHEET = "duplicate.sheet"
    const val ROW = "duplicate.row"
    const val CONFIRM = "duplicate.confirm"
    const val CANCEL = "duplicate.cancel"
    const val EMPTY = "duplicate.empty"
}

/** DuplicateSheet.tsx's styles; duplicateSheetLayout.ts's frame. */
object DuplicateSheetSpec {
    val margin = 16.dp
    val maxWidth = 560.dp
    const val MAX_HEIGHT_RATIO = 0.85f
    val radius = 16.dp
    val title = happyTextStyle(fontSize = 17, weight = FontWeight.SemiBold)
    val subtitle = happyTextStyle(fontSize = 13)
    val listMaxHeight = 420.dp
    val rowText = happyTextStyle(fontSize = 14, lineHeight = 19)
    val rowMeta = happyTextStyle(fontSize = 12)
    val empty = happyTextStyle(fontSize = 14)
    val buttonRadius = 10.dp
    val primary = happyTextStyle(fontSize = 15, weight = FontWeight.SemiBold)
    val secondary = happyTextStyle(fontSize = 15, weight = FontWeight.Medium)
    const val PREVIEW_LENGTH = 140
}

/** DuplicateSheet's row text: whitespace collapsed, cut at 140 with an ellipsis. */
fun rewindPreview(text: String): String {
    val preview = text.trim().replace(Regex("\\s+"), " ")
    return if (preview.length > DuplicateSheetSpec.PREVIEW_LENGTH) preview.take(DuplicateSheetSpec.PREVIEW_LENGTH) + "…" else preview
}

/**
 * DuplicateSheet: the provider's user messages, newest first, as rewind
 * points. Pick one and Duplicate forks the conversation up to it into a new
 * session, which [onDuplicated] opens. [initialPointId] preselects a point
 * (a message's long-press); [initialForkedFromMessageId] is then recorded as
 * the lineage while that point stays selected.
 */
@Composable
fun DuplicateSheet(
    source: ForkSource?,
    continuations: SessionContinuations,
    onDismiss: () -> Unit,
    onDuplicated: (sessionId: String) -> Unit,
    initialPointId: String? = null,
    initialForkedFromMessageId: String? = null,
    now: () -> Long = System::currentTimeMillis,
) {
    val colors = HappyTheme.colors
    val scope = rememberCoroutineScope()
    var points by remember { mutableStateOf<List<RewindPoint>?>(null) }
    var pointsError by remember { mutableStateOf<String?>(null) }
    var selectedId by remember { mutableStateOf(initialPointId) }
    var loading by remember { mutableStateOf(false) }
    var alert by remember { mutableStateOf<Alert?>(null) }
    val missingMetadata = stringResource(R.string.session_fork_error_missing_metadata)
    val genericError = stringResource(R.string.session_fork_error_generic)
    val errorTitle = stringResource(R.string.common_error)
    val ok = stringResource(R.string.common_ok)

    LaunchedEffect(source) {
        if (source == null) {
            pointsError = missingMetadata
            points = emptyList()
            return@LaunchedEffect
        }
        when (val result = continuations.rewindPoints(source)) {
            is RewindPointsResult.Success -> {
                points = result.points.reversed()
                pointsError = null
            }
            is RewindPointsResult.Error -> {
                points = emptyList()
                pointsError = result.errorMessage
            }
        }
        if (points?.none { it.id == selectedId } == true) selectedId = null
    }
    val selected = points?.find { it.id == selectedId }

    fun duplicate() {
        val chosen = selected ?: return
        val from = source ?: return
        loading = true
        scope.launch {
            try {
                val lineage = initialForkedFromMessageId.takeIf { chosen.id == initialPointId }
                val options = when (from) {
                    is ForkSource.Codex -> ForkOptions(cutAfterItemId = chosen.id, forkedFromMessageId = lineage)
                    is ForkSource.Claude -> ForkOptions(cutAfterUuid = chosen.id, forkedFromMessageId = lineage)
                }
                when (val result = continuations.fork(from, options)) {
                    is SpawnSessionResult.Success -> {
                        onDismiss()
                        onDuplicated(result.sessionId)
                    }
                    is SpawnSessionResult.Error -> alert = Alert(errorTitle, result.errorMessage, listOf(AlertButton(ok)))
                    else -> alert = Alert(errorTitle, genericError, listOf(AlertButton(ok)))
                }
            } finally {
                loading = false
            }
        }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        BoxWithConstraints {
            val width = min(DuplicateSheetSpec.maxWidth, maxWidth - DuplicateSheetSpec.margin * 2)
            val shape = RoundedCornerShape(DuplicateSheetSpec.radius)
            Column(
                modifier = Modifier
                    .width(width)
                    .heightIn(max = maxHeight * DuplicateSheetSpec.MAX_HEIGHT_RATIO)
                    .clip(shape)
                    .background(colors.surface)
                    .background(colors.glass.backgroundStrong)
                    .border(hairline(), colors.glass.divider, shape)
                    .testTag(DuplicateSheetTags.SHEET),
            ) {
                Column(modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 12.dp)) {
                    Text(stringResource(R.string.session_duplicate_sheet_title), style = DuplicateSheetSpec.title, color = colors.text)
                    Text(
                        stringResource(R.string.session_duplicate_sheet_subtitle),
                        style = DuplicateSheetSpec.subtitle,
                        color = colors.textSecondary,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
                HorizontalDivider(thickness = hairline(), color = colors.divider)
                Column(
                    modifier = Modifier
                        .weight(1f, fill = false)
                        .heightIn(max = DuplicateSheetSpec.listMaxHeight)
                        .verticalScroll(rememberScrollState())
                        .padding(vertical = 8.dp),
                ) {
                    val list = points
                    when {
                        list == null -> Box(Modifier.fillMaxWidth().padding(vertical = 32.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp), color = colors.textSecondary, strokeWidth = 2.dp)
                        }
                        pointsError != null -> EmptyText(pointsError!!)
                        list.isEmpty() -> EmptyText(stringResource(R.string.session_duplicate_sheet_empty))
                        else -> for (point in list) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(if (point.id == selectedId) colors.surfaceHigh else colors.surface.copy(alpha = 0f))
                                    .clickable(role = Role.RadioButton) { selectedId = point.id }
                                    .semantics { this.selected = point.id == selectedId }
                                    .testTag(DuplicateSheetTags.ROW)
                                    .padding(horizontal = 20.dp, vertical = 12.dp),
                            ) {
                                Text(
                                    rewindPreview(point.text),
                                    style = DuplicateSheetSpec.rowText,
                                    color = colors.text,
                                    maxLines = 3,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    relativeTime(point.timestamp.toLong(), now()),
                                    style = DuplicateSheetSpec.rowMeta,
                                    color = colors.textSecondary,
                                    modifier = Modifier.padding(top = 4.dp),
                                )
                            }
                            HorizontalDivider(thickness = hairline(), color = colors.divider)
                        }
                    }
                }
                HorizontalDivider(thickness = hairline(), color = colors.divider)
                Row(modifier = Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SheetButton(
                        text = stringResource(R.string.common_cancel),
                        style = DuplicateSheetSpec.secondary,
                        background = colors.surfaceHigh,
                        color = colors.text,
                        enabled = true,
                        onClick = onDismiss,
                        modifier = Modifier.weight(1f).testTag(DuplicateSheetTags.CANCEL),
                    )
                    SheetButton(
                        text = stringResource(if (loading) R.string.common_loading else R.string.session_duplicate_sheet_confirm),
                        style = DuplicateSheetSpec.primary,
                        background = colors.button.primaryBackground,
                        color = colors.button.primaryTint,
                        enabled = !loading && selected != null && source != null,
                        onClick = ::duplicate,
                        modifier = Modifier.weight(1f).testTag(DuplicateSheetTags.CONFIRM),
                    )
                }
            }
        }
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}

@Composable
private fun EmptyText(text: String) {
    Text(
        text,
        style = DuplicateSheetSpec.empty,
        color = HappyTheme.colors.textSecondary,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 32.dp).testTag(DuplicateSheetTags.EMPTY),
    )
}

@Composable
private fun SheetButton(
    text: String,
    style: androidx.compose.ui.text.TextStyle,
    background: androidx.compose.ui.graphics.Color,
    color: androidx.compose.ui.graphics.Color,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    Box(
        modifier = modifier
            .alpha(if (enabled) 1f else 0.4f)
            .clip(RoundedCornerShape(DuplicateSheetSpec.buttonRadius))
            .background(background)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = style, color = color)
    }
}

/** DuplicateSheet's formatRelativeTime: just now, minutes, hours, then days. */
@Composable
private fun relativeTime(timestamp: Long, now: Long): String {
    val minutes = ((now - timestamp) / 60_000).toInt()
    if (minutes < 1) return stringResource(R.string.time_just_now)
    if (minutes < 60) return pluralResource(R.plurals.time_minutes_ago, minutes, minutes)
    val hours = minutes / 60
    if (hours < 24) return pluralResource(R.plurals.time_hours_ago, hours, hours)
    val days = hours / 24
    return pluralResource(R.plurals.time_days_ago, days, days)
}
