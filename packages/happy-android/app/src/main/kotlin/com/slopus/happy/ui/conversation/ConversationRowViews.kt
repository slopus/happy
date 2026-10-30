package com.slopus.happy.ui.conversation

import android.util.Base64
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.MessageMeta
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.UserDisplay
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.MediaRef
import com.slopus.happy.conversation.NoticeKind
import com.slopus.happy.ui.chat.AgentMessage
import com.slopus.happy.ui.chat.BubblePalette
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.ToolView
import com.slopus.happy.ui.chat.UserMessage
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

object ConversationRowTags {
    const val REASONING = "conversation.reasoning"
    const val PICTURE = "conversation.picture"
    const val MEDIA = "conversation.media"
    const val MEDIA_FILE = "conversation.media.file"
    const val ARTIFACT = "conversation.artifact"
    const val COLLABORATOR = "conversation.collaborator"
    const val FAILURE = "conversation.failure"
    const val FAILURE_RETRY = "conversation.failure.retry"
    const val NOTICE = "conversation.notice"
}

/** The rows' own measures; text, tools and user bubbles are the legacy chat's (MessageSpec, ToolSpec). */
object ConversationRowSpec {
    val marginHorizontal = 16.dp
    val marginVertical = 6.dp
    val cardRadius = 12.dp
    val cardPadding = 12.dp
    val pictureMaxWidth = 280.dp
    val pictureMaxHeight = 360.dp
    val pictureRadius = 8.dp
    val pictureGap = 4.dp
    val mediaThumb = 120.dp
    val label = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.SemiBold)
    val body = happyTextStyle(fontSize = 14, lineHeight = 20)
    val notice = happyTextStyle(fontSize = 13, lineHeight = 18)
    val icon = 16.dp
}

/** What the rows ask of the screen. */
class ConversationRowActions(
    val legacy: MessageCallbacks,
    val onRetryFailure: (String) -> Unit,
    /** A presented item's bytes. */
    val loadMedia: suspend (MediaRef) -> ByteArray,
    /** Opens an artifact; null where this build has no viewer, and its card says where it opens. */
    val onOpenArtifact: ((artifactId: String) -> Unit)? = null,
    /** Shows one picture full screen. */
    val onOpenPicture: (bytes: ByteArray, cacheKey: String, name: String?) -> Unit = { _, _, _ -> },
    /** Opens a presented video or file in whatever on the phone reads it. */
    val onOpenMedia: ((MediaRef) -> Unit)? = null,
    /** What that is doing: reading, or why it could not open. */
    val mediaOpening: (MediaRef) -> MediaOpening? = { null },
)

/**
 * One conversation row. User bubbles, agent text and tool rows are the
 * legacy chat's own components (MessageView, ToolView in compact form, so
 * tool output stays hidden); the rest are drawn here. Spec: every row here
 * is 16 in from the sides and 6 above and below. Reasoning: an 13/18
 * semibold "Thinking" line with a 16 chevron in textSecondary, opening to
 * the 14/20 text in textSecondary. Pictures: up to 280 wide and 360 high,
 * radius 8, 4 apart. Media: 120 square thumbnails, 4 apart, each read on
 * demand; videos and files are a surfaceHigh card (radius 12, padding 12)
 * naming the file and saying where it opens. Artifacts the same card,
 * with the artifact's title. Another agent's message: "From another agent"
 * (13/18 semibold, textSecondary) over its Markdown. A failure: a
 * surfaceHigh card with the reason in textDestructive and Retry (13/18
 * semibold, link colour) while it can help, "Retried" once acted on. A
 * notice: 13/18 textSecondary, centred.
 */
@Composable
fun ConversationRowView(row: ConversationRow, bubble: BubblePalette, actions: ConversationRowActions) {
    val content = Modifier.contentMaxWidth(LocalWindowLayout.current)
    Box(Modifier.fillMaxWidth()) {
        when (row) {
            is ConversationRow.User -> UserRow(row, bubble, actions, content)
            is ConversationRow.Text -> AgentMessage(
                ChatRow.AgentText(ChatMessage.AgentText(row.key, 0, row.text), row.blocks),
                actions.legacy,
                content,
            )
            is ConversationRow.Tool -> ToolView(
                ChatMessage.ToolCallMessage(
                    id = row.key,
                    createdAt = row.createdAt,
                    tool = ToolCall(
                        callId = row.callId,
                        name = row.name,
                        state = when (row.status) {
                            "completed" -> ToolState.Completed
                            "failed" -> ToolState.Error
                            else -> ToolState.Running
                        },
                        input = row.input,
                        createdAt = row.createdAt,
                    ),
                ),
                actions.legacy,
                content,
            )
            is ConversationRow.Reasoning -> ReasoningRow(row, content)
            is ConversationRow.Picture -> Box(content.fillMaxWidth().padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical)) {
                InlinePicture(row.key, row.image, actions)
            }
            is ConversationRow.Media -> MediaRow(row, actions, content)
            is ConversationRow.Artifact -> InfoCard(
                icon = Ionicon.LayersOutline,
                title = row.title.ifEmpty { stringResource(R.string.conversation_artifact) },
                detail = stringResource(R.string.conversation_artifact_unavailable).takeIf { actions.onOpenArtifact == null },
                onClick = actions.onOpenArtifact?.let { open -> { open(row.artifactId) } },
                modifier = content.testTag(ConversationRowTags.ARTIFACT),
            )
            is ConversationRow.Collaborator -> CollaboratorRow(row, content)
            is ConversationRow.Failure -> FailureRow(row, actions, content)
            is ConversationRow.Notice -> Text(
                stringResource(
                    when (row.kind) {
                        NoticeKind.Compacting -> R.string.conversation_compacting
                        NoticeKind.Compacted -> R.string.conversation_compacted
                        NoticeKind.CompactionFailed -> R.string.conversation_compaction_failed
                    },
                ),
                style = ConversationRowSpec.notice,
                color = HappyTheme.colors.textSecondary,
                textAlign = TextAlign.Center,
                modifier = content
                    .fillMaxWidth()
                    .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical)
                    .testTag(ConversationRowTags.NOTICE),
            )
        }
    }
}

@Composable
private fun UserRow(row: ConversationRow.User, bubble: BubblePalette, actions: ConversationRowActions, modifier: Modifier) {
    val failed = row.delivery as? Delivery.Failed
    // A send waiting behind a running turn reads "Sends after this turn"; one on its way, "Sending…".
    val message = remember(row) {
        ChatMessage.UserText(
            id = row.key,
            localId = row.messageId,
            createdAt = if (row.delivery == Delivery.Sending) System.currentTimeMillis() else 0,
            text = row.text,
            meta = if (row.delivery == Delivery.Pending) MessageMeta(buildJsonObject { put("queuedWhileBusy", JsonPrimitive(true)) }) else null,
            pending = row.delivery == Delivery.Sending || row.delivery == Delivery.Pending,
            sendError = failed?.reason,
        )
    }
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        if (row.pictures.isNotEmpty()) {
            FlowRow(
                modifier = Modifier.padding(horizontal = ConversationRowSpec.marginHorizontal).padding(top = ConversationRowSpec.marginVertical),
                horizontalArrangement = Arrangement.spacedBy(ConversationRowSpec.pictureGap, Alignment.End),
                verticalArrangement = Arrangement.spacedBy(ConversationRowSpec.pictureGap),
            ) {
                row.pictures.forEachIndexed { index, picture -> InlinePicture("${row.key}:$index", picture, actions) }
            }
        }
        if (row.text.isNotEmpty() || failed != null) {
            UserMessage(
                ChatRow.User(message, UserDisplay.Text(row.text, row.blocks), failedLocalId = row.messageId.takeIf { failed != null }),
                bubble,
                actions.legacy,
            )
        }
    }
}

@Composable
private fun InlinePicture(key: String, image: Block.Image, actions: ConversationRowActions) {
    val bytes = remember(key) {
        try {
            Base64.decode(image.data, Base64.DEFAULT)
        } catch (_: IllegalArgumentException) {
            null
        }
    }
    if (bytes == null) {
        Text(stringResource(R.string.conversation_picture_failed), style = ConversationRowSpec.notice, color = HappyTheme.colors.textSecondary)
        return
    }
    RemoteImage(
        model = bytes,
        cacheKey = "conversation/$key",
        contentDescription = null,
        contentScale = androidx.compose.ui.layout.ContentScale.Fit,
        background = HappyTheme.colors.surfaceHigh,
        modifier = Modifier
            .testTag(ConversationRowTags.PICTURE)
            .widthIn(max = ConversationRowSpec.pictureMaxWidth)
            .heightIn(max = ConversationRowSpec.pictureMaxHeight)
            .aspectRatio(1f, matchHeightConstraintsFirst = false)
            .clip(RoundedCornerShape(ConversationRowSpec.pictureRadius))
            .clickable(role = Role.Button) { actions.onOpenPicture(bytes, "conversation/$key", null) },
    )
}

@Composable
private fun ReasoningRow(row: ConversationRow.Reasoning, modifier: Modifier) {
    val colors = HappyTheme.colors
    var open by rememberSaveable(row.key) { mutableStateOf(false) }
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical)
            .testTag(ConversationRowTags.REASONING),
    ) {
        Row(
            modifier = Modifier.clickable(role = Role.Button) { open = !open },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(stringResource(R.string.conversation_thinking), style = ConversationRowSpec.label, color = colors.textSecondary)
            Icon(if (open) Ionicon.ChevronUp else Ionicon.ChevronDown, ConversationRowSpec.icon, colors.textSecondary)
        }
        if (open) Text(row.text, style = ConversationRowSpec.body, color = colors.textSecondary, modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable
private fun MediaRow(row: ConversationRow.Media, actions: ConversationRowActions, modifier: Modifier) {
    val visual = row.items.filter { it.item.kind == "image" }
    val other = row.items.filter { it.item.kind != "image" }
    Column(
        modifier.fillMaxWidth().padding(vertical = ConversationRowSpec.marginVertical).testTag(ConversationRowTags.MEDIA),
        verticalArrangement = Arrangement.spacedBy(ConversationRowSpec.pictureGap),
    ) {
        if (visual.isNotEmpty()) {
            FlowRow(
                modifier = Modifier.padding(horizontal = ConversationRowSpec.marginHorizontal),
                horizontalArrangement = Arrangement.spacedBy(ConversationRowSpec.pictureGap),
                verticalArrangement = Arrangement.spacedBy(ConversationRowSpec.pictureGap),
            ) {
                visual.forEach { MediaPicture(it, actions, single = visual.size == 1) }
            }
        }
        other.forEach { ref ->
            val opening = actions.mediaOpening(ref)
            val open = actions.onOpenMedia
            InfoCard(
                icon = if (ref.item.kind == "video") Ionicon.PlayCircleOutline else Ionicon.DocumentTextOutline,
                title = ref.item.name,
                detail = when {
                    opening is MediaOpening.Failed -> opening.reason
                    opening is MediaOpening.Reading -> stringResource(R.string.conversation_media_reading)
                    open == null -> stringResource(if (ref.item.kind == "video") R.string.conversation_video_unavailable else R.string.conversation_file_unavailable)
                    else -> null
                },
                onClick = open?.let { { it(ref) } },
                modifier = Modifier.testTag(ConversationRowTags.MEDIA_FILE),
                vertical = 0.dp,
            )
        }
    }
}

@Composable
private fun MediaPicture(ref: MediaRef, actions: ConversationRowActions, single: Boolean) {
    val load = actions.loadMedia
    val bytes by produceState<Result<ByteArray>?>(null, ref.key) {
        value = try {
            Result.success(load(ref))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
    val ratio = ref.item.width?.let { w -> ref.item.height?.takeIf { it > 0 }?.let { (w / it).toFloat() } } ?: 1f
    val size = if (single) Modifier.widthIn(max = ConversationRowSpec.pictureMaxWidth).fillMaxWidth().aspectRatio(ratio.coerceIn(0.5f, 2f))
    else Modifier.size(ConversationRowSpec.mediaThumb)
    val shape = RoundedCornerShape(ConversationRowSpec.pictureRadius)
    val loaded = bytes?.getOrNull()
    if (loaded != null) {
        RemoteImage(
            model = loaded,
            cacheKey = "conversation/media/${ref.key}",
            contentDescription = ref.item.name,
            background = HappyTheme.colors.surfaceHigh,
            modifier = size
                .clip(shape)
                .clickable(role = Role.Button) { actions.onOpenPicture(loaded, "conversation/media/${ref.key}", ref.item.name) },
        )
    } else {
        Box(size.clip(shape).background(HappyTheme.colors.surfaceHigh), contentAlignment = Alignment.Center) {
            if (bytes?.isFailure == true) {
                Text(stringResource(R.string.conversation_picture_failed), style = ConversationRowSpec.notice, color = HappyTheme.colors.textSecondary, textAlign = TextAlign.Center, modifier = Modifier.padding(8.dp))
            } else {
                Icon(Ionicon.ImageOutline, 24.dp, HappyTheme.colors.textSecondary)
            }
        }
    }
}

@Composable
private fun InfoCard(
    icon: Ionicon,
    title: String,
    detail: String?,
    onClick: (() -> Unit)?,
    modifier: Modifier = Modifier,
    vertical: androidx.compose.ui.unit.Dp = ConversationRowSpec.marginVertical,
) {
    val colors = HappyTheme.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = vertical)
            .clip(RoundedCornerShape(ConversationRowSpec.cardRadius))
            .background(colors.surfaceHigh)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(ConversationRowSpec.cardPadding),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, 22.dp, colors.textSecondary)
        Column(Modifier.weight(1f)) {
            Text(title, style = ConversationRowSpec.label, color = colors.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (detail != null) Text(detail, style = ConversationRowSpec.notice, color = colors.textSecondary)
        }
        if (onClick != null) Icon(Ionicon.ChevronForward, ConversationRowSpec.icon, colors.textSecondary)
    }
}

@Composable
private fun CollaboratorRow(row: ConversationRow.Collaborator, modifier: Modifier) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical)
            .testTag(ConversationRowTags.COLLABORATOR),
    ) {
        Text(stringResource(R.string.conversation_from_agent), style = ConversationRowSpec.label, color = HappyTheme.colors.textSecondary)
        if (row.blocks.isNotEmpty()) MarkdownView(row.blocks)
    }
}

@Composable
private fun FailureRow(row: ConversationRow.Failure, actions: ConversationRowActions, modifier: Modifier) {
    val colors = HappyTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical)
            .clip(RoundedCornerShape(ConversationRowSpec.cardRadius))
            .background(colors.surfaceHigh)
            .padding(ConversationRowSpec.cardPadding)
            .testTag(ConversationRowTags.FAILURE),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Ionicon.AlertCircleOutline, 18.dp, colors.textDestructive)
            Text(row.reason, style = ConversationRowSpec.body, color = colors.textDestructive, modifier = Modifier.weight(1f))
        }
        when {
            row.resolved -> Text(stringResource(R.string.conversation_failure_resolved), style = ConversationRowSpec.label, color = colors.textSecondary)
            row.retryable -> Text(
                stringResource(R.string.common_retry),
                style = ConversationRowSpec.label,
                color = colors.textLink,
                modifier = Modifier
                    .testTag(ConversationRowTags.FAILURE_RETRY)
                    .clickable(role = Role.Button) { actions.onRetryFailure(row.messageId) }
                    .padding(vertical = 4.dp),
            )
        }
    }
}
