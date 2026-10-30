package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.Activity
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.MediaRef
import com.slopus.happy.ui.chat.ChatComposer
import com.slopus.happy.ui.chat.ComposerStatus
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.chat.SessionStatusColors
import com.slopus.happy.ui.chat.resolvePrimaryAction
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.HeaderBackButton
import com.slopus.happy.ui.components.HeaderIconButton
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object ConversationScreenTags {
    const val SCREEN = "conversation.screen"
    const val LIST = "conversation.list"
    const val LOADING = "conversation.loading"
    const val EMPTY = "conversation.empty"
    const val ERROR = "conversation.error"
    const val READ_ONLY = "conversation.readOnly"
    const val OLDER = "conversation.older"
    const val COMPOSE = "conversation.header.compose"
    const val DETAILS = "conversation.header.details"
}

object ConversationScreenSpec {
    val placeholder = happyTextStyle(fontSize = 16, lineHeight = 24)
    val placeholderPadding = 32.dp
    val newestPadding = 8.dp
    val olderSlot = 32.dp
    val notice = happyTextStyle(fontSize = 14, lineHeight = 20)
}

/** What the conversation screen asks of whoever hosts it. */
class ConversationScreenActions(
    val onBack: () -> Unit = {},
    /** A new empty chat in place of this one. */
    val onCompose: () -> Unit = {},
    /** The chat's details; only once the chat exists. */
    val onDetails: () -> Unit = {},
    val onDraftChange: (String) -> Unit = {},
    /** True when the message was taken (the composer then clears). */
    val onSend: (String) -> Boolean = { false },
    val onStop: () -> Unit = {},
    val onRetrySend: (String) -> Unit = {},
    val onDiscardSend: (String) -> Unit = {},
    val onRetryFailure: (String) -> Unit = {},
    val onAnswer: suspend (questionId: String, answers: Map<String, List<String>>) -> Unit = { _, _ -> },
    val onLoadOlder: () -> Unit = {},
    val loadMedia: suspend (MediaRef) -> ByteArray = { throw IllegalStateException() },
    val onOpenArtifact: ((String) -> Unit)? = null,
    /** The newest message is on screen while the app is up: unread clears. */
    val onVisible: (Boolean) -> Unit = {},
)

/**
 * One conversation with a paired agent. Spec: the standard header (back;
 * the chat's title, or "New chat" before its first send, with the
 * connection's state under it in the header's subtitle while it isn't
 * live, never in the content; compose, then details once the chat
 * exists, 32 buttons with 22 icons), then the transcript, newest at the
 * bottom with 8 under it, and the dock above the keyboard and the
 * navigation bar: the open question ([ConversationQuestionCard]), then the
 * legacy composer (ChatComposer) whose status line is the working line
 * (blue dot pulsing while the agent works, orange while it waits on an
 * answer). Stop takes the round button while the agent works and the
 * composer is empty. A subagent or archived chat has no composer, a 14/20
 * textSecondary line in its place. Before history is read a 24 spinner
 * sits centred; a new chat and an empty one say so in 16/24 textSecondary,
 * 32 in; a chat that could not be read says why the same way.
 */
@Composable
fun ConversationScreen(
    state: ConversationState,
    connection: String?,
    actions: ConversationScreenActions,
    modifier: Modifier = Modifier,
    bubbleColor: String? = null,
) {
    val colors = HappyTheme.colors
    val listState = rememberLazyListState()
    // The composer's text: this screen's while typing; a draft from elsewhere replaces it.
    var text by rememberSaveable { mutableStateOf(state.draft) }
    var arrivals by rememberSaveable { mutableStateOf(state.draftArrivals) }
    if (state.draftArrivals != arrivals) {
        arrivals = state.draftArrivals
        text = state.draft
    }
    val bubble = userMessageBubblePalette(bubbleColor, colors.dark)
    val legacy = remember(actions) {
        MessageCallbacks(
            onOptionPress = { actions.onSend(it) },
            onRetry = actions.onRetrySend,
            onDiscard = actions.onDiscardSend,
        )
    }
    val rowActions = remember(actions, legacy) {
        ConversationRowActions(legacy, actions.onRetryFailure, actions.loadMedia, actions.onOpenArtifact)
    }
    val atNewest by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 } }
    val visible by rememberUpdatedState(actions.onVisible)
    LaunchedEffect(atNewest, state.created) { if (state.created) visible(atNewest) }

    Column(modifier.testTag(ConversationScreenTags.SCREEN).fillMaxSize().background(colors.surface)) {
        Header(
            title = state.title ?: stringResource(if (state.created && state.loaded) R.string.conversation_untitled else R.string.conversation_compose),
            subtitle = connection,
            scrolled = listState.canScrollForward,
            left = { HeaderBackButton(actions.onBack) },
            right = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.testTag(ConversationScreenTags.COMPOSE)) {
                        HeaderIconButton(Ionicon.CreateOutline, stringResource(R.string.conversation_compose), actions.onCompose)
                    }
                    if (state.created) Box(Modifier.testTag(ConversationScreenTags.DETAILS)) {
                        HeaderIconButton(Ionicon.InformationCircleOutline, stringResource(R.string.conversation_details), actions.onDetails)
                    }
                }
            },
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                !state.loaded -> CircularProgressIndicator(
                    color = colors.textSecondary,
                    strokeWidth = 2.dp,
                    modifier = Modifier.align(Alignment.Center).size(24.dp).testTag(ConversationScreenTags.LOADING),
                )
                state.rows.isEmpty() -> Placeholder(
                    text = state.error?.let { stringResource(R.string.conversation_load_failed) + "\n" + it }
                        ?: stringResource(if (state.created) R.string.conversation_empty else R.string.conversation_empty_new),
                    tag = if (state.error != null) ConversationScreenTags.ERROR else ConversationScreenTags.EMPTY,
                )
                else -> Transcript(state, listState, bubble, rowActions, actions.onLoadOlder)
            }
        }
        Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).imePadding()) {
            state.question?.let { question ->
                ConversationQuestionCard(question, onAnswer = { answers -> actions.onAnswer(question.id, answers) })
            }
            if (state.created && !state.canSend) {
                Text(
                    stringResource(if (state.agent?.archivedAt != null) R.string.conversation_archived else R.string.conversation_read_only),
                    style = ConversationScreenSpec.notice,
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(16.dp).testTag(ConversationScreenTags.READ_ONLY),
                )
            } else {
                val hasText = text.isNotBlank()
                ChatComposer(
                    text = text,
                    onTextChange = {
                        text = it
                        actions.onDraftChange(it)
                    },
                    status = activityStatus(state.activity),
                    primary = primaryActionOf(hasText, state),
                    aborting = state.stopping,
                    onPrimary = {
                        if (hasText) {
                            if (actions.onSend(text)) text = ""
                        } else if (state.working) {
                            actions.onStop()
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun activityStatus(activity: Activity?): ComposerStatus? {
    activity ?: return null
    val text = stringResource(
        when (activity) {
            Activity.AwaitingAnswer -> R.string.conversation_activity_awaiting_answer
            Activity.WaitingForModel -> R.string.conversation_activity_waiting_for_model
            Activity.Thinking -> R.string.conversation_activity_thinking
            Activity.PreparingTools -> R.string.conversation_activity_preparing_tools
            Activity.RunningTools -> R.string.conversation_activity_running_tools
            Activity.Working -> R.string.conversation_activity_working
            Activity.Delegating -> R.string.conversation_activity_delegating
        },
    )
    val color = if (activity == Activity.AwaitingAnswer) SessionStatusColors.attention else SessionStatusColors.thinking
    return ComposerStatus(text, color, pulsing = true)
}

@Composable
private fun Placeholder(text: String, tag: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text,
            style = ConversationScreenSpec.placeholder,
            color = HappyTheme.colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(ConversationScreenSpec.placeholderPadding).contentMaxWidth(LocalWindowLayout.current).testTag(tag),
        )
    }
}

@Composable
private fun Transcript(
    state: ConversationState,
    listState: androidx.compose.foundation.lazy.LazyListState,
    bubble: com.slopus.happy.ui.chat.BubblePalette,
    actions: ConversationRowActions,
    onLoadOlder: () -> Unit,
) {
    val nearOldest by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: return@derivedStateOf true
            last >= info.totalItemsCount - 1 - info.visibleItemsInfo.size
        }
    }
    val loadOlder by rememberUpdatedState(onLoadOlder)
    LaunchedEffect(nearOldest, state.hasMore, state.loadingOlder) {
        if (nearOldest && state.hasMore && !state.loadingOlder) loadOlder()
    }
    LazyColumn(
        state = listState,
        reverseLayout = true,
        contentPadding = PaddingValues(bottom = ConversationScreenSpec.newestPadding),
        modifier = Modifier.fillMaxSize().testTag(ConversationScreenTags.LIST),
    ) {
        items(state.rows, key = ConversationRow::key, contentType = { it::class }) { row ->
            ConversationRowView(row, bubble, actions)
        }
        item(key = "older", contentType = "older") {
            Box(Modifier.fillMaxWidth().heightIn(min = ConversationScreenSpec.olderSlot).testTag(ConversationScreenTags.OLDER), contentAlignment = Alignment.Center) {
                if (state.loadingOlder) CircularProgressIndicator(Modifier.size(16.dp), color = HappyTheme.colors.textSecondary, strokeWidth = 2.dp)
            }
        }
    }
}

/** The send/stop button the composer shows; kept beside the screen for its tests. */
internal fun primaryActionOf(hasText: Boolean, state: ConversationState): PrimaryAction =
    resolvePrimaryAction(hasContent = hasText, showAbort = state.working, canAbort = state.created, blocked = false)
