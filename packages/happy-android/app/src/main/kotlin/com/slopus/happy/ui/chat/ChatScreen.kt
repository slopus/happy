package com.slopus.happy.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import com.slopus.happy.ui.conversation.ConversationHeaderSpec
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.AgentQuestionAnswer
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.ComposerModes
import com.slopus.happy.chat.isCurrentTurnComplete
import com.slopus.happy.connection.LinkState
import com.slopus.happy.model.GitStatus
import com.slopus.happy.model.SessionState
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.ui.components.GlassBarLayout
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.components.glassSource
import com.slopus.happy.ui.components.rememberGlassSource
import com.slopus.happy.ui.conversation.LocalSendFlight
import com.slopus.happy.ui.conversation.ProsePalette
import com.slopus.happy.ui.conversation.SendFlight
import com.slopus.happy.ui.conversation.SendFlightOverlay
import com.slopus.happy.ui.conversation.keyboardPadding
import com.slopus.happy.ui.conversation.rememberKeyboardLift
import com.slopus.happy.ui.conversation.riding
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.HeaderBackButton
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object ChatScreenTags {
    const val SCREEN = "chat.screen"
    const val DOCK = "chat.dock"
    const val SCRIM = "chat.dock.scrim"
    const val TITLE_BUTTON = "chat.header.titleButton"
    const val GIT_CHANGES = "chat.header.git"
    const val AVATAR = "chat.header.avatar"
    const val COMPOSE = "chat.header.compose"
    const val LOADING = "chat.loading"
    const val DELETED = "chat.deleted"
    const val DELETED_ICON = "chat.deleted.icon"
    const val DELETED_TITLE = "chat.deleted.title"
    const val DELETED_DESCRIPTION = "chat.deleted.description"
    const val EMPTY = "chat.empty"
    const val EMPTY_ICON = "chat.empty.icon"
    const val EMPTY_HOST = "chat.empty.host"
    const val EMPTY_PATH = "chat.empty.path"
    const val EMPTY_STATUS = "chat.empty.status"
    const val EMPTY_CREATED = "chat.empty.created"
}

/** SessionView.tsx, ChatHeaderView.tsx and EmptyMessages.tsx on an Android phone. */
object ChatScreenSpec {
    val avatar = 28.dp
    /** SessionView.tsx `sessionInputHorizontalPadding`: around the bars over the composer. */
    val inputPaddingHorizontal = 8.dp
    val tabletInputPaddingHorizontal = 12.dp
    val gitText = happyTextStyle(fontSize = 11, weight = FontWeight.SemiBold)
    /** AgentContentView: the scrim reaches this far above the floating dock. */
    val scrimOverhang = 28.dp
    /** AgentContentView's scrim, top to bottom: transparent, then 0.18 / 0.20 at 0.42, 0.74 / 0.66 at the bottom. */
    val scrimLight = listOf(0f to Color.White.copy(alpha = 0f), 0.42f to Color.White.copy(alpha = 0.18f), 1f to Color.White.copy(alpha = 0.74f))
    val scrimDark = listOf(0f to Color.Black.copy(alpha = 0f), 0.42f to Color.Black.copy(alpha = 0.20f), 1f to Color.Black.copy(alpha = 0.66f))
    val gitGap = 4.dp
    val deletedIcon = 48.dp
    val deletedTitle = happyTextStyle(fontSize = 20, weight = FontWeight.SemiBold)
    val deletedTitleMarginTop = 16.dp
    val deletedDescription = happyTextStyle(fontSize = 15)
    val deletedDescriptionMarginTop = 8.dp
    val deletedDescriptionPadding = 32.dp
    val emptyPaddingHorizontal = 48.dp
    val emptyIcon = 72.dp
    val emptyIconMarginBottom = 12.dp
    val emptyHost = happyTextStyle(fontSize = 18, weight = FontWeight.SemiBold)
    val emptyHostMarginBottom = 4.dp
    val emptyPath = happyTextStyle(fontSize = 14)
    val emptyPathMarginBottom = 40.dp
    val emptyNoMessages = happyTextStyle(fontSize = 20)
    val emptyNoMessagesMarginBottom = 8.dp
    val emptyCreated = happyTextStyle(fontSize = 16, lineHeight = 24)
}

/** What the chat screen asks of whoever hosts it. */
class ChatScreenActions(
    val onBack: () -> Unit = {},
    /** The title and More's Details open `/session/{id}/info`. */
    val onInfo: () -> Unit = {},
    val onDraftChange: (String) -> Unit = {},
    val onSend: (String) -> Unit = {},
    /** Stop: returns once the agent took it, throws if it didn't. */
    val onAbort: suspend () -> Unit = {},
    val loadOlder: suspend () -> Boolean = { false },
    val onToolPress: (com.slopus.happy.chat.ChatMessage.ToolCallMessage) -> Unit = {},
    /** A patch tool's file card: that file's diff in the message detail. */
    val onToolFilePress: ((com.slopus.happy.chat.ChatMessage.ToolCallMessage, String) -> Unit)? = null,
    val onPermission: PermissionHandler = { _, _ -> },
    /** A failed send, by its localId: queue it again, or drop it. */
    val onRetry: (String) -> Unit = {},
    val onDiscard: (String) -> Unit = {},
    /** A failed send was seen, by its localId. */
    val onSendFailureShown: (String) -> Unit = {},
    val onAnswerQuestion: suspend (communicationId: String, answers: Map<String, AgentQuestionAnswer>, kind: String) -> Unit = { _, _, _ -> },
    val onCancelQuestion: suspend (communicationId: String, kind: String) -> Unit = { _, _ -> },
    /** A pick from header permissions or the composer's model/effort picker. */
    val onModeChange: (AgentModeField, ModeOption) -> Unit = { _, _ -> },
    /** The CLI warning pill was tapped: this machine's CLI version is acknowledged. */
    val onDismissCliWarning: () -> Unit = {},
    /** Resume, from the inactive-session hint. */
    val onResume: () -> Unit = {},
    /** Open the relay account's existing new-session creation flow. */
    val onCompose: () -> Unit = {},
)

/**
 * What the session screen carries besides the chat (SessionView.tsx), filled
 * by Home: [headerAccessory] under the header (the checkout's tab strip),
 * with [headerTitle] and [headerSubtitle] naming the checkout while it shows;
 * [pending] while the route stands on a chat no machine has answered for yet.
 */
@Immutable
class ChatScreenSlots(
    val headerAccessory: (@Composable () -> Unit)? = null,
    val headerTitle: String? = null,
    val headerSubtitle: String? = null,
    val pending: ChatPendingSlot? = null,
)

/**
 * A chat being started: "New chat" in the header (none before the first
 * send without [headerShown]), [placeholder] in place of
 * the transcript, and the composer under it, its chips read from [anchor]
 * (the chat it was opened beside, which decides how it runs). With
 * [focusComposer] the composer takes the keyboard as it first shows (an
 * empty chat compose opened).
 */
@Immutable
class ChatPendingSlot(
    val anchor: ChatSessionInfo?,
    val focusComposer: Boolean = false,
    /** What the composer asks for while empty (a task's first message); null for the chat's own. */
    val composerPlaceholder: String? = null,
    /** False until the first send: the header is Back alone (compose's empty chat). */
    val headerShown: Boolean = true,
    val placeholder: @Composable () -> Unit,
)

/** Shown at once, or faded in ease-out over 0.25 s once [shown] turns true; nothing while false. */
@Composable
private fun HeaderFadeIn(shown: Boolean, content: @Composable () -> Unit) {
    AnimatedVisibility(
        visible = shown,
        enter = fadeIn(tween(ConversationHeaderSpec.FADE_MILLIS, easing = ConversationHeaderSpec.easing)),
        exit = ExitTransition.None,
    ) { content() }
}

/**
 * One chat (SessionView.tsx). Spec: the header ([ChatHeaderTitle]: back;
 * the title, 16/20 semibold, with the workspace or branch and the git
 * counts under it in 12/16 secondary; New chat and More in 48 dp right
 * slots; title and More's Details open session info, while supported
 * permission choices live in More), then [ChatScreenSlots.headerAccessory] (Home's tab strip)
 * and the voice status bar: together the screen's top bar, on glass
 * ([GlassBarLayout]), as the agent chat's is. The transcript runs the full
 * height and scrolls on under the bar, starting clear of it; then the dock
 * ([ChatDock]) above the keyboard and the navigation bar. The CLI warning
 * pill floats over the transcript, 8 below the bar, except on a landscape
 * phone. The placeholders (ChatPlaceholders.kt), below the bar: before the
 * store has answered, a small spinner and an empty title; a pending chat,
 * its [ChatPendingSlot.placeholder] under "New chat"; a session no longer
 * on the device, [DeletedSession] and no composer; no rows yet,
 * [EmptyMessages] once the first page is in, a spinner before.
 *
 * The dock, top to bottom: the inactive-session hint, [goalBar] and the
 * question banner (each in the centred input width), [activityBar], then
 * the composer. On a phone in portrait it floats (AgentContentView
 * `floatingDock`): the transcript runs to the bottom of the screen under
 * it, with the dock's height added under the newest row, and a scrim from
 * 28 above the dock to the bottom (white 0 → 0.18 at 0.42 → 0.74, in dark
 * black 0 → 0.20 → 0.66). Reading older messages there fades out the
 * dock's details — the hint, goal bar, banner, activity bar, the status
 * row and the usage row — in place (`showStatusDetails`). Placeholders
 * (spinner, empty, deleted) are centred in the room above the dock. On a
 * tablet or in landscape the dock sits below the transcript and nothing
 * fades.
 */
@Composable
fun ChatScreen(
    state: ChatState,
    draft: String,
    bubbleColor: String,
    actions: ChatScreenActions,
    modifier: Modifier = Modifier,
    now: Long = System.currentTimeMillis(),
    compactToolCalls: Boolean = false,
    /** The `groupToolCalls` setting: a finished turn's work folds under one row. */
    groupToolCalls: Boolean = false,
    /** Whether the app is in the foreground, for which work groups stay open. */
    foreground: Boolean = true,
    showLineNumbersInToolViews: Boolean = false,
    modes: ComposerModes = ComposerModes.None,
    gitStatus: GitStatus? = null,
    showCliWarning: Boolean = false,
    inactiveHint: InactiveHint? = null,
    slots: ChatScreenSlots = ChatScreenSlots(),
    /** The goal bar (AgentGoalBar), between the inactive hint and the question banner; fades with the details. */
    goalBar: (@Composable () -> Unit)? = null,
    /** The activity bar (RigActivityBar), just over the composer; fades with the details. */
    activityBar: (@Composable () -> Unit)? = null,
    /** The account's link as headers show it, debounced ([rememberShownLinkState]). */
    link: LinkState = LinkState.Online,
) {
    val colors = HappyTheme.colors
    val session = state.session
    val pending = slots.pending
    val flavor = session?.metadata?.flavor
    val path = session?.metadata?.path
    val toolEnvironment = remember(compactToolCalls, showLineNumbersInToolViews, flavor, path) {
        ToolEnvironment(compactToolCalls = compactToolCalls, showLineNumbers = showLineNumbersInToolViews, flavor = flavor, path = path)
    }
    val listState = rememberLazyListState()
    val loadOlder by rememberUpdatedState(actions.loadOlder)
    val pager = remember(session?.id) { OlderPager { loadOlder() } }
    val callbacks = remember(actions) {
        MessageCallbacks(
            onOptionPress = { actions.onSend(it) },
            onToolPress = actions.onToolPress,
            onToolFilePress = actions.onToolFilePress,
            onPermission = actions.onPermission,
            onRetry = actions.onRetry,
            onDiscard = actions.onDiscard,
            onSendFailureShown = actions.onSendFailureShown,
            onAnswerQuestion = actions.onAnswerQuestion,
            onCancelQuestion = actions.onCancelQuestion,
        )
    }
    val bubble = userMessageBubblePalette(bubbleColor, colors.dark)
    val title = when {
        // A chat on its way to a machine has no name yet, and is emphatically not a deleted one.
        pending != null -> stringResource(R.string.session_new_chat)
        !state.sessionLoaded -> ""
        session == null -> stringResource(R.string.errors_session_deleted)
        else -> session.title ?: stringResource(R.string.session_new_chat)
    }

    // The bars over a tablet's composer sit 12 in rather than 8 (`sessionInputHorizontalPadding`).
    val tablet = LocalWindowLayout.current.isTablet
    val showsList = session != null && state.sessionLoaded && state.snapshot.rows.isNotEmpty()
    // The keyboard as the agent chat takes it (KeyboardLift): the content is drawn higher while it
    // animates and laid out above it at one end. The bar stays, so it reads the content it records
    // here and follows it up.
    val keyboard = rememberKeyboardLift()
    val glass = rememberGlassSource(colors.surface)
    glass.travel = keyboard.travel
    // A message sent at the newest end flies from the composer to its row, over everything (SendFlight).
    val flight = remember(session?.id) { SendFlight() }
    // A held message lifts over the chat, blurred and veiled behind it above the composer (iOS 8c2a92172).
    val lift = remember(session?.id) { MessageLift() }
    val blur = with(LocalDensity.current) { MessageLiftSpec.blur.toPx() }
    Box(modifier.fillMaxSize()) {
        CompositionLocalProvider(LocalSendFlight provides flight, LocalMessageLift provides lift) {
            GlassBarLayout(
                modifier = Modifier
                    .testTag(ChatScreenTags.SCREEN)
                    .fillMaxSize()
                    .background(colors.surface),
                ground = colors.surface,
                source = glass,
                // Only the transcript runs under the bar; what stands in for it is held below the bar's foot.
                feathered = showsList,
                bar = {
                    Column(Modifier.liftBackdrop(lift, blur)) {
                        // An empty chat's header is Back alone; its name and actions fade in with the first send (iOS 323fb2e9f).
                        val headerShown = session != null || pending?.headerShown != false
                        Header(
                            left = { HeaderBackButton(actions.onBack) },
                            titleContent = {
                                HeaderFadeIn(headerShown) {
                                    ChatHeaderTitle(slots.headerTitle ?: title, session, gitStatus, onClick = if (session != null) actions.onInfo else null, subtitleOverride = slots.headerSubtitle, working = state.sessionState == SessionState.Thinking, link = link)
                                }
                            },
                            right = { HeaderFadeIn(headerShown) { ChatHeaderActions(actions) } },
                        )
                        slots.headerAccessory?.invoke()
                        if (!tablet) com.slopus.happy.ui.voice.VoiceStatusBar()
                    }
                },
            ) { top ->
                Column(Modifier.fillMaxSize().keyboardPadding(keyboard).riding(keyboard).glassSource(glass)) {
                    val floating = !tablet && !LocalWindowLayout.current.isLandscape
                    // A pending chat's composer runs as the chat it was opened beside.
                    val composerSession = session ?: pending?.anchor
                    val docked = floating && composerSession != null
                    // SessionView `isChatAtBottom`, reset for each chat.
                    var atNewest by remember(session?.id) { mutableStateOf(true) }
                    val showDetails = !floating || atNewest
                    val density = LocalDensity.current
                    var dockHeight by remember { mutableIntStateOf(0) }
                    // The composer card's distance from the list's bottom, in pixels: both move together with the keyboard, so it doesn't.
                    val list = remember { arrayOfNulls<LayoutCoordinates>(1) }
                    var cardInset by remember { mutableStateOf<Float?>(null) }
                    val dockInset = if (docked) with(density) { dockHeight.toDp() } else 0.dp
                    val inputPadding = if (tablet) ChatScreenSpec.tabletInputPaddingHorizontal else ChatScreenSpec.inputPaddingHorizontal
                    val dock = @Composable { dockModifier: Modifier, composerModifier: Modifier ->
                        if (composerSession != null) {
                            ChatDock(
                                state, composerSession, draft, actions, now, modes, inactiveHint.takeIf { session != null }, goalBar, activityBar, inputPadding, showDetails,
                                autoFocus = session == null && pending?.focusComposer == true,
                                placeholder = pending?.composerPlaceholder.takeIf { session == null },
                                onPanelPositioned = if (docked) { coordinates ->
                                    cardInset = list[0]?.takeIf { it.isAttached }?.let { it.size.height - it.localPositionOf(coordinates, Offset.Zero).y }
                                } else null,
                                modifier = dockModifier,
                                composerModifier = composerModifier,
                            )
                        }
                    }
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .onPlaced { list[0] = it },
                    ) {
                        // The list runs under the bar and the floating dock; anything else keeps to the room between them.
                        // The chat blurs behind a held message; the composer stays sharp ([liftClear]).
                        Box(Modifier.fillMaxSize().liftBackdrop(lift, blur).padding(top = if (showsList) 0.dp else top - GlassSpec.feather, bottom = if (showsList) 0.dp else dockInset)) {
                            when {
                                session == null && pending != null -> pending.placeholder()
                                !state.sessionLoaded -> Spinner(Modifier.align(Alignment.Center).testTag(ChatScreenTags.LOADING))
                                session == null -> DeletedSession()
                                state.snapshot.rows.isNotEmpty() -> CompositionLocalProvider(LocalToolEnvironment provides toolEnvironment, LocalToolAgentState provides session.agentState) {
                                    ChatList(
                                        rows = state.snapshot.rows,
                                        hasMoreOlder = state.snapshot.hasMoreOlder,
                                        isLoadingOlder = state.snapshot.isLoadingOlder,
                                        controlledByUser = session.usesControlledSessionUi && session.agentState?.controlledByUser == true,
                                        bubble = bubble,
                                        callbacks = callbacks,
                                        pager = pager,
                                        state = listState,
                                        bottomInset = dockInset,
                                        topInset = top,
                                        scrollButtonInset = cardInset?.takeIf { docked }?.let { with(density) { it.coerceAtLeast(0f).toDp() } },
                                        onNewestVisibleChange = if (floating) { visible -> atNewest = visible } else null,
                                        sessionId = session.id,
                                        groupToolCalls = groupToolCalls,
                                        currentTurnComplete = isCurrentTurnComplete(state.thinking, session.agentState),
                                        foreground = foreground,
                                        working = state.sessionState == SessionState.Thinking,
                                        flight = flight,
                                    )
                                }
                                state.snapshot.loaded -> EmptyMessages(
                                    session = session,
                                    hasMoreOlder = state.snapshot.hasMoreOlder,
                                    isLoadingOlder = state.snapshot.isLoadingOlder,
                                    pager = pager,
                                    now = now,
                                )
                                else -> Spinner(Modifier.align(Alignment.Center).testTag(ChatScreenTags.LOADING))
                            }
                        }
                        // Over the transcript, not in it; hidden on a landscape phone, as in happy-app.
                        if (session != null && showCliWarning && !(LocalWindowLayout.current.isLandscape && !tablet)) {
                            CliWarningPill(actions.onDismissCliWarning, Modifier.align(Alignment.TopCenter).padding(top = top))
                        }
                        if (docked) {
                            if (dockHeight > 0) DockScrim(dockHeight, Modifier.align(Alignment.BottomCenter))
                            dock(
                                Modifier
                                    .align(Alignment.BottomCenter)
                                    .onSizeChanged { dockHeight = it.height }
                                    .liftClear(lift)
                                    .windowInsetsPadding(WindowInsets.navigationBars),
                                Modifier,
                            )
                        }
                    }
                    if (!docked) dock(Modifier.liftClear(lift), Modifier.windowInsetsPadding(WindowInsets.navigationBars))
                }
            }
        }
        SendFlightOverlay(flight, bubble, remember(colors) { ProsePalette.of(colors) })
        CompositionLocalProvider(LocalMessageLift provides null) { MessageLiftOverlay(lift) }
    }
}
