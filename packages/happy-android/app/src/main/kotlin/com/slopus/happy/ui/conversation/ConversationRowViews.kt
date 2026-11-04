package com.slopus.happy.ui.conversation

import com.slopus.happy.ui.artifacts.ArtifactInlinePage
import com.slopus.happy.ui.artifacts.InlinePages
import com.slopus.happy.ui.artifacts.artifactCardDetail
import com.slopus.happy.ui.artifacts.artifactCardGlyph
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.ui.components.avatar.PlaceholderAvatar
import com.slopus.happy.ui.connection.AgentPicture
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.movableContentOf
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
import androidx.compose.foundation.layout.fillMaxSize
import com.slopus.happy.conversation.UploadPhase
import com.slopus.happy.conversation.UploadBoard
import com.slopus.happy.conversation.KeptMedia
import com.slopus.happy.media.MediaSizeText
import com.slopus.happy.media.NotKept
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
    /** A long message's Show full / Show less ([UserFold]). */
    const val USER_FOLD = "conversation.user.fold"
    const val STORY = "conversation.story"
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
    val storyLine = happyTextStyle(fontSize = 12, lineHeight = 16)
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
    /** Opens a person's long message whole, or cuts it back, by its row's key. */
    val onToggleMessage: (String) -> Unit = {},
    /** Each outgoing picture's way to the computer, for its ring; null where nothing sends. */
    val uploads: UploadBoard? = null,
    /** Takes picture `index` out of a message still on its way. */
    val onRemovePicture: (messageId: String, index: Int) -> Unit = { _, _ -> },
    /** Opens a tool call on its own screen, by its id; null where nothing opens it. */
    val onOpenTool: ((String) -> Unit)? = null,
    /** Presented media kept on this phone: each tile's download ring and size badge; null where nothing is kept. */
    val kept: KeptMedia? = null,
    /** A recording's tap: it plays once its first range is here, the tile spinning till then. */
    val videos: VideoOpening? = null,
    /** HTML artifacts shown inline under their cards; null where none are. */
    val pages: InlinePages? = null,
    /** The conversation's title: who posted its own stories, where the lists don't name it. */
    val title: String? = null,
)

/** Plays the recording [ref] whose tile is [key]: in the viewer, once it can ([VideoOpening]). */
internal fun ConversationRowActions.play(key: String, ref: MediaRef) {
    val videos = videos ?: return onOpenPicture(key)
    videos.open(key, ref) { onOpenPicture(key) }
}

/** What opens [tool]'s screen: only a call with an id, where the screen opens calls at all. */
internal fun ConversationRowActions.opener(tool: ToolUse?): (() -> Unit)? {
    val id = tool?.id ?: return null
    val open = onOpenTool ?: return null
    return { open(id) }
}

/**
 * What a call showed under its line, [TurnRowSpec.resultGap] apart (iOS
 * `ToolResultLayout`); alone where no call presented it.
 */
@Composable
private fun ToolResult(tool: ToolUse?, actions: ConversationRowActions, modifier: Modifier, body: @Composable (Modifier) -> Unit) {
    if (tool == null) return body(modifier)
    Column(modifier) {
        ToolLine(tool, bottom = TurnRowSpec.resultGap - ConversationRowSpec.marginVertical, onOpen = actions.opener(tool))
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
 * Artifacts the same card: the type's glyph, the title ("Untitled
 * artifact" without one), and the kind with the version a change made
 * (iOS's `ChatMediaPlan.card(artifact:)`). Another agent's
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
            is ConversationRow.Tool -> ToolLine(row.tool, content, onOpen = actions.opener(row.tool))
            is ConversationRow.Reasoning -> ReasoningProse(row, content)
            is ConversationRow.Picture -> Box(content.fillMaxWidth().padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical)) {
                InlinePictures(row.key, listOf(row.image), actions, MediaFlow.tool, alignEnd = false)
            }
            is ConversationRow.Media -> ToolResult(row.tool, actions, content) { MediaRow(row, actions, it) }
            is ConversationRow.Artifact -> ToolResult(row.tool, actions, content) {
                Column(it) {
                    InfoCard(
                        icon = artifactCardGlyph(row.type.orEmpty()),
                        title = row.title.ifEmpty { stringResource(R.string.artifact_untitled) },
                        detail = if (actions.onOpenArtifact == null) stringResource(R.string.conversation_artifact_unavailable) else artifactCardDetail(row.type.orEmpty(), row.version ?: 1),
                        onClick = actions.onOpenArtifact?.let { open -> { open(row) } },
                        modifier = Modifier.testTag(ConversationRowTags.ARTIFACT),
                    )
                    // Desktop's inline page, under its card, at the column's width.
                    val page = row.page
                    val pages = actions.pages
                    if (page != null && pages != null) {
                        ArtifactInlinePage(
                            row.artifactId, row.title, page, pages,
                            Modifier.padding(start = ConversationRowSpec.marginHorizontal, end = ConversationRowSpec.marginHorizontal, top = 2.dp, bottom = ConversationRowSpec.marginVertical),
                        )
                    }
                }
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
    // The photos go under the words, against the right edge as the bubble is; each still
    // going to the computer under its ring (iOS 5ac4296c2). Movable: a message of pictures
    // alone comes back captioned ("Attached images."), and its rings fill on in the bubble.
    val photos = remember {
        movableContentOf { row: ConversationRow.User, actions: ConversationRowActions ->
            val sending = row.delivery == Delivery.Sending
            InlinePictures(
                row.key, row.pictures, actions, MediaFlow.message, alignEnd = true, measure = MediaFlow::messageMeasure, limit = true,
                upload = { index -> if (sending) actions.uploads?.phase(UploadBoard.pictureKey(row.messageId, index)) ?: UploadPhase.Preparing else null },
                onCancel = { index -> actions.onRemovePicture(row.messageId, index) },
            )
        }
    }
    // Past its first lines it is cut, and a tap on the bubble opens it or cuts it back ([UserFold]).
    val prose = if (row.text.isNotEmpty()) rememberProse(ProseSource(row.key, ProseKind.User, row.text, row.blocks)) else null
    val cut = remember(prose) { prose?.cut(UserFold.FOLD_LINES) }
    val toggle = stringResource(if (row.opened) R.string.machine_launcher_show_less else R.string.conversation_show_full)
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
                { Box(Modifier.padding(top = ConversationRowSpec.photosGap)) { photos(row, actions) } }
            },
            onTap = if (cut != null) ({ actions.onToggleMessage(row.key) }) else null,
            tapLabel = toggle,
            body = if (prose != null) { _ -> UserProse(row, prose, cut, actions.legacy) } else null,
            header = row.story?.let { story -> { StoryQuoteCard(story, row.messageId, actions.title) } },
        )
    } else if (row.pictures.isNotEmpty()) {
        Box(
            modifier
                .fillMaxWidth()
                .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical),
        ) { photos(row, actions) }
    }
}

/**
 * Desktop's story-reply quote, 4 over the person's bubble: a surfaceHighest
 * card (radius 10, padding 6, at most 280 wide) with the story's first frame
 * (36 × 64, radius 6, cropped to fill; surfaceRipple without one) and, 8
 * beside it and centred, 2 apart: "Story" (12/16 textSecondary), the
 * author's 16 avatar and name ([ConversationRowSpec.label]) 6 apart, and the
 * caption on one line (12/16 textSecondary). The frame never plays, and a
 * tap does nothing: the phone has no story viewer.
 */
@Composable
private fun StoryQuoteCard(story: ConversationRow.StoryQuote, messageId: String, title: String?) {
    val colors = HappyTheme.colors
    Row(
        Modifier.padding(bottom = 4.dp).testTag(ConversationRowTags.STORY).widthIn(max = 280.dp).clip(RoundedCornerShape(10.dp)).background(colors.surfaceHighest).padding(6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val frame = "/v0/agents/${AgentClient.escape(story.agentId)}/messages/${AgentClient.escape(messageId)}/story-frame"
        if (story.frame) AgentPicture(frame, story.thumbhash, 36.dp, radius = 6.dp, height = 64.dp) else Box(Modifier.size(36.dp, 64.dp).clip(RoundedCornerShape(6.dp)).background(colors.surfaceRipple))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(stringResource(R.string.conversation_story), style = ConversationRowSpec.storyLine, color = colors.textSecondary, maxLines = 1)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                PlaceholderAvatar(story.seed, 16.dp)
                val untitled = if (story.person) "" else title ?: stringResource(R.string.reference_untitled_agent)
                Text(story.author ?: untitled, style = ConversationRowSpec.label, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            story.caption?.let { Text(it, style = ConversationRowSpec.storyLine, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
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
    /** Where each picture is on its way to the computer; null once it is there (or never went from here). */
    upload: (index: Int) -> UploadPhase? = { null },
    onCancel: (index: Int) -> Unit = {},
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
        Box {
            MediaTile(
                bytes = bytes,
                cacheKey = cacheKey,
                contentDescription = label,
                failed = bytes == null,
                onClick = bytes?.let { { actions.onOpenPicture(cacheKey) } },
                more = if (index == decoded.lastIndex) more else 0,
                modifier = Modifier.fillMaxSize(),
            )
            // Seen going, it stays to fill and shrink away once the picture is there.
            val phase = upload(index)
            var going by remember { mutableStateOf(false) }
            if (phase != null) going = true
            if (going) UploadRing(phase ?: UploadPhase.Done, onCancel = { onCancel(index) }, modifier = Modifier.matchParentSize())
        }
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
            // A kept picture read again once its download completes.
            val loads = visual.map { ref ->
                key(ref.key) {
                    if (ref.item.kind == "video") null else rememberMediaBytes(ref, actions.loadMedia, here = actions.kept?.phase(ref)?.isComplete == true)
                }
            }
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
                val kept = actions.kept
                if (ref.item.kind == "video") {
                    val poster = posters[index]
                    val frame = poster?.frame
                    val still = remember(frame) { frame?.asImageBitmap() }
                    val duration = poster?.seconds?.let(::formatDuration)
                    Box {
                        MediaTile(
                            bytes = null,
                            cacheKey = key,
                            contentDescription = ref.item.name.ifEmpty { stringResource(R.string.artifact_video) },
                            failed = false,
                            onClick = { if (kept != null) actions.play(key, ref) else actions.onOpenPicture(key) },
                            placeholder = still ?: thumbhash,
                            video = true,
                            // Kept, the ring is the play button and the badge says the length.
                            duration = if (kept == null) duration else null,
                            playButton = kept == null,
                            modifier = Modifier.fillMaxSize(),
                        )
                        if (kept != null) DownloadStatus(ref, kept, video = true, duration = duration, starting = actions.videos?.isStarting(key) == true, onPlay = { actions.play(key, ref) })
                    }
                } else {
                    val load = loads[index]
                    val bytes = load?.getOrNull()?.bytes
                    // Waiting for a tap, the ring says so; the tile isn't a failure.
                    val waiting = load?.exceptionOrNull() is NotKept || (kept != null && kept.phase(ref)?.let { !it.isComplete } == true)
                    Box {
                        MediaTile(
                            bytes = bytes,
                            cacheKey = key,
                            contentDescription = ref.item.name.ifEmpty { stringResource(R.string.conversation_picture) },
                            failed = load?.isFailure == true && !waiting,
                            onClick = bytes?.let { { actions.onOpenPicture(key) } },
                            placeholder = thumbhash,
                            modifier = Modifier.fillMaxSize(),
                        )
                        if (kept != null) DownloadStatus(ref, kept, video = false)
                    }
                }
            }
        }
        other.forEach { ref ->
            val opening = actions.mediaOpening(ref)
            val open = actions.onOpenMedia
            // Kept, its chip follows the download and the detail says how far it is (Telegram's file bubble).
            val kept = actions.kept
            if (kept != null) LaunchedEffect(ref.key) { kept.shown(ref) }
            val phase = kept?.phase(ref)
            InfoCard(
                icon = Ionicon.DocumentTextOutline,
                title = ref.item.name,
                detail = when {
                    opening is MediaOpening.Failed -> opening.reason
                    phase != null && !phase.isComplete -> MediaSizeText.text(phase)
                    opening is MediaOpening.Reading -> stringResource(R.string.conversation_media_reading)
                    open == null -> stringResource(R.string.conversation_file_unavailable)
                    // Here, its size, as Telegram's file bubble says.
                    else -> phase?.let(MediaSizeText::text)
                },
                onClick = open?.let { { it(ref) } },
                modifier = Modifier.testTag(ConversationRowTags.MEDIA_FILE),
                vertical = 0.dp,
                chip = kept?.let { { FileStatusChip(ref.key, phase, Ionicon.DocumentTextOutline, onTap = { it.toggle(ref) }) } },
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
private fun rememberMediaBytes(ref: MediaRef, load: suspend (MediaRef) -> ByteArray, here: Boolean = false): Result<MediaBytes>? {
    val bytes by produceState<Result<MediaBytes>?>(null, ref.key, here) {
        // What was read stays while it is read again.
        if (here && value?.isSuccess == true) return@produceState
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
    /** In the icon's place: a file's chip that follows its download. */
    chip: (@Composable () -> Unit)? = null,
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
        if (chip != null) chip() else Icon(icon, 22.dp, colors.textSecondary)
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
