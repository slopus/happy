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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.Activity
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.MediaRef
import com.slopus.happy.conversation.Mode
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.SessionStatusColors
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.chat.resolvePrimaryAction
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.StateArt
import com.slopus.happy.ui.components.StatePage
import com.slopus.happy.ui.components.TitleWithStatus
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import com.slopus.happy.ui.components.GlassSource
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.components.glassFade
import com.slopus.happy.ui.components.glassSource
import com.slopus.happy.ui.components.rememberGlassBlur
import com.slopus.happy.ui.components.rememberGlassSource
import java.io.File

object ConversationScreenTags {
    const val SCREEN = "conversation.screen"
    const val BAR = "conversation.bar"
    const val TITLE = "conversation.bar.title"
    const val SUBTITLE = "conversation.bar.subtitle"
    const val BACK = "conversation.bar.back"
    const val LIST = "conversation.list"
    const val LOADING = "conversation.loading"
    const val EMPTY = "conversation.empty"
    const val ERROR = "conversation.error"
    const val READ_ONLY = "conversation.readOnly"
    const val OLDER = "conversation.older"
    const val OLDER_FAILED = "conversation.older.failed"
    const val OLDER_RETRY = "conversation.older.retry"
    const val COMPOSE = "conversation.header.compose"
    const val COMPOSE_ICON = "conversation.header.compose.icon"
    const val MORE = "conversation.header.more"
    const val MENU = "conversation.header.menu"
    const val DETAILS = "conversation.header.details"
    /** The fade behind the dock. */
    const val FADE = "conversation.fade"
}

class ConversationScreenActions(
    val onBack: () -> Unit = {},
    /** A new empty chat in place of this one. */
    val onCompose: () -> Unit = {},
    /** The chat's details; only once the chat exists. */
    val onDetails: () -> Unit = {},
    val onDraftChange: (String) -> Unit = {},
    /** The words and the attached pictures' files; true when the message was taken (the composer then clears). */
    val onSend: (String, List<File>) -> Boolean = { _, _ -> false },
    /** The composer picked another model, effort or permission mode. */
    val onModeChange: (Mode) -> Unit = {},
    val onStop: () -> Unit = {},
    val onRetrySend: (String) -> Unit = {},
    val onDiscardSend: (String) -> Unit = {},
    val onRetryFailure: (String) -> Unit = {},
    val onAnswer: suspend (questionId: String, answers: Map<String, List<String>>) -> Unit = { _, _ -> },
    /** Older history; `retry` after a failed page (Retry), which nothing else asks again. */
    val onLoadOlder: (retry: Boolean) -> Unit = {},
    /** History could not be read: ask again. */
    val onRetryLoad: () -> Unit = {},
    val loadMedia: suspend (MediaRef) -> ByteArray = { throw IllegalStateException() },
    val onOpenArtifact: ((String) -> Unit)? = null,
    /** The newest message is on screen while the app is up: unread clears. */
    val onVisible: (Boolean) -> Unit = {},
    /** How a secret request is made and answered; null where this build cannot. */
    val secrets: SecretRequestActions? = null,
)

/**
 * One conversation with a paired agent, in Android's own forms: a Material 3
 * top app bar in the transcript's surface colour, scrolled or not (back
 * arrow; the chat's title, or "New chat" before its first send, with the
 * connection or activity state always under it, never in the content;
 * compose, then a three-dot menu for permissions and chat details), the transcript newest at
 * the bottom, and the dock above the keyboard and navigation bar: the open
 * question ([ConversationQuestionCard]), then [ConversationComposer]. A
 * subagent or archived chat has a line saying so instead. Past the oldest
 * row a 32 slot: a spinner while a page loads; after a failed page
 * "Couldn't load earlier messages." and a Retry text button, and nothing
 * asks again until Retry. Before history is read a spinner sits centred; a
 * new chat, an empty one and one that could not be read say so in
 * bodyLarge, 32 in.
 */
@OptIn(ExperimentalMaterial3Api::class)
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
            onOptionPress = { actions.onSend(it, emptyList()) },
            onRetry = actions.onRetrySend,
            onDiscard = actions.onDiscardSend,
        )
    }
    val pictures = rememberPictureViewer()
    val media = rememberMediaOpener()
    val rowActions = remember(actions, legacy, pictures, media) {
        ConversationRowActions(
            legacy = legacy,
            onRetryFailure = actions.onRetryFailure,
            loadMedia = actions.loadMedia,
            onOpenArtifact = actions.onOpenArtifact,
            onOpenPicture = pictures::show,
            onOpenMedia = { ref -> media.open(ref.key, ref.item) { actions.loadMedia(ref) } },
            mediaOpening = { ref -> media.state(ref.key) },
        )
    }
    val atNewest by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 } }
    val visible by rememberUpdatedState(actions.onVisible)
    LaunchedEffect(atNewest, state.created) { if (state.created) visible(atNewest) }

    Column(modifier.testTag(ConversationScreenTags.SCREEN).fillMaxSize().background(colors.surface)) {
        TopAppBar(
            title = {
                // One status line, under the title and nowhere else: the
                // connection while it isn't live, otherwise what the agent
                // is doing. Its room is always kept, so neither the title nor
                // the transcript moves when the link or the work changes.
                val working = activityLabel(state.activity)
                val syncing = state.syncing || (state.created && !state.loaded)
                val dot = when {
                    connection != null -> null
                    syncing -> colors.status.connecting
                    state.activity == null -> colors.status.connected
                    state.activity == Activity.AwaitingAnswer -> SessionStatusColors.attention
                    else -> SessionStatusColors.thinking
                }
                val style = MaterialTheme.typography.bodySmall
                TitleWithStatus(
                    status = BarStatus(
                        connection ?: if (syncing) stringResource(R.string.status_syncing)
                        else working ?: stringResource(R.string.status_online),
                        dot,
                        connection == null && (syncing || state.activity != null),
                    ),
                    statusStyle = style,
                    title = {
                        // An existing chat is never "New chat", not even before it's read: blank until then.
                        Text(
                            state.title ?: when {
                                !state.created -> stringResource(R.string.conversation_compose)
                                state.loaded -> stringResource(R.string.conversation_untitled)
                                else -> ""
                            },
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.testTag(ConversationScreenTags.TITLE),
                        )
                    },
                ) { status ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier
                            .testTag(ConversationScreenTags.SUBTITLE)
                            .semantics { liveRegion = LiveRegionMode.Polite },
                    ) {
                        status.dot?.let { StatusDot(it, pulsing = status.pulsing) }
                        Text(status.text, style = style, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            },
            navigationIcon = {
                IconButton(onClick = actions.onBack, modifier = Modifier.testTag(ConversationScreenTags.BACK)) {
                    Icon(MaterialSymbols.ArrowBack, stringResource(R.string.conversation_back))
                }
            },
            actions = {
                ConversationHeaderActions(state, actions)
            },
            // One surface with the transcript, light and dark: no tint when it scrolls under.
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = colors.surface,
                scrolledContainerColor = colors.surface,
                titleContentColor = colors.text,
                navigationIconContentColor = colors.text,
                actionIconContentColor = colors.text,
            ),
            modifier = Modifier.testTag(ConversationScreenTags.BAR),
        )
        // The dock floats over the transcript, which scrolls on under its glass; the list keeps the
        // dock's height free at its newest end, so the last message is never left under it.
        val glass = rememberGlassSource()
        val blurs = rememberGlassBlur()
        var dock by remember { mutableIntStateOf(0) }
        val dockHeight = with(LocalDensity.current) { dock.toDp() }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                !state.loaded -> StatePage(
                    title = null,
                    body = null,
                    art = StateArt.Waiting,
                    tag = ConversationScreenTags.LOADING,
                    modifier = Modifier.padding(bottom = dockHeight),
                )
                state.error != null && state.rows.isEmpty() -> StatePage(
                    title = stringResource(R.string.conversation_load_failed),
                    body = state.error,
                    icon = Ionicon.CloudOfflineOutline,
                    action = stringResource(R.string.common_retry) to actions.onRetryLoad,
                    tag = ConversationScreenTags.ERROR,
                    modifier = Modifier.padding(bottom = dockHeight),
                )
                state.rows.isEmpty() -> StatePage(
                    title = null,
                    body = stringResource(if (state.created) R.string.conversation_empty else R.string.conversation_empty_new),
                    art = StateArt.Ready,
                    tag = ConversationScreenTags.EMPTY,
                    modifier = Modifier.padding(bottom = dockHeight),
                )
                else -> Transcript(state, listState, bubble, rowActions, actions.onLoadOlder, dockHeight, glass)
            }
            // What scrolls under the dock goes soft and pale over its top 32, Telegram's way, full width.
            Box(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(dockHeight + GlassSpec.fade)
                    .glassFade(glass, colors.surface, blurs)
                    .testTag(ConversationScreenTags.FADE),
            )
            Column(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .onSizeChanged { dock = it.height }
                    .windowInsetsPadding(WindowInsets.navigationBars)
                    .imePadding(),
            ) {
                state.question?.let { question ->
                    ConversationQuestionCard(
                        question = question,
                        onAnswer = { answers -> actions.onAnswer(question.id, answers) },
                        secrets = actions.secrets,
                        // Half the screen at most, so a short one keeps the bar and the composer in view.
                        maxHeight = minOf(ConversationQuestionSpec.maxHeight, androidx.compose.ui.platform.LocalConfiguration.current.screenHeightDp.dp / 2),
                    )
                }
                if (state.created && !state.canSend) {
                    Text(
                        stringResource(if (state.agent?.archivedAt != null) R.string.conversation_archived else R.string.conversation_read_only),
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textSecondary,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.contentMaxWidth(LocalWindowLayout.current).padding(16.dp).testTag(ConversationScreenTags.READ_ONLY),
                    )
                } else {
                    ConversationComposer(
                        state = state,
                        text = text,
                        onTextChange = {
                            text = it
                            actions.onDraftChange(it)
                        },
                        onSend = actions.onSend,
                        onSent = { text = "" },
                        onStop = actions.onStop,
                        onModeChange = actions.onModeChange,
                        // The same centred column as the messages; the bar above stays full width.
                        modifier = Modifier.contentMaxWidth(LocalWindowLayout.current),
                        backdrop = glass,
                    )
                }
            }
            PictureViewerHost(pictures)
        }
    }
}

@Composable
private fun Transcript(
    state: ConversationState,
    listState: androidx.compose.foundation.lazy.LazyListState,
    bubble: com.slopus.happy.ui.chat.BubblePalette,
    actions: ConversationRowActions,
    onLoadOlder: (retry: Boolean) -> Unit,
    /** The dock's height over the list's newest end, kept clear. */
    dock: Dp,
    glass: GlassSource,
) {
    val nearOldest by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: return@derivedStateOf true
            last >= info.totalItemsCount - 1 - info.visibleItemsInfo.size
        }
    }
    val loadOlder by rememberUpdatedState(onLoadOlder)
    LaunchedEffect(nearOldest, state.hasMore, state.loadingOlder, state.olderFailed) {
        if (nearOldest && state.hasMore && !state.loadingOlder && !state.olderFailed) loadOlder(false)
    }
    LazyColumn(
        state = listState,
        reverseLayout = true,
        contentPadding = PaddingValues(bottom = dock + 8.dp),
        modifier = Modifier.fillMaxSize().glassSource(glass).testTag(ConversationScreenTags.LIST),
    ) {
        items(state.rows, key = ConversationRow::key, contentType = { it::class }) { row ->
            ConversationRowView(row, bubble, actions)
        }
        item(key = "older", contentType = "older") {
            Box(Modifier.fillMaxWidth().heightIn(min = 32.dp).testTag(ConversationScreenTags.OLDER), contentAlignment = Alignment.Center) {
                when {
                    state.loadingOlder -> CircularProgressIndicator(Modifier.size(16.dp), color = HappyTheme.colors.textSecondary, strokeWidth = 2.dp)
                    state.olderFailed -> Row(
                        Modifier.testTag(ConversationScreenTags.OLDER_FAILED),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(stringResource(R.string.conversation_older_failed), style = MaterialTheme.typography.bodySmall, color = HappyTheme.colors.textSecondary)
                        TextButton(onClick = { onLoadOlder(true) }, modifier = Modifier.testTag(ConversationScreenTags.OLDER_RETRY)) {
                            Text(stringResource(R.string.common_retry))
                        }
                    }
                }
            }
        }
    }
}

/** The bar's status line: its words, dot and whether the dot pulses. */
private data class BarStatus(val text: String, val dot: Color?, val pulsing: Boolean)

/** What the agent is doing, as the bar's status line says it. */
@Composable
internal fun activityLabel(activity: Activity?): String? = activity?.let {
    stringResource(
        when (it) {
            Activity.AwaitingAnswer -> R.string.conversation_activity_awaiting_answer
            Activity.WaitingForModel -> R.string.conversation_activity_waiting_for_model
            Activity.Thinking -> R.string.conversation_activity_thinking
            Activity.PreparingTools -> R.string.conversation_activity_preparing_tools
            Activity.RunningTools -> R.string.conversation_activity_running_tools
            Activity.Working -> R.string.conversation_activity_working
            Activity.Delegating -> R.string.conversation_activity_delegating
        },
    )
}

/** The send/stop button the composer shows; kept beside the screen for its tests. */
internal fun primaryActionOf(hasContent: Boolean, state: ConversationState): PrimaryAction =
    resolvePrimaryAction(hasContent = hasContent, showAbort = state.working, canAbort = state.created, blocked = false)
