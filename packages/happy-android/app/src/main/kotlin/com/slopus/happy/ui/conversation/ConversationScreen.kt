package com.slopus.happy.ui.conversation

import com.slopus.happy.ui.tablet.BackOrSidebarToggle
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.wrapContentHeight
import com.slopus.happy.conversation.SlashCommands
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import com.slopus.happy.connection.LinkState
import com.slopus.happy.ui.chat.CodeCopy
import com.slopus.happy.ui.chat.LinkSpinner
import com.slopus.happy.ui.chat.LinkStatusSpec
import com.slopus.happy.ui.chat.LocalCodeCopy
import com.slopus.happy.ui.chat.LocalMessageLift
import com.slopus.happy.ui.chat.MessageLift
import com.slopus.happy.ui.chat.MessageLiftOverlay
import com.slopus.happy.ui.chat.MessageLiftSpec
import com.slopus.happy.ui.chat.liftBackdrop
import com.slopus.happy.ui.chat.liftClear
import com.slopus.happy.ui.chat.linkStatusWords
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.Activity
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.ConversationViewing
import com.slopus.happy.conversation.MediaRef
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.NewWork
import com.slopus.happy.conversation.WorkChoice
import com.slopus.happy.ui.chat.NewWorkChoicePanel
import com.slopus.happy.ui.chat.NewWorkRoom
import com.slopus.happy.ui.chat.art
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.SessionStatusColors
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.chat.resolvePrimaryAction
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.components.GlassBarLayout
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.ShimmerSpec
import com.slopus.happy.ui.components.ShimmerText
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.StateArt
import com.slopus.happy.ui.components.StatePage
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.components.TitleWithStatus
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import com.slopus.happy.ui.components.GlassSource
import com.slopus.happy.ui.components.RecomposeProbe
import com.slopus.happy.ui.chat.ListReveal
import com.slopus.happy.ui.chat.LocalRevealHost
import com.slopus.happy.ui.chat.RevealHost
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.graphics.graphicsLayer
import com.slopus.happy.ui.components.glassFade
import com.slopus.happy.ui.components.glassSource
import com.slopus.happy.ui.components.rememberGlassBlur
import com.slopus.happy.ui.components.rememberGlassSource
import java.io.File

object ConversationScreenTags {
    const val SCREEN = "conversation.screen"
    const val BAR = "conversation.bar"
    const val TITLE = "conversation.bar.title"
    /** The title and status together: a tap opens the agent page. */
    const val TITLE_BUTTON = "conversation.bar.titleButton"
    const val SUBTITLE = "conversation.bar.subtitle"
    const val STATUS = "conversation.bar.status"
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
    /** The fade behind the dock. */
    const val FADE = "conversation.fade"

    /** [RecomposeProbe] marks: the screen, the bar's title, the dock, the composer, the transcript and each row (`row:<key>`). */
    const val PROBE_SCREEN = "screen"
    const val PROBE_BAR = "bar"
    const val PROBE_DOCK = "dock"
    const val PROBE_COMPOSER = "composer"
    const val PROBE_TRANSCRIPT = "transcript"
    fun probeRow(key: String) = "row:$key"
    /** An answer's text inside its row, which a delta does recompose. */
    fun probeText(key: String) = "text:$key"
}

class ConversationScreenActions(
    val onBack: () -> Unit = {},
    /** A new empty chat in place of this one. */
    val onCompose: () -> Unit = {},
    /** The chat's details; only once the chat exists. */
    val onDetails: () -> Unit = {},
    val onDraftChange: (String) -> Unit = {},
    /** The words and the attached pictures' files; true when the message was taken (the composer then clears). */
    val onSend: (String, List<com.slopus.happy.attachments.AttachmentPreview>) -> Boolean = { _, _ -> false },
    /** The composer picked another model, effort or permission mode. */
    val onModeChange: (Mode) -> Unit = {},
    val onStop: () -> Unit = {},
    val onRetrySend: (String) -> Unit = {},
    val onDiscardSend: (String) -> Unit = {},
    /** Each outgoing picture's way to the computer, for the rings in the bubble. */
    val uploads: com.slopus.happy.conversation.UploadBoard? = null,
    /** Takes a picture out of a message still on its way. */
    val onRemovePicture: (messageId: String, index: Int) -> Unit = { _, _ -> },
    val onRetryFailure: (String) -> Unit = {},
    /** A failure card is on the screen, the conversation in front. */
    val onFailureShown: (ConversationRow.Failure) -> Unit = {},
    val onAnswer: suspend (questionId: String, answers: Map<String, List<String>>) -> Unit = { _, _ -> },
    /** Older history; `retry` after a failed page (Retry), which nothing else asks again. */
    val onLoadOlder: (retry: Boolean) -> Unit = {},
    /** History could not be read: ask again. */
    val onRetryLoad: () -> Unit = {},
    val loadMedia: suspend (MediaRef) -> ByteArray = { throw IllegalStateException() },
    /** One byte range of a presented item, so a recording streams; null where ranges can't be asked for. */
    val loadMediaRange: (suspend (MediaRef, LongRange) -> TransportResponse)? = null,
    /** The connection's media kept on this phone, with Telegram's download ring on each tile; null where nothing is kept. */
    val kept: com.slopus.happy.conversation.KeptMedia? = null,
    val onOpenArtifact: ((com.slopus.happy.conversation.ConversationRow.Artifact) -> Unit)? = null,
    /** HTML artifacts shown inline under their cards; null where none are. */
    val pages: com.slopus.happy.ui.artifacts.InlinePages? = null,
    /** The newest message is on screen while the app is up: unread clears. */
    val onVisible: (Boolean) -> Unit = {},
    /** How a secret request is made and answered; null where this build cannot. */
    val secrets: SecretRequestActions? = null,
    /** A new chat's Task or Bot and name changed. */
    val onChoiceChange: (WorkChoice) -> Unit = {},
    /** Runs one of the agent's slash commands, with what was typed after its name; true when it went. */
    val onCommand: (name: String, arguments: String?) -> Boolean = { _, _ -> false },
    /** Opens a finished turn on its work, or folds it again, by its run. */
    val onToggleTurn: (String) -> Unit = {},
    /** Opens a person's long message whole, or cuts it back, by its row's key. */
    val onToggleMessage: (String) -> Unit = {},
    /** Opens a tool call on its own screen, by its id. */
    val onOpenTool: ((String) -> Unit)? = null,
    /** How a workspace's folders read, for naming one of its files from the attach sheet; null where they can't. */
    val workspace: ((workspaceId: String) -> com.slopus.happy.ui.files.WorkspaceSource)? = null,
)

/**
 * One conversation with a paired agent, in Android's own forms: a Material 3
 * top app bar in the transcript's surface colour, scrolled or not (back
 * arrow; the chat's title, or "New chat" before its first send, with the
 * connection or activity state always under it, never in the content, a
 * tap on either opening the agent's page ([AgentPageScreen]);
 * compose, then a three-dot menu for permissions and chat details), the transcript newest at
 * the bottom, and the dock above the keyboard and navigation bar: the open
 * question ([ConversationQuestionCard]), then [ConversationComposer]. A
 * subagent or archived chat has a line saying so instead. Past the oldest
 * row a 32 slot: a spinner while a page loads; after a failed page
 * "Couldn't load earlier messages." and a Retry text button, and nothing
 * asks again until Retry. Away from the newest message, [ConversationJump]
 * leads back, its arrow shimmering while the agent works. Before history is
 * read a spinner sits centred; an empty chat and one that could not be read
 * say so in bodyLarge, 32 in. A new chat asks what it will be in the middle
 * instead ([NewWorkChoicePanel]).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(
    state: ConversationState,
    actions: ConversationScreenActions,
    modifier: Modifier = Modifier,
    bubbleColor: String? = null,
    /** The link as the header shows it, debounced: on its way somewhere, said with a spinner (iOS 7aee3a9b8). */
    link: LinkState = LinkState.Online,
    /** The computer's accounts' plan usage by provider id, for the model label's warning. */
    usage: Map<String, com.slopus.happy.conversation.AccountUsage> = emptyMap(),
    /** A model or effort list opened: ask the computer again for these accounts' readings. */
    onRefreshUsage: (List<String>) -> Unit = {},
    /** "+"'s sheet is up as the screen first opens. */
    opensAttach: Boolean = false,
    /** The person's role on the team lets them write here; false puts a line saying so in the composer's place. */
    roleCanSend: Boolean = true,
    /** The person's role starts new work: the header's compose shows. */
    roleCanCompose: Boolean = true,
) {
    RecomposeProbe.mark(ConversationScreenTags.PROBE_SCREEN)
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
    val workspaceId = state.agent?.workspaceId
    val workspace = remember(actions, workspaceId) { workspaceId?.let { id -> actions.workspace?.invoke(id) } }
    // "/" opens the agent's commands over the composer, as desktop's palette does; a new chat's, the computer's skills.
    val commands by rememberUpdatedState(state.commands)
    val onCommand by rememberUpdatedState(actions.onCommand)
    val commandSource = remember(state.agent?.id) { ConversationCommands(state.agent?.id, { commands }) { command -> onCommand(command.name, null) } }
    val autocomplete = com.slopus.happy.ui.autocomplete.rememberComposerAutocomplete(
        text,
        onTextChange = {
            text = it
            actions.onDraftChange(it)
        },
        source = commandSource,
    )
    val legacy = remember(actions) {
        MessageCallbacks(
            onOptionPress = { actions.onSend(it, emptyList()) },
            onRetry = actions.onRetrySend,
            onDiscard = actions.onDiscardSend,
        )
    }
    val answerScope = rememberCoroutineScope()
    val onAnswer by rememberUpdatedState(actions.onAnswer)
    val asks = remember { AskActions(answerScope) { id, answers -> onAnswer(id, answers) } }
    LaunchedEffect(state.question?.id) { asks.keepOnly(state.question?.id) }
    val pictures = rememberPictureViewer()
    val media = rememberMediaOpener()
    val store = rememberConversationMediaStore(actions.loadMedia, actions.loadMediaRange, actions.kept)
    // The viewer pages through what the transcript holds when it opens.
    val rows by rememberUpdatedState(state.rows)
    val pictureLabel = stringResource(R.string.conversation_picture)
    val videoLabel = stringResource(R.string.artifact_video)
    val folds = remember(listState) { FoldHold(listState) }
    val videos = rememberVideoOpening(store::video)
    val rowActions = remember(actions, legacy, pictures, media, store, pictureLabel, videoLabel, asks, folds, videos) {
        ConversationRowActions(
            legacy = legacy,
            onRetryFailure = actions.onRetryFailure,
            onFailureShown = actions.onFailureShown,
            loadMedia = store::bytes,
            onOpenArtifact = actions.onOpenArtifact,
            onOpenPicture = { key -> pictures.show(ConversationViewing.entries(rows, pictureLabel, videoLabel), key) },
            loadVideo = store::poster,
            onOpenMedia = { ref -> media.open(ref.key, ref.item, inApp = true) { store.file(ref) } },
            mediaOpening = { ref -> media.state(ref.key) },
            asks = asks,
            onToggleTurn = { turn ->
                folds.toggle(turn, rows)
                actions.onToggleTurn(turn)
            },
            onToggleMessage = { key ->
                folds.toggleMessage(key, rows)
                actions.onToggleMessage(key)
            },
            uploads = actions.uploads,
            onRemovePicture = actions.onRemovePicture,
            onOpenTool = actions.onOpenTool,
            kept = store.kept,
            videos = videos,
            pages = actions.pages,
        )
    }
    val atNewest by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 } }
    val visible by rememberUpdatedState(actions.onVisible)
    com.slopus.happy.ui.components.StartedEffect(atNewest, state.created) {
        if (state.created) visible(atNewest)
        try { kotlinx.coroutines.awaitCancellation() } finally { visible(false) }
    }

    // The dock floats over the transcript, which scrolls on under its glass; the list keeps the
    // dock's height free at its newest end, so the last message is never left under it. The bar
    // is glass too, over the same recording: older messages scroll on under it, softened.
    val glass = rememberGlassSource(colors.surface)
    val blurs = rememberGlassBlur()
    var dock by remember { mutableIntStateOf(0) }
    // The keyboard draws the dock and the transcript higher while it animates (a translation each
    // frame, nothing laid out), and is in the layout only at one end, read where things are laid
    // out and placed: it settling composes nothing.
    val keyboard = rememberKeyboardLift()
    // The transcript slides under the bar as it rides: the bar blurs what the whole way passes under it once.
    glass.travel = keyboard.travel
    // A message sent at the newest end flies from the composer to its row.
    val flight = remember { SendFlight() }
    val dockHeight = with(LocalDensity.current) { dock.toDp() }
    // Return in new work's name: on to the composer.
    var nameReturns by remember { mutableIntStateOf(0) }
    val phase = when {
        !state.loaded -> TranscriptPhase.Loading
        state.error != null && state.rows.isEmpty() -> TranscriptPhase.Failed
        state.rows.isEmpty() -> TranscriptPhase.Empty
        else -> TranscriptPhase.Rows
    }
    // The composer's words full screen (iOS ComposerEditorViewController): the caret it opened on,
    // packed start and end, or -1 while it is down; kept across a rotation.
    var editing by rememberSaveable { mutableLongStateOf(-1L) }
    val editorAt = if (editing < 0) null else TextRange((editing ushr 32).toInt(), (editing and 0xffffffffL).toInt())
    var returned by remember { mutableStateOf<ComposerReturn?>(null) }
    val onComposerText: (String) -> Unit = {
        text = it
        actions.onDraftChange(it)
    }
    // A held message lifts over the chat, blurred and veiled behind it above the composer (iOS 8c2a92172).
    val lift = remember { MessageLift() }
    val blur = with(LocalDensity.current) { MessageLiftSpec.blur.toPx() }
    Box(modifier.fillMaxSize()) {
        CompositionLocalProvider(LocalMessageLift provides lift) {
            GlassBarLayout(
                // Under the editor, TalkBack has the editor alone.
                modifier = Modifier.testTag(ConversationScreenTags.SCREEN).fillMaxSize().background(colors.surface)
                    .then(if (editorAt != null) Modifier.clearAndSetSemantics {} else Modifier),
                ground = colors.surface,
                source = glass,
                // Only the transcript runs under the bar; the other states are held below the bar's foot.
                feathered = phase == TranscriptPhase.Rows,
                bar = {
                    TopAppBar(
                        title = {
                            RecomposeProbe.mark(ConversationScreenTags.PROBE_BAR)
                            // One status line, under the title and nowhere else: the
                            // link while it isn't live, otherwise what the agent
                            // is doing. Its room is always kept, so neither the title nor
                            // the transcript moves when the link or the work changes.
                            val working = activityLabel(state.activity)
                            val syncing = state.syncing || (state.created && !state.loaded)
                            // The link on its way, or the chat still catching up: said with the spinner, as home's title says it.
                            val linkWords = linkStatusWords(if (link == LinkState.Online && syncing) LinkState.Syncing else link)
                            val dot = when {
                                linkWords != null -> null
                                state.activity == null -> colors.status.connected
                                state.activity == Activity.AwaitingAnswer -> SessionStatusColors.attention
                                else -> SessionStatusColors.thinking
                            }
                            val style = MaterialTheme.typography.bodySmall
                            // While work runs (not on a question) the title and the status shimmer, as desktop's busy
                            // tab and working line do; both keep their colours, with the sheen wiping through.
                            val running = activityShimmers(state.activity)
                            // Until the chat exists the bar is Back alone: it is plainly the empty chat. Its name
                            // and status fade in with the first send (iOS 323fb2e9f, ConversationHeader).
                            val shown by animateFloatAsState(
                                if (state.created) 1f else 0f,
                                tween(ConversationHeaderSpec.FADE_MILLIS, easing = ConversationHeaderSpec.easing),
                                label = "title",
                            )
                            // The title opens the agent's page, as iOS's header capsule and Telegram's do.
                            Box(
                                Modifier
                                    .graphicsLayer { alpha = shown }
                                    .then(if (state.created) Modifier else Modifier.clearAndSetSemantics {})
                                    .clip(MaterialTheme.shapes.small)
                                    .clickable(
                                        enabled = state.created,
                                        role = Role.Button,
                                        onClickLabel = stringResource(R.string.conversation_details),
                                        onClick = actions.onDetails,
                                    )
                                    .testTag(ConversationScreenTags.TITLE_BUTTON),
                            ) {
                                TitleWithStatus(
                                    status = BarStatus(
                                        linkWords ?: working ?: stringResource(R.string.status_online),
                                        dot,
                                        linkWords == null && state.activity != null,
                                        shimmer = linkWords == null && running,
                                        spins = linkWords != null,
                                    ),
                                    statusStyle = style,
                                    title = {
                                        // An existing chat is never "New chat", not even before it's read: blank until then.
                                        ShimmerText(
                                            state.title ?: when {
                                                !state.created -> stringResource(R.string.session_new_chat)
                                                state.loaded -> stringResource(R.string.conversation_untitled)
                                                else -> ""
                                            },
                                            style = LocalTextStyle.current,
                                            baseColor = colors.text,
                                            highlightColor = ShimmerSpec.sheen(colors.text, colors.surface),
                                            shimmering = running,
                                            // The bar stays while the agent works: its sweep runs on the RenderThread, the main thread idle.
                                            onRenderThread = true,
                                            modifier = Modifier.testTag(ConversationScreenTags.TITLE),
                                        )
                                    },
                                ) { status ->
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(if (status.spins) LinkStatusSpec.gap else 6.dp),
                                        modifier = Modifier
                                            .testTag(ConversationScreenTags.SUBTITLE)
                                            .semantics { liveRegion = LiveRegionMode.Polite },
                                    ) {
                                        if (status.spins) LinkSpinner(colors.textSecondary)
                                        status.dot?.let { StatusDot(it, pulsing = status.pulsing, onRenderThread = true) }
                                        ShimmerText(
                                            status.text,
                                            style = style,
                                            baseColor = colors.textSecondary,
                                            highlightColor = ShimmerSpec.sheen(colors.textSecondary, colors.surface),
                                            shimmering = status.shimmer,
                                            onRenderThread = true,
                                            modifier = Modifier.testTag(ConversationScreenTags.STATUS),
                                        )
                                    }
                                }
                            }
                        },
                        navigationIcon = {
                            BackOrSidebarToggle {
                                IconButton(onClick = actions.onBack, modifier = Modifier.testTag(ConversationScreenTags.BACK)) {
                                    Icon(MaterialSymbols.ArrowBack, stringResource(R.string.common_back))
                                }
                            }
                        },
                        actions = {
                            ConversationHeaderActions(state, actions, composes = roleCanCompose)
                        },
                        // On the glass, light and dark: no colour of its own, scrolled or not.
                        colors = TopAppBarDefaults.topAppBarColors(
                            containerColor = Color.Transparent,
                            scrolledContainerColor = Color.Transparent,
                            titleContentColor = colors.text,
                            navigationIconContentColor = colors.text,
                            actionIconContentColor = colors.text,
                        ),
                        // On the content column, so back and the actions' glyphs sit on the messages' keyline.
                        modifier = Modifier.liftBackdrop(lift, blur).contentMaxWidth(LocalWindowLayout.current).testTag(ConversationScreenTags.BAR),
                    )
                },
            ) { top ->
                Box(Modifier.fillMaxSize()) {
                    val barFoot = top - GlassSpec.feather
                    // The loader fades into the transcript, and every state into the next.
                    // The chat blurs behind a held message; the composer stays sharp ([liftClear]).
                    Crossfade(phase, Modifier.liftBackdrop(lift, blur), label = "transcript") { shown ->
                        when (shown) {
                            TranscriptPhase.Loading -> LoadingIndicator(
                                Modifier.padding(top = barFoot).keyboardPadding(keyboard, dockHeight).testTag(ConversationScreenTags.LOADING),
                            )
                            TranscriptPhase.Failed -> StatePage(
                                title = stringResource(R.string.conversation_load_failed),
                                body = state.error?.let { problemText(it) },
                                icon = Ionicon.CloudOfflineOutline,
                                action = stringResource(R.string.common_retry) to actions.onRetryLoad,
                                tag = ConversationScreenTags.ERROR,
                                modifier = Modifier.padding(top = barFoot).keyboardPadding(keyboard, dockHeight),
                            )
                            // New work is asked in the middle instead. Read live: fading out under the first message, it says nothing.
                            TranscriptPhase.Empty -> if (state.created && state.rows.isEmpty()) {
                                StatePage(
                                    title = null,
                                    body = stringResource(R.string.conversation_empty),
                                    art = StateArt.Ready,
                                    tag = ConversationScreenTags.EMPTY,
                                    modifier = Modifier.padding(top = barFoot).keyboardPadding(keyboard, dockHeight),
                                )
                            } else {
                                Box(Modifier.fillMaxSize())
                            }
                            TranscriptPhase.Rows -> Transcript(state, listState, bubble, rowActions, actions.onLoadOlder, top, dockHeight, glass, keyboard, flight, folds)
                        }
                    }
                    // New work: Task or Bot and a name under the kind's picture, centred between the bar and the
                    // composer, riding the keyboard with it; it fades once the work is made.
                    // As last chosen, for the fade after it is made.
                    val last = remember { arrayOfNulls<NewWork>(1) }
                    (state.newWork?.also { last[0] = it } ?: last[0])?.let { shown ->
                        NewWorkRoom(state.newWork != null, Modifier.riding(keyboard, 0.5f).padding(top = barFoot).keyboardPadding(keyboard, dockHeight), art = shown.choice.kind.art) {
                            NewWorkChoicePanel(shown, onChange = actions.onChoiceChange, onReturn = { nameReturns++ })
                        }
                    }
                    // What scrolls under the dock goes soft and pale over the dock's top 48, full width. The fade
                    // starts at the dock's top, as Telegram's lies inside its input zone (ChatActivityFadeView),
                    // so the newest message, which rests above the dock, is never under it.
                    Box(
                        Modifier
                            .align(Alignment.BottomCenter)
                            .aboveKeyboard(keyboard)
                            .fillMaxWidth()
                            .height(dockHeight)
                            .glassFade(glass, colors.surface, blurs)
                            .testTag(ConversationScreenTags.FADE),
                    )
                    if (phase == TranscriptPhase.Rows) Box(Modifier.matchParentSize().aboveKeyboard(keyboard)) { ConversationJump(listState, state.activity, dockHeight) }
                    Column(
                        Modifier
                            .align(Alignment.BottomCenter)
                            .riding(keyboard)
                            .fillMaxWidth()
                            .keyboardPadding(keyboard)
                            .onSizeChanged { dock = it.height }
                            .liftClear(lift)
                            .windowInsetsPadding(WindowInsets.navigationBars),
                    ) {
                        RecomposeProbe.mark(ConversationScreenTags.PROBE_DOCK)
                        // A secret's form stays over the composer; any other question waits in the transcript.
                        state.question?.takeIf { it.secret != null }?.let { question ->
                            ConversationQuestionCard(
                                question = question,
                                onAnswer = { answers -> actions.onAnswer(question.id, answers) },
                                secrets = actions.secrets,
                                // Half the screen at most, so a short one keeps the bar and the composer in view.
                                maxHeight = minOf(ConversationQuestionSpec.maxHeight, androidx.compose.ui.platform.LocalConfiguration.current.screenHeightDp.dp / 2),
                            )
                        }
                        if (state.canSend && roleCanSend) {
                            // Over the transcript, in the pill's width and 8 above it (the composer's own margin under it).
                            Box(
                                Modifier
                                    .contentMaxWidth(LocalWindowLayout.current)
                                    .fillMaxWidth()
                                    .height(0.dp)
                                    .offset(y = ConversationComposerSpec.margin.calculateTopPadding())
                                    .padding(horizontal = 12.dp)
                                    .wrapContentHeight(Alignment.Bottom, unbounded = true),
                            ) {
                                com.slopus.happy.ui.autocomplete.ComposerSuggestions(autocomplete, backdrop = glass)
                            }
                        }
                        if ((state.created && !state.canSend) || !roleCanSend) {
                            Text(
                                stringResource(
                                    when {
                                        state.created && state.agent?.archivedAt != null -> R.string.conversation_archived
                                        state.created && !state.canSend -> R.string.conversation_read_only
                                        else -> R.string.conversation_role_read_only
                                    },
                                ),
                                style = MaterialTheme.typography.bodyMedium,
                                color = colors.textSecondary,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.contentMaxWidth(LocalWindowLayout.current).padding(16.dp).testTag(ConversationScreenTags.READ_ONLY),
                            )
                        } else {
                            ConversationComposer(
                                state = state,
                                text = text,
                                onTextChange = onComposerText,
                                onSend = { words, attachments ->
                                    // "/name" and what follows runs that command; its words are never a message. A new chat's
                                    // first skill is its first message, drawn as one while the agent is made (Conversation.send).
                                    val invoked = if (attachments.isEmpty() && state.created) SlashCommands.invocation(words.trim(), state.commands) else null
                                    if (invoked != null) {
                                        flight.grounded = true
                                        return@ConversationComposer actions.onCommand(invoked.command.name, invoked.arguments)
                                    }
                                    // A question waiting takes what is typed as its answer, as on desktop: each
                                    // prompt its ticks, else the words. Words no prompt needed still go as a message.
                                    val waiting = state.question?.takeIf { it.secret == null && !state.answering }
                                    val answered = waiting != null && attachments.isEmpty() && words.isNotBlank() && asks.typed(waiting, words.trim())
                                    flight.grounded = answered
                                    // The words went as the answer: the draft they were goes with them, as a send's does.
                                    if (answered) actions.onDraftChange("")
                                    answered || actions.onSend(words, attachments)
                                },
                                onSent = { text = "" },
                                onStop = actions.onStop,
                                onModeChange = actions.onModeChange,
                                // The same centred column as the messages; the bar above stays full width.
                                modifier = Modifier.contentMaxWidth(LocalWindowLayout.current),
                                backdrop = glass,
                                opensAttach = opensAttach,
                                focusAsks = nameReturns,
                                flight = flight,
                                cursor = autocomplete.cursor,
                                usage = usage,
                                onRefreshUsage = onRefreshUsage,
                                onExpand = { at -> if (editing < 0) editing = (at.start.toLong() shl 32) or at.end.toLong() },
                                returned = returned,
                                // Sideways with the keyboard up, one row once the full card would leave the transcript too little.
                                barFoot = barFoot,
                                workspace = workspace,
                            )
                        }
                    }
                    SendFlightOverlay(flight, bubble, remember(colors) { ProsePalette.of(colors) })
                    PictureViewerHost(pictures, store)
                    MediaPreview(media)
                }
            }
        }
        CompositionLocalProvider(LocalMessageLift provides null, LocalCodeCopy provides CodeCopy.Icon) { MessageLiftOverlay(lift) }
        ComposerEditor(
            opened = editorAt,
            text = text,
            onTextChange = onComposerText,
            onClose = { selection, focused ->
                returned = ComposerReturn(selection, focused, (returned?.serial ?: 0) + 1)
                editing = -1L
            },
        )
    }
}

@Composable
private fun Transcript(
    state: ConversationState,
    listState: androidx.compose.foundation.lazy.LazyListState,
    bubble: com.slopus.happy.ui.chat.BubblePalette,
    actions: ConversationRowActions,
    onLoadOlder: (retry: Boolean) -> Unit,
    /** The glass bar's height over the list's oldest end, which scrolls on under it. */
    bar: Dp,
    /** The dock's height over the list's newest end, kept clear. */
    dock: Dp,
    glass: GlassSource,
    keyboard: KeyboardLift,
    flight: SendFlight,
    folds: FoldHold,
) {
    val nearOldest by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: return@derivedStateOf true
            last >= info.totalItemsCount - 1 - info.visibleItemsInfo.size
        }
    }
    RecomposeProbe.mark(ConversationScreenTags.PROBE_TRANSCRIPT)
    val loadOlder by rememberUpdatedState(onLoadOlder)
    LaunchedEffect(nearOldest, state.hasMore, state.loadingOlder, state.olderFailed) {
        if (nearOldest && state.hasMore && !state.loadingOlder && !state.olderFailed) loadOlder(false)
    }
    val reveal = remember(listState) { ListReveal(listState) }
    flight.atNewest = { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0 }
    // Code blocks offer desktop's quiet copy icon here, not the relay chat's pill.
    CompositionLocalProvider(LocalRevealHost provides reveal, LocalSendFlight provides flight, LocalCodeCopy provides CodeCopy.Icon) {
        TranscriptList(state, listState, bubble, actions, onLoadOlder, bar, dock, glass, keyboard, reveal, flight, folds)
    }
}

@Composable
private fun TranscriptList(
    state: ConversationState,
    listState: androidx.compose.foundation.lazy.LazyListState,
    bubble: com.slopus.happy.ui.chat.BubblePalette,
    actions: ConversationRowActions,
    onLoadOlder: (retry: Boolean) -> Unit,
    bar: Dp,
    dock: Dp,
    glass: GlassSource,
    keyboard: KeyboardLift,
    reveal: ListReveal,
    flight: SendFlight,
    folds: FoldHold,
) {
    val density = LocalDensity.current
    folds.apply(state.rows)
    // Rows arriving at the newest end come in as Telegram's do; with Reduce Motion they just appear.
    val motion = remember(listState) { TranscriptMotion(listState) }
    motion.update(state.rows, still = rememberReduceMotion())
    val generation = motion.generation
    LaunchedEffect(motion, generation) { if (generation > 0) motion.run() }
    LazyColumn(
        state = listState,
        reverseLayout = true,
        contentPadding = remember(bar, dock, keyboard, density) { KeyboardPadding(bar, dock + 8.dp, keyboard, density) },
        modifier = Modifier.fillMaxSize().aboveKeyboard(keyboard).glassSource(glass).graphicsLayer { translationY = reveal.lag() + motion.lift() }.testTag(ConversationScreenTags.LIST),
    ) {
        items(state.rows, key = ConversationRow::key, contentType = { it::class }) { row ->
            val moves = when {
                // Its words are on their way from the composer: it shows once they land.
                flight.claim(row) -> {
                    motion.flies(row.key)
                    Modifier.graphicsLayer { alpha = if (flight.hides(row.key)) 0f else 1f }
                }
                motion.entering(row.key) -> motion.enter(row.key)
                else -> Modifier
            }
            ConversationRowView(row, bubble, actions, moves)
        }
        item(key = OLDER_KEY, contentType = OLDER_KEY) {
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

/**
 * A turn opens or folds under the finger (iOS `foldMoved`): its fold control
 * stays where it was on screen, so the rows it brings or takes move the
 * others and not it, and the list stops following the newest row. A
 * person's long message opens down from its top, as desktop's does: the
 * row over it stays, or, that row off the screen, the message's foot.
 */
internal class FoldHold(private val list: androidx.compose.foundation.lazy.LazyListState) {
    private var held: Held? = null

    /** [key]'s row is put back [offset] from the list's end once [turned] says the rows have changed. */
    private class Held(val key: Any, val offset: Int, val turned: (List<ConversationRow>) -> Boolean)

    /** [turn]'s control is tapped while the list shows [rows]. */
    fun toggle(turn: String, rows: List<ConversationRow>) {
        val key = ConversationRow.traceKey(turn)
        val trace = list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == key }
        val open = (rows.firstOrNull { it.key == key } as? ConversationRow.Trace)?.open
        held = if (trace != null && open != null) Held(key, trace.offset) { (it.firstOrNull { row -> row.key == key } as? ConversationRow.Trace)?.open != open } else null
    }

    /** The person's message [key] is tapped open or shut while the list shows [rows]. */
    fun toggleMessage(key: String, rows: List<ConversationRow>) {
        val info = list.layoutInfo
        val message = info.visibleItemsInfo.firstOrNull { it.key == key }
        val opened = (rows.firstOrNull { it.key == key } as? ConversationRow.User)?.opened
        // The row over it, where it is or, past the screen's edge (a folded message is seventy lines), where it would be.
        val index = rows.indexOfFirst { it.key == key } + 1
        val overKey = rows.getOrNull(index)?.key ?: OLDER_KEY.takeIf { index == rows.size }
        held = if (message != null && opened != null && overKey != null) {
            Held(overKey, message.offset + message.size + info.mainAxisItemSpacing) { (it.firstOrNull { row -> row.key == key } as? ConversationRow.User)?.opened != opened }
        } else {
            null
        }
    }

    /** The rows composed now: once the row has turned, the held one is put back where it was, before they are laid out. */
    fun apply(rows: List<ConversationRow>) {
        val held = held ?: return
        if (!held.turned(rows)) return
        this.held = null
        // Past the rows is the list's own "older" item.
        val index = rows.indexOfFirst { it.key == held.key }.takeIf { it >= 0 } ?: rows.size.takeIf { held.key == OLDER_KEY } ?: return
        list.requestScrollToItem(index, -held.offset)
    }
}

/** The list's item past its oldest row: the spinner or retry for older history. */
private const val OLDER_KEY = "older"

/** What the page under the bar shows. */
private enum class TranscriptPhase { Loading, Failed, Empty, Rows }

/** The bar's status line: its words, dot, whether the dot pulses and whether the words shimmer. */
private data class BarStatus(val text: String, val dot: Color?, val pulsing: Boolean, val shimmer: Boolean = false, val spins: Boolean = false)

/**
 * Whether the agent's work is running, so the bar's title and status
 * shimmer: desktop's working line shimmers its phase while the loader
 * spins, and not on a question waiting on the person.
 */
internal fun activityShimmers(activity: Activity?): Boolean = activity != null && activity != Activity.AwaitingAnswer

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
    resolvePrimaryAction(hasContent = hasContent, showAbort = state.working, canAbort = state.created, blocked = false, disabled = false)
