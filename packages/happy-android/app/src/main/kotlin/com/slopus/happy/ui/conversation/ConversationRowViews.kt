package com.slopus.happy.ui.conversation

import com.slopus.happy.conversation.InlinePicture
import com.slopus.happy.conversation.pictureSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
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
import com.slopus.happy.chat.MessageDelivery
import com.slopus.happy.chat.UserDisplay
import com.slopus.happy.artifacts.formatDuration
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationViewing
import com.slopus.happy.conversation.Delivery
import com.slopus.happy.conversation.LiveText
import com.slopus.happy.ui.chat.rememberTextReveal
import com.slopus.happy.ui.components.RecomposeProbe
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.withFrameNanos
import com.slopus.happy.conversation.MediaFlow
import com.slopus.happy.conversation.MediaRef
import com.slopus.happy.conversation.NoticeKind
import com.slopus.happy.conversation.ToolUse
import com.slopus.happy.ui.chat.BubblePalette
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.UserMessage
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.rememberThumbHash
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object ConversationRowTags {
    /** Every row's outermost box, as tall as it is drawn. */
    const val ROW = "conversation.row"
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

/** The rows' own measures; text and user bubbles are the legacy chat's (MessageSpec), a turn's own rows [TurnRowSpec]. */
object ConversationRowSpec {
    val marginHorizontal = 16.dp
    val marginVertical = 6.dp
    val cardRadius = 12.dp
    val cardPadding = 12.dp
    /** Under a bubble's own 4: its photos 8 under it, as iOS. */
    val photosGap = 4.dp
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
    val onOpenArtifact: ((ConversationRow.Artifact) -> Unit)? = null,
    /** Opens the viewer on a picture or recording, by its key ([ConversationViewing]), paging through the conversation's. */
    val onOpenPicture: (key: String) -> Unit = {},
    /** A presented recording's first frame, size and length; null where none can be read. */
    val loadVideo: suspend (MediaRef) -> VideoPoster? = { null },
    /** Opens a presented file in whatever on the phone reads it. */
    val onOpenMedia: ((MediaRef) -> Unit)? = null,
    /** What that is doing: reading, or why it could not open. */
    val mediaOpening: (MediaRef) -> MediaOpening? = { null },
    /** The waiting question's ticks and answer; null where nothing answers. */
    val asks: AskActions? = null,
    /** Opens a finished turn on its work, or folds it again, by its run. */
    val onToggleTurn: (String) -> Unit = {},
)

/**
 * What a call showed under its line, [TurnRowSpec.resultGap] apart (iOS
 * `ToolResultLayout`); alone where no call presented it.
 */
@Composable
private fun ToolResult(tool: ToolUse?, modifier: Modifier, body: @Composable (Modifier) -> Unit) {
    if (tool == null) return body(modifier)
    Column(modifier) {
        ToolLine(tool, bottom = TurnRowSpec.resultGap - ConversationRowSpec.marginVertical)
        body(Modifier)
    }
}

/**
 * One conversation row. User bubbles and agent text are the legacy chat's
 * own components (MessageView); a tool call is its one line in plain words
 * and a turn's end and fold control are desktop's ([TurnRowSpec]); the rest
 * are drawn here. Spec: every row here
 * is 16 in from the sides and 6 above and below. Reasoning: an 13/18
 * semibold "Thinking" line with a 16 chevron in textSecondary, opening to
 * the 14/20 text in textSecondary. Pictures are laid out as iOS lays them
 * ([MediaFlow], [MediaFlowLayout]), each whole in a tile of its own shape
 * ([MediaTile]: radius 8, a divider hairline), 8 apart, planned from their
 * sizes before the bytes come. A person's photos go 8 under their bubble
 * against the right edge, in at most the bubble's width (36 clear at the
 * left, never past 560): one alone up to 360 high, several justified up
 * to 280 high; past four, the fourth reads "+N" (iOS shows four). An
 * agent's, and what a tool presented, from the left edge at the column's
 * measure: one alone up to 640 high, never past its own size; several
 * justified up to 480 high, or in the 1 or 2 columns the tool asked for;
 * recordings under them, each at its own box (at most 380 × 320, never
 * enlarged), a first frame under a play circle and its length. A tap opens
 * the viewer, which pages through every picture and recording of the
 * conversation. Media is read on demand; files are a surfaceHigh card
 * (radius 12, padding 12) naming the file and saying where it opens.
 * Artifacts the same card, with the artifact's title. Another agent's
 * message: "From another agent" (13/18 semibold, textSecondary) over its
 * Markdown. A failure: a surfaceHigh card with the reason in
 * textDestructive and Retry (13/18 semibold, link colour) while it can
 * help, "Retried" once acted on. A notice: 13/18 textSecondary, centred.
 */
@Composable
fun ConversationRowView(row: ConversationRow, bubble: BubblePalette, actions: ConversationRowActions, modifier: Modifier = Modifier) {
    if (RecomposeProbe.counts != null) RecomposeProbe.mark(ConversationScreenTags.probeRow(row.key))
    val content = Modifier.contentMaxWidth(LocalWindowLayout.current)
    Box(modifier.fillMaxWidth().testTag(ConversationRowTags.ROW)) {
        when (row) {
            is ConversationRow.User -> UserRow(row, bubble, actions, content)
            is ConversationRow.Text -> TextRow(row, actions, content)
            is ConversationRow.Tool -> ToolLine(row.tool, content)
            is ConversationRow.Reasoning -> ReasoningProse(row, content)
            is ConversationRow.Picture -> Box(content.fillMaxWidth().padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical)) {
                InlinePictures(row.key, listOf(row.image), actions, MediaFlow.tool, alignEnd = false)
            }
            is ConversationRow.Media -> ToolResult(row.tool, content) { MediaRow(row, actions, it) }
            is ConversationRow.Artifact -> ToolResult(row.tool, content) {
                InfoCard(
                    icon = Ionicon.LayersOutline,
                    title = row.title.ifEmpty { stringResource(R.string.conversation_artifact) },
                    detail = stringResource(R.string.conversation_artifact_unavailable).takeIf { actions.onOpenArtifact == null },
                    onClick = actions.onOpenArtifact?.let { open -> { open(row) } },
                    modifier = it.testTag(ConversationRowTags.ARTIFACT),
                )
            }
            is ConversationRow.Collaborator -> CollaboratorProse(row, actions.legacy, content)
            is ConversationRow.Failure -> FailureRow(row, actions, content)
            is ConversationRow.Ask -> AskRow(row, actions.asks, content)
            is ConversationRow.TurnEnd -> TurnEndRow(row, content)
            is ConversationRow.Trace -> TraceRow(row, actions.onToggleTurn, content)
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

/**
 * An answer's text. While it streams its words come from [ConversationRow.Text.live],
 * taken at most once a frame and read here alone, so a delta recomposes this row and
 * nothing else; [rememberTextReveal] draws them in.
 */
@Composable
private fun TextRow(row: ConversationRow.Text, actions: ConversationRowActions, modifier: Modifier) {
    val live = row.live?.let { framed(it) }
    if (RecomposeProbe.counts != null) RecomposeProbe.mark(ConversationScreenTags.probeText(row.key))
    val reveal = rememberTextReveal(row.key, streaming = row.live != null) { row.live?.isFresh() == true }
    val text = live?.text ?: row.text
    val blocks = live?.blocks ?: row.blocks
    AnswerProse(ProseSource(row.key, ProseKind.Answer, text, blocks), actions.legacy, modifier, reveal, copies = row.copies)
}

/**
 * [live]'s words as this frame shows them: a new reading is taken in the
 * frame's own callback, before it composes, so however many deltas came
 * since the last frame the row composes once.
 */
@Composable
internal fun framed(live: LiveText): LiveText.Content {
    val shown = remember(live) { mutableStateOf(live.content.value) }
    com.slopus.happy.ui.components.StartedEffect(live) {
        live.content.collect { withFrameNanos { shown.value = live.content.value } }
    }
    return shown.value
}

@Composable
private fun UserRow(row: ConversationRow.User, bubble: BubblePalette, actions: ConversationRowActions, modifier: Modifier) {
    val failed = row.delivery is Delivery.Failed
    // The mark says where it stands (iOS 3c24acf5c): the clock on its way, one check
    // taken by the agent's API, two once a run took it, a red mark if refused.
    val delivery = when (row.delivery) {
        Delivery.Sending -> MessageDelivery.Sending
        Delivery.Pending -> MessageDelivery.Received
        Delivery.Sent -> MessageDelivery.Accepted
        is Delivery.Failed -> MessageDelivery.Failed
    }
    val message = remember(row) {
        ChatMessage.UserText(id = row.key, localId = row.messageId, createdAt = row.createdAt, text = row.text)
    }
    // The photos go under the words, against the right edge as the bubble is.
    val photos = @Composable {
        InlinePictures(row.key, row.pictures, actions, MediaFlow.message, alignEnd = true, measure = MediaFlow::messageMeasure, limit = true)
    }
    if (row.text.isNotEmpty() || failed) {
        UserMessage(
            ChatRow.User(message, UserDisplay.Text(row.text, row.blocks), delivery = delivery, time = row.createdAt),
            bubble,
            actions.legacy,
            modifier.fillMaxWidth(),
            statusLine = false,
            onRetry = if (failed) ({ actions.legacy.onRetry(row.messageId) }) else null,
            onDiscard = if (failed) ({ actions.legacy.onDiscard(row.messageId) }) else null,
            attachments = if (row.pictures.isEmpty()) null else {
                { Box(Modifier.padding(top = ConversationRowSpec.photosGap)) { photos() } }
            },
            body = if (row.text.isNotEmpty()) { _ -> UserProse(row, actions.legacy) } else null,
        )
    } else if (row.pictures.isNotEmpty()) {
        Box(
            modifier
                .fillMaxWidth()
                .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical),
        ) { photos() }
    }
}

/**
 * A message's own pictures, read from the bytes it carries: their shapes
 * from their headers, before they decode. A person's message shows its
 * first four ([MediaFlow.MESSAGE_MAX], [limit]); the fourth says how many
 * more there are, and the viewer pages through them all.
 */
@Composable
private fun InlinePictures(
    key: String,
    pictures: List<Block.Image>,
    actions: ConversationRowActions,
    limits: MediaFlow.Limits,
    alignEnd: Boolean,
    measure: (Float) -> Float = { it },
    limit: Boolean = false,
) {
    val shown = if (limit) MediaFlow.messageShown(pictures.size) else pictures.size
    val more = if (limit) MediaFlow.messageMore(pictures.size) else 0
    // Read on the lane as the row was built; here only looked up.
    val decoded = remember(key, pictures, shown) { pictures.take(shown).map(InlinePicture::of) }
    val label = stringResource(R.string.conversation_picture)
    MediaFlowLayout(
        items = decoded.map { MediaFlow.Item(false, it.size) },
        limits = limits,
        alignEnd = alignEnd,
        measure = measure,
        modifier = Modifier.testTag(ConversationRowTags.PICTURE),
    ) { index ->
        val bytes = decoded[index].bytes
        val cacheKey = ConversationViewing.pictureKey(key, index)
        MediaTile(
            bytes = bytes,
            cacheKey = cacheKey,
            contentDescription = label,
            failed = bytes == null,
            onClick = bytes?.let { { actions.onOpenPicture(cacheKey) } },
            more = if (index == decoded.lastIndex) more else 0,
        )
    }
}

@Composable
private fun MediaRow(row: ConversationRow.Media, actions: ConversationRowActions, modifier: Modifier) {
    val visual = row.items.filter { it.item.isVisual }
    val other = row.items.filter { !it.item.isVisual }
    Column(
        modifier.fillMaxWidth().padding(vertical = ConversationRowSpec.marginVertical).testTag(ConversationRowTags.MEDIA),
        verticalArrangement = Arrangement.spacedBy(MediaFlow.GAP.dp),
    ) {
        if (visual.isNotEmpty()) {
            val loads = visual.map { ref -> key(ref.key) { if (ref.item.kind == "video") null else rememberMediaBytes(ref, actions.loadMedia) } }
            val posters = visual.map { ref -> key(ref.key) { if (ref.item.kind == "video") rememberVideoPoster(ref, actions.loadVideo) else null } }
            // As stated, else the hash's shape; one that stated no size takes its own once read.
            val items = visual.mapIndexed { index, ref ->
                val stated = ref.item.flowImage()
                val video = ref.item.kind == "video"
                val read = if (video) posters[index]?.let { MediaFlow.Image(it.width, it.height) } else loads[index]?.getOrNull()?.size
                MediaFlow.Item(video, if (MediaFlow.pointSize(stated) == null && read?.width != null) read else stated)
            }
            MediaFlowLayout(
                items = items,
                columns = row.columns,
                limits = MediaFlow.tool,
                modifier = Modifier.padding(horizontal = ConversationRowSpec.marginHorizontal),
            ) { index ->
                val ref = visual[index]
                val key = ConversationViewing.presentedKey(ref)
                val thumbhash = rememberThumbHash(ref.item.thumbhash)
                if (ref.item.kind == "video") {
                    val poster = posters[index]
                    val frame = poster?.frame
                    val still = remember(frame) { frame?.asImageBitmap() }
                    MediaTile(
                        bytes = null,
                        cacheKey = key,
                        contentDescription = ref.item.name.ifEmpty { stringResource(R.string.artifact_video) },
                        failed = false,
                        onClick = { actions.onOpenPicture(key) },
                        placeholder = still ?: thumbhash,
                        video = true,
                        duration = poster?.seconds?.let(::formatDuration),
                    )
                } else {
                    val load = loads[index]
                    val bytes = load?.getOrNull()?.bytes
                    MediaTile(
                        bytes = bytes,
                        cacheKey = key,
                        contentDescription = ref.item.name.ifEmpty { stringResource(R.string.conversation_picture) },
                        failed = load?.isFailure == true,
                        onClick = bytes?.let { { actions.onOpenPicture(key) } },
                        placeholder = thumbhash,
                    )
                }
            }
        }
        other.forEach { ref ->
            val opening = actions.mediaOpening(ref)
            val open = actions.onOpenMedia
            InfoCard(
                icon = Ionicon.DocumentTextOutline,
                title = ref.item.name,
                detail = when {
                    opening is MediaOpening.Failed -> opening.reason
                    opening is MediaOpening.Reading -> stringResource(R.string.conversation_media_reading)
                    open == null -> stringResource(R.string.conversation_file_unavailable)
                    else -> null
                },
                onClick = open?.let { { it(ref) } },
                modifier = Modifier.testTag(ConversationRowTags.MEDIA_FILE),
                vertical = 0.dp,
            )
        }
    }
}

/** A presented recording's first frame and length, read once per item while it is shown; null until they come or when they can't. */
@Composable
private fun rememberVideoPoster(ref: MediaRef, load: suspend (MediaRef) -> VideoPoster?): VideoPoster? {
    val poster by produceState<VideoPoster?>(null, ref.key) {
        value = try {
            load(ref)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
    }
    return poster
}

/** A presented picture's bytes and the size its header gives. */
private class MediaBytes(val bytes: ByteArray, val size: MediaFlow.Image)

/** A presented picture's bytes, read once per item while it is shown; null until they come. */
@Composable
private fun rememberMediaBytes(ref: MediaRef, load: suspend (MediaRef) -> ByteArray): Result<MediaBytes>? {
    val bytes by produceState<Result<MediaBytes>?>(null, ref.key) {
        value = try {
            val bytes = load(ref)
            Result.success(MediaBytes(bytes, withContext(Dispatchers.Default) { pictureSize(bytes) }))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
    return bytes
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
            Text(failureText(row.reason), style = ConversationRowSpec.body, color = colors.textDestructive, modifier = Modifier.weight(1f))
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
