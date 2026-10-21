package com.slopus.happy.ui.chat

import android.content.ClipData
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.AgentEvent
import com.slopus.happy.chat.AgentQuestionAnswer
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.PermissionStatus
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.UserDisplay
import com.slopus.happy.ui.attachments.FileMessageView
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

object MessageTags {
    const val USER = "message.user"
    const val USER_AUTHOR = "message.user.author"
    const val USER_BODY = "message.user.body"
    const val USER_BUBBLE = "message.user.bubble"
    const val USER_STATUS = "message.user.status"
    const val USER_FAILED = "message.user.failed"
    const val USER_RETRY = "message.user.retry"
    const val USER_DISCARD = "message.user.discard"
    const val COMMAND_CHIP = "message.user.command"
    const val GOAL_ROW = "message.user.goal"
    const val AGENT = "message.agent"
    const val AGENT_COPY = "message.agent.copy"
    const val EVENT = "message.event"
}

/** MessageView.tsx's stylesheet. */
object MessageSpec {
    val userPaddingHorizontal = 16.dp
    val userPaddingTop = 6.dp
    val bubblePaddingHorizontal = 12.dp
    val bubblePaddingVertical = 4.dp
    val bubbleRadius = 12.dp
    val bubbleMarginBottom = 4.dp
    /** Goal and command bubbles keep 6 below, above their chip or row. */
    val bubbleMarginBottomAnnotated = 6.dp
    const val PENDING_OPACITY = 0.45f
    const val PENDING_STATUS_GRACE_MS = 2_000L
    val status = happyTextStyle(fontSize = 11, lineHeight = 14)
    val statusHeight = 14.dp
    val statusMarginTop = 2.dp
    val statusMarginBottom = 4.dp
    /** A failed send's status, Retry and Discard sit 12 apart on the status line (Android only). */
    val failedGap = 12.dp
    val failedAction = happyTextStyle(fontSize = 11, lineHeight = 14, weight = FontWeight.SemiBold)
    val author = happyTextStyle(fontSize = 14, lineHeight = 20, weight = FontWeight.SemiBold)
    val authorMarginBottom = 4.dp
    val authorPaddingHorizontal = 12.dp
    val goalGap = 8.dp
    val goalIcon = 16.dp
    const val GOAL_OPACITY = 0.72f
    val goalText = happyTextStyle(fontSize = 14)
    val chipPaddingHorizontal = 10.dp
    val chipPaddingVertical = 2.dp
    val chipRadius = 10.dp
    const val CHIP_OPACITY = 0.65f
    val chipText = happyTextStyle(fontSize = 13, family = PlexMono)
    val agentMarginHorizontal = 16.dp
    val agentMarginVertical = 10.dp
    val copyHeight = 20.dp
    val copyIcon = 16.dp
    val eventMarginHorizontal = 8.dp
    val eventPaddingVertical = 8.dp
    val eventText = happyTextStyle(fontSize = 14)
}

/** What a row needs from the screen. */
class MessageCallbacks(
    /** Pressing an `<options>` choice sends it as the next message. */
    val onOptionPress: (String) -> Unit = {},
    val onToolPress: (ChatMessage.ToolCallMessage) -> Unit = {},
    /** A patch tool's file card, by the patch's own file key; null leaves the cards inert. */
    val onToolFilePress: ((ChatMessage.ToolCallMessage, String) -> Unit)? = null,
    /** Answers a tool's permission request; [mode] is the permission mode the composer switches to after. */
    val onPermission: PermissionHandler = { _, _ -> },
    /** A failed send, by its localId. */
    val onRetry: (String) -> Unit = {},
    val onDiscard: (String) -> Unit = {},
    /** Answers / dismisses an agent communication; throws on failure. */
    val onAnswerQuestion: suspend (communicationId: String, answers: Map<String, AgentQuestionAnswer>, kind: String) -> Unit = { _, _, _ -> },
    val onCancelQuestion: suspend (communicationId: String, kind: String) -> Unit = { _, _ -> },
)

/**
 * Called with a row's key every time that row composes (a tool's body
 * reports "tool:" and its id too). Tests use it to pin that a changed
 * message recomposes its own row and nothing else.
 */
val LocalChatRowObserver = staticCompositionLocalOf<((String) -> Unit)?> { null }

/** One chat row, dispatched by kind (MessageView.tsx `RenderBlock`). */
@Composable
fun MessageView(row: ChatRow, bubble: BubblePalette, callbacks: MessageCallbacks, modifier: Modifier = Modifier) {
    LocalChatRowObserver.current?.let { observe -> SideEffect { observe(row.key) } }
    // `messageContainer` / `messageContent`: each message centred and held to layout.maxWidth.
    val layout = LocalWindowLayout.current
    Box(modifier.fillMaxWidth()) {
        val content = Modifier.contentMaxWidth(layout)
        when (row) {
            is ChatRow.User -> UserMessage(row, bubble, callbacks, content)
            is ChatRow.AgentText -> AgentMessage(row, callbacks, content)
            is ChatRow.Event -> EventMessage(row.message.event, content)
            is ChatRow.Tool -> if (row.message.tool.name == "file") FileMessageView(row.message.tool.input, content) else ToolView(row.message, callbacks, content)
        }
    }
}

/**
 * A user message (`UserMessageFrame` + `UserTextBlock`). Spec: the column
 * is right-aligned with 16 side padding and 6 on top (left-aligned for
 * another participant, with their name above in 14/20 semibold, 12 in, 4
 * below). The bubble: palette background with a hairline border in the
 * palette's border colour, padding 12/4, radius 12, 4 below (6 above a
 * goal row or command chip), markdown inside. A pending message is dimmed
 * to 0.45 once its status shows: at once when queued behind a busy turn,
 * else after a 2 s grace from creation. The status line (11/14, always 14
 * high, 2 above and 4 below, agentEventText; textDestructive for a refusal)
 * says "Sending…", "Sends after this turn" or "Not sent: reason".
 * Goal: the goal in the bubble, then locate-outline 16 and "Sent as goal"
 * (14, agentEventText) 8 apart at 0.72. Command: its args in a bubble if
 * any, then a chip "/name" (mono 13, input text) with padding 10/2, radius
 * 10, a 1 divider border, at 0.65. Long press opens the Copy menu
 * ([LongPressCopyable]).
 */
@Composable
fun UserMessage(row: ChatRow.User, bubble: BubblePalette, callbacks: MessageCallbacks, modifier: Modifier = Modifier) {
    val message = row.message
    val colors = HappyTheme.colors
    val chat = ChatTheme.colors
    val fromOther = message.isOtherParticipant
    val showPending = rememberPendingStatusVisible(message.pending, message.meta?.queuedWhileBusy == true, message.createdAt)
    val copyText = when (val display = row.display) {
        is UserDisplay.Text -> display.text
        is UserDisplay.Goal -> display.goal
        is UserDisplay.Command -> if (display.args != null) "/${display.commandName} ${display.args}" else "/${display.commandName}"
    }
    val alignment = if (fromOther) Alignment.Start else Alignment.End
    val statusText = when {
        message.sendError != null -> stringResource(R.string.message_send_failed, message.sendError)
        showPending && message.meta?.queuedWhileBusy == true -> stringResource(R.string.message_sends_after_this_turn)
        showPending -> stringResource(R.string.message_sending)
        else -> ""
    }
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    val bubbleShape = RoundedCornerShape(MessageSpec.bubbleRadius)

    @Composable
    fun Bubble(blocks: List<com.slopus.happy.chat.markdown.MarkdownBlock>, marginBottom: Dp) {
        Box(
            modifier = Modifier
                .padding(bottom = marginBottom)
                .testTag(MessageTags.USER_BUBBLE)
                .clip(bubbleShape)
                .background(bubble.background)
                .border(hairline, bubble.border, bubbleShape)
                .padding(horizontal = MessageSpec.bubblePaddingHorizontal, vertical = MessageSpec.bubblePaddingVertical),
        ) {
            MarkdownView(blocks, onOptionPress = callbacks.onOptionPress)
        }
    }

    Column(
        modifier = modifier
            .testTag(MessageTags.USER)
            .fillMaxWidth()
            .padding(horizontal = MessageSpec.userPaddingHorizontal)
            .padding(top = MessageSpec.userPaddingTop),
        horizontalAlignment = alignment,
    ) {
        if (fromOther) {
            Text(
                text = message.author?.name.orEmpty(),
                style = MessageSpec.author,
                color = colors.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .padding(bottom = MessageSpec.authorMarginBottom)
                    .testTag(MessageTags.USER_AUTHOR)
                    .padding(horizontal = MessageSpec.authorPaddingHorizontal),
            )
        }
        LongPressCopyable(
            text = copyText,
            modifier = Modifier
                .testTag(MessageTags.USER_BODY)
                .alpha(if (showPending) MessageSpec.PENDING_OPACITY else 1f),
            horizontalAlignment = alignment,
        ) {
            when (val display = row.display) {
                is UserDisplay.Text -> Bubble(display.blocks, MessageSpec.bubbleMarginBottom)
                is UserDisplay.Goal -> {
                    Bubble(display.blocks, MessageSpec.bubbleMarginBottomAnnotated)
                    Row(
                        modifier = Modifier
                            .padding(bottom = 4.dp)
                            .testTag(MessageTags.GOAL_ROW)
                            .alpha(MessageSpec.GOAL_OPACITY),
                        horizontalArrangement = Arrangement.spacedBy(MessageSpec.goalGap),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Ionicon.LocateOutline, MessageSpec.goalIcon, chat.agentEventText)
                        Text(stringResource(R.string.message_sent_as_goal), style = MessageSpec.goalText, color = chat.agentEventText)
                    }
                }
                is UserDisplay.Command -> {
                    if (display.args != null) Bubble(display.argBlocks, MessageSpec.bubbleMarginBottomAnnotated)
                    val chipShape = RoundedCornerShape(MessageSpec.chipRadius)
                    Box(
                        modifier = Modifier
                            .padding(bottom = 4.dp)
                            .testTag(MessageTags.COMMAND_CHIP)
                            .alpha(MessageSpec.CHIP_OPACITY)
                            .clip(chipShape)
                            .background(bubble.background)
                            .border(1.dp, colors.divider, chipShape)
                            .padding(horizontal = MessageSpec.chipPaddingHorizontal, vertical = MessageSpec.chipPaddingVertical),
                    ) {
                        Text("/${display.commandName}", style = MessageSpec.chipText, color = colors.input.text)
                    }
                }
            }
        }
        val failed = row.failedLocalId
        if (failed == null) {
            StatusLine(statusText, if (message.sendError != null) colors.textDestructive else chat.agentEventText)
        } else {
            Row(
                modifier = Modifier.testTag(MessageTags.USER_FAILED),
                horizontalArrangement = Arrangement.spacedBy(MessageSpec.failedGap),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StatusLine(statusText, colors.textDestructive, Modifier.weight(1f, fill = false))
                FailedAction(stringResource(R.string.common_retry), MessageTags.USER_RETRY) { callbacks.onRetry(failed) }
                FailedAction(stringResource(R.string.common_discard), MessageTags.USER_DISCARD) { callbacks.onDiscard(failed) }
            }
        }
    }
}

@Composable
private fun StatusLine(text: String, color: Color, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MessageSpec.status,
        color = color,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier
            .padding(top = MessageSpec.statusMarginTop, bottom = MessageSpec.statusMarginBottom)
            .testTag(MessageTags.USER_STATUS)
            .heightIn(min = MessageSpec.statusHeight),
    )
}

/** A failed send's Retry / Discard: the status line's size, semibold, in the text colour. */
@Composable
private fun FailedAction(label: String, tag: String, onClick: () -> Unit) {
    Text(
        text = label,
        style = MessageSpec.failedAction,
        color = HappyTheme.colors.text,
        maxLines = 1,
        modifier = Modifier
            .padding(top = MessageSpec.statusMarginTop, bottom = MessageSpec.statusMarginBottom)
            .testTag(tag)
            .heightIn(min = MessageSpec.statusHeight)
            .clickable(role = Role.Button, onClick = onClick),
    )
}

/** Puts plain text on the clipboard (expo-clipboard `setStringAsync`). */
@Composable
internal fun rememberCopyText(): (String) -> Unit {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    return remember(clipboard, scope) {
        { text -> scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(text, text))) } }
    }
}

/** `usePendingStatusVisible`: queued sends say so at once, others after the grace period. */
@Composable
private fun rememberPendingStatusVisible(pending: Boolean, queuedWhileBusy: Boolean, createdAt: Long): Boolean {
    val delayed = pending && !queuedWhileBusy
    var graceElapsed by remember(createdAt, delayed) {
        mutableStateOf(delayed && System.currentTimeMillis() - createdAt >= MessageSpec.PENDING_STATUS_GRACE_MS)
    }
    LaunchedEffect(createdAt, delayed) {
        if (!delayed || graceElapsed) return@LaunchedEffect
        delay(MessageSpec.PENDING_STATUS_GRACE_MS - (System.currentTimeMillis() - createdAt))
        graceElapsed = true
    }
    return pending && (queuedWhileBusy || graceElapsed)
}

/**
 * Agent text (`AgentTextBlock`). Spec: 16 side margins, 10 above and below;
 * the markdown, selectable; under it a copy button the width of its 16
 * glyph and 20 high at the text's left edge, copy-outline swapping to a
 * checkmark for 1.5 s after a copy.
 */
@Composable
fun AgentMessage(row: ChatRow.AgentText, callbacks: MessageCallbacks, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = MessageSpec.agentMarginHorizontal, vertical = MessageSpec.agentMarginVertical)
            .testTag(MessageTags.AGENT),
    ) {
        SelectionContainer {
            MarkdownView(row.blocks, modifier = Modifier.fillMaxWidth(), onOptionPress = callbacks.onOptionPress)
        }
        MessageCopyButton(row.message.text)
    }
}

@Composable
private fun MessageCopyButton(text: String) {
    val copy = rememberCopyText()
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1500)
            copied = false
        }
    }
    Box(
        modifier = Modifier
            .testTag(MessageTags.AGENT_COPY)
            .height(MessageSpec.copyHeight)
            .clickable(role = Role.Button, onClickLabel = stringResource(R.string.common_copy)) {
                copy(text)
                copied = true
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon = if (copied) Ionicon.Checkmark else Ionicon.CopyOutline,
            size = MessageSpec.copyIcon,
            color = HappyTheme.colors.text,
            contentDescription = stringResource(if (copied) R.string.common_copied else R.string.common_copy),
        )
    }
}

/**
 * An agent event (`AgentEventBlock`). Spec: 8 side margins, 8 above and
 * below, centred 14pt text in agentEventText: the mode switch, the agent's
 * message, the usage limit's end time, or "Unknown event".
 */
@Composable
fun EventMessage(event: AgentEvent, modifier: Modifier = Modifier) {
    val text = when (event) {
        is AgentEvent.Switch -> stringResource(R.string.message_switched_to_mode, event.mode)
        is AgentEvent.Message -> event.message
        is AgentEvent.LimitReached -> stringResource(
            R.string.message_usage_limit_until,
            DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(event.endsAt * 1000)),
        )
        else -> stringResource(R.string.message_unknown_event)
    }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = MessageSpec.eventMarginHorizontal)
            .testTag(MessageTags.EVENT)
            .padding(vertical = MessageSpec.eventPaddingVertical),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = MessageSpec.eventText, color = ChatTheme.colors.agentEventText, textAlign = TextAlign.Center)
    }
}

