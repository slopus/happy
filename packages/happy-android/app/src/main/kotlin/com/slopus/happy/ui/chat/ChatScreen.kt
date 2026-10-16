package com.slopus.happy.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.AgentQuestionAnswer
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.ComposerModes
import com.slopus.happy.model.SessionState
import com.slopus.happy.model.avatarId
import com.slopus.happy.model.compactCount
import com.slopus.happy.model.formatPathRelativeToHome
import com.slopus.happy.model.rigGitSummary
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.rigCanAbort
import com.slopus.happy.ui.attachments.ComposerAddImageButton
import com.slopus.happy.ui.attachments.ComposerAttachmentStrip
import com.slopus.happy.ui.attachments.hasComposerImages
import com.slopus.happy.ui.autocomplete.ComposerSuggestions
import com.slopus.happy.ui.autocomplete.rememberComposerAutocomplete
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.AvatarBadgeLocation
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.HeaderBackButton
import com.slopus.happy.ui.components.HeaderSpec
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.layout.CenteredInputWidth
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.launch

object ChatScreenTags {
    const val SCREEN = "chat.screen"
    const val TITLE_BUTTON = "chat.header.titleButton"
    const val GIT_CHANGES = "chat.header.git"
    const val AVATAR = "chat.header.avatar"
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
    /** The title and the avatar open `/session/{id}/info`. */
    val onInfo: () -> Unit = {},
    val onDraftChange: (String) -> Unit = {},
    val onSend: (String) -> Unit = {},
    val onAbort: () -> Unit = {},
    val loadOlder: suspend () -> Boolean = { false },
    val onToolPress: (com.slopus.happy.chat.ChatMessage.ToolCallMessage) -> Unit = {},
    val onPermission: PermissionHandler = { _, _ -> },
    /** A failed send, by its localId: queue it again, or drop it. */
    val onRetry: (String) -> Unit = {},
    val onDiscard: (String) -> Unit = {},
    val onAnswerQuestion: suspend (communicationId: String, answers: Map<String, AgentQuestionAnswer>, kind: String) -> Unit = { _, _, _ -> },
    val onCancelQuestion: suspend (communicationId: String, kind: String) -> Unit = { _, _ -> },
    /** A pick from the composer's permission, model or effort sheet. */
    val onModeChange: (AgentModeField, ModeOption) -> Unit = { _, _ -> },
)

/**
 * One chat (SessionView.tsx). Spec: the header (back; the title, 16/20
 * semibold, with the workspace or branch and the git counts under it in
 * 12/16 secondary; the 28 avatar, monochrome while offline, in the right
 * slot; title and avatar open the session info), then the transcript, then
 * the composer above the keyboard and the navigation bar. Before the store
 * has answered: a small spinner and an empty title. A session no longer on
 * the device: trash-outline 48 (textSecondary), "Session has been deleted"
 * 20 semibold 16 below, the description 15 secondary 8 below and 32 in,
 * all centred; no composer. No rows yet: EmptyMessages once the first page
 * is in, a spinner before.
 */
@Composable
fun ChatScreen(
    state: ChatState,
    draft: String,
    bubbleColor: String,
    actions: ChatScreenActions,
    modifier: Modifier = Modifier,
    aborting: Boolean = false,
    now: Long = System.currentTimeMillis(),
    compactToolCalls: Boolean = false,
    showLineNumbersInToolViews: Boolean = false,
    modes: ComposerModes = ComposerModes.None,
) {
    val colors = HappyTheme.colors
    val session = state.session
    val toolEnvironment = ToolEnvironment(
        compactToolCalls = compactToolCalls,
        showLineNumbers = showLineNumbersInToolViews,
        flavor = session?.metadata?.flavor,
        path = session?.metadata?.path,
        agentState = session?.agentState,
    )
    val listState = rememberLazyListState()
    val loadOlder by rememberUpdatedState(actions.loadOlder)
    val pager = remember(session?.id) { OlderPager { loadOlder() } }
    val callbacks = remember(actions) {
        MessageCallbacks(
            onOptionPress = { actions.onSend(it) },
            onToolPress = actions.onToolPress,
            onPermission = actions.onPermission,
            onRetry = actions.onRetry,
            onDiscard = actions.onDiscard,
            onAnswerQuestion = actions.onAnswerQuestion,
            onCancelQuestion = actions.onCancelQuestion,
        )
    }
    val bubble = userMessageBubblePalette(bubbleColor, colors.dark)
    val title = when {
        !state.sessionLoaded -> ""
        session == null -> stringResource(R.string.errors_session_deleted)
        else -> session.title ?: stringResource(R.string.session_new_chat)
    }

    // SessionView.tsx: a tablet reaches session info through the title, so the avatar goes;
    // the bars over the composer sit 12 in rather than 8 (`sessionInputHorizontalPadding`).
    val tablet = LocalWindowLayout.current.isTablet
    Column(
        modifier = modifier
            .testTag(ChatScreenTags.SCREEN)
            .fillMaxSize()
            .background(colors.surface),
    ) {
        Header(
            scrolled = session != null && listState.canScrollForward,
            left = { HeaderBackButton(actions.onBack) },
            titleContent = { ChatHeaderTitle(title, session, onClick = if (session != null) actions.onInfo else null) },
            right = if (session != null && !tablet) {
                { HeaderAvatar(session, state.online, actions.onInfo) }
            } else {
                null
            },
        )
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                !state.sessionLoaded -> Spinner(Modifier.align(Alignment.Center).testTag(ChatScreenTags.LOADING))
                session == null -> DeletedSession()
                state.snapshot.rows.isNotEmpty() -> CompositionLocalProvider(LocalToolEnvironment provides toolEnvironment) {
                    ChatList(
                        rows = state.snapshot.rows,
                        hasMoreOlder = state.snapshot.hasMoreOlder,
                        isLoadingOlder = state.snapshot.isLoadingOlder,
                        controlledByUser = session.usesControlledSessionUi && session.agentState?.controlledByUser == true,
                        bubble = bubble,
                        callbacks = callbacks,
                        pager = pager,
                        state = listState,
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
        if (session != null) {
            CenteredInputWidth(horizontalPadding = if (tablet) ChatScreenSpec.tabletInputPaddingHorizontal else ChatScreenSpec.inputPaddingHorizontal) {
                AgentQuestionBanner(state.pendingCommunications, actions.onAnswerQuestion, actions.onCancelQuestion)
            }
            ChatComposerFor(state, session, draft, actions, aborting, now, modes)
        }
    }
}

@Composable
private fun ChatComposerFor(
    state: ChatState,
    session: ChatSessionInfo,
    draft: String,
    actions: ChatScreenActions,
    aborting: Boolean,
    now: Long,
    modes: ComposerModes,
) {
    val sessionState = state.sessionState
    val metadata = session.metadata
    val canAbort = sessionState != SessionState.Disconnected && metadata.rigCanAbort()
    val blocked = session.isRig && state.thinking && metadata?.capabilities?.steering != true
    val primary = resolvePrimaryAction(
        hasContent = draft.isNotBlank() || hasComposerImages(),
        showAbort = showsAbort(sessionState),
        canAbort = canAbort,
        blocked = blocked,
    )
    val autocomplete = rememberComposerAutocomplete(draft, actions.onDraftChange)
    ChatComposer(
        text = draft,
        onTextChange = actions.onDraftChange,
        status = rememberComposerStatus(sessionState, state.activeAt, now),
        primary = primary,
        aborting = aborting,
        onPrimary = {
            when (primary) {
                PrimaryAction.Stop -> actions.onAbort()
                PrimaryAction.Send -> actions.onSend(draft)
                else -> Unit
            }
        },
        modifier = Modifier
            .windowInsetsPadding(WindowInsets.navigationBars)
            .imePadding(),
        middle = {
            // [+] [permission ... model · effort]: the chips take what the add button leaves.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(ComposerSpec.actionRowGap)) {
                ComposerAddImageButton()
                ComposerModeChips(modes, metadata, actions.onModeChange, Modifier.weight(1f))
            }
        },
        top = { ComposerAttachmentStrip() },
        overlay = { ComposerSuggestions(autocomplete) },
        cursor = autocomplete.cursor,
    )
}

@Composable
private fun ChatHeaderTitle(title: String, session: ChatSessionInfo?, onClick: (() -> Unit)?) {
    val colors = HappyTheme.colors
    val metadata = session?.metadata
    val subtitle = metadata?.workspace?.name?.trim()?.takeIf { it.isNotEmpty() } ?: metadata?.gitBranch?.trim()?.takeIf { it.isNotEmpty() }
    val git = metadata.rigGitSummary()?.takeIf { it.insertions > 0 || it.deletions > 0 }
    Column(
        modifier = Modifier
            .testTag(ChatScreenTags.TITLE_BUTTON)
            .fillMaxHeight()
            .then(
                if (onClick != null) {
                    Modifier.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick)
                } else {
                    Modifier
                },
            ),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = title.ifEmpty { subtitle.orEmpty() },
            style = HeaderSpec.title,
            color = colors.header.tint,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.testTag(HeaderTags.TITLE),
        )
        if (subtitle != null || git != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(ChatScreenSpec.gitGap)) {
                if (subtitle != null) {
                    Text(
                        text = subtitle,
                        style = HeaderSpec.subtitle,
                        color = colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false).testTag(HeaderTags.SUBTITLE),
                    )
                }
                if (git != null) {
                    Row(
                        modifier = Modifier.testTag(ChatScreenTags.GIT_CHANGES),
                        horizontalArrangement = Arrangement.spacedBy(ChatScreenSpec.gitGap),
                    ) {
                        if (!git.countsExact) Text("≈", style = happyTextStyle(fontSize = 11), color = colors.textSecondary)
                        if (git.insertions > 0) Text("+${compactCount(git.insertions)}", style = ChatScreenSpec.gitText, color = ChatTheme.colors.gitAdded)
                        if (git.deletions > 0) Text("-${compactCount(git.deletions)}", style = ChatScreenSpec.gitText, color = ChatTheme.colors.gitRemoved)
                    }
                }
            }
        }
    }
}

@Composable
private fun HeaderAvatar(session: ChatSessionInfo, online: Boolean, onClick: () -> Unit) {
    val metadata = session.metadata
    Box(
        modifier = Modifier
            .testTag(ChatScreenTags.AVATAR)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick),
    ) {
        Avatar(
            id = session.session.avatarId(),
            size = ChatScreenSpec.avatar,
            bot = metadata?.bot != null,
            monochrome = !online,
            flavor = metadata?.flavor,
            clientId = metadata?.client?.id,
            badgeLocation = AvatarBadgeLocation.SessionHeader,
            imageUri = session.session.avatar?.uri,
        )
    }
}

@Composable
private fun Spinner(modifier: Modifier = Modifier) {
    CircularProgressIndicator(modifier.size(20.dp), color = HappyTheme.colors.textSecondary, strokeWidth = 2.dp)
}

@Composable
private fun DeletedSession() {
    val colors = HappyTheme.colors
    Column(
        modifier = Modifier.testTag(ChatScreenTags.DELETED).fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Ionicon.TrashOutline, ChatScreenSpec.deletedIcon, colors.textSecondary, Modifier.testTag(ChatScreenTags.DELETED_ICON))
        Text(
            stringResource(R.string.errors_session_deleted),
            style = ChatScreenSpec.deletedTitle,
            color = colors.text,
            modifier = Modifier.padding(top = ChatScreenSpec.deletedTitleMarginTop).testTag(ChatScreenTags.DELETED_TITLE),
        )
        Text(
            stringResource(R.string.errors_session_deleted_description),
            style = ChatScreenSpec.deletedDescription,
            color = colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .padding(top = ChatScreenSpec.deletedDescriptionMarginTop)
                .testTag(ChatScreenTags.DELETED_DESCRIPTION)
                .padding(horizontal = ChatScreenSpec.deletedDescriptionPadding),
        )
    }
}

private fun osIcon(os: String?): Ionicon {
    val lower = os?.lowercase() ?: return Ionicon.HardwareChipOutline
    return when {
        "darwin" in lower || "mac" in lower -> Ionicon.LaptopOutline
        "win" in lower -> Ionicon.DesktopOutline
        "linux" in lower -> Ionicon.TerminalOutline
        else -> Ionicon.HardwareChipOutline
    }
}

/**
 * EmptyMessages.tsx. Spec: centred with 48 side padding: the machine's OS
 * icon 72 (textSecondary, 12 below), the host 18 semibold (4 below), the
 * path relative to home 14 secondary (40 below), then "No messages yet"
 * 20 secondary (8 below) once the server has no older page; while it may,
 * pages are fetched (a spinner; Retry after a failure; Load more after
 * five empty pages). Last, "Created {relative time}" 16/24 secondary.
 */
@Composable
fun EmptyMessages(
    session: ChatSessionInfo,
    hasMoreOlder: Boolean,
    isLoadingOlder: Boolean,
    pager: OlderPager,
    now: Long = System.currentTimeMillis(),
) {
    val colors = HappyTheme.colors
    val metadata = session.metadata
    val scope = rememberCoroutineScope()
    val resources = LocalContext.current.resources
    val blocked = pager.blocked
    LaunchedEffect(hasMoreOlder, isLoadingOlder, blocked) {
        if (hasMoreOlder && !isLoadingOlder && blocked == null) scope.launch { pager.request { null } }
    }
    Column(
        modifier = Modifier
            .testTag(ChatScreenTags.EMPTY)
            .fillMaxSize()
            .padding(horizontal = ChatScreenSpec.emptyPaddingHorizontal),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            osIcon(metadata?.os),
            ChatScreenSpec.emptyIcon,
            colors.textSecondary,
            Modifier.padding(bottom = ChatScreenSpec.emptyIconMarginBottom).testTag(ChatScreenTags.EMPTY_ICON),
        )
        val host = metadata?.host
        val path = metadata?.path
        if (!host.isNullOrEmpty()) {
            Text(
                host,
                style = ChatScreenSpec.emptyHost,
                color = colors.text,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(bottom = ChatScreenSpec.emptyHostMarginBottom).testTag(ChatScreenTags.EMPTY_HOST),
            )
        }
        if (!path.isNullOrEmpty()) {
            Text(
                formatPathRelativeToHome(path, metadata.homeDir),
                style = ChatScreenSpec.emptyPath,
                color = colors.textSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(bottom = ChatScreenSpec.emptyPathMarginBottom).testTag(ChatScreenTags.EMPTY_PATH),
            )
        }
        Box(modifier = Modifier.testTag(ChatScreenTags.EMPTY_STATUS), contentAlignment = Alignment.Center) {
            when {
                !hasMoreOlder -> Text(
                    // Literal in happy-app (EmptyMessages.tsx).
                    "No messages yet",
                    style = ChatScreenSpec.emptyNoMessages,
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(bottom = ChatScreenSpec.emptyNoMessagesMarginBottom),
                )
                blocked == OlderBlock.Error -> RoundButton(
                    stringResource(R.string.common_retry),
                    pager::retry,
                    size = RoundButtonSize.Small,
                    display = RoundButtonDisplay.Inverted,
                )
                blocked == OlderBlock.Limit -> RoundButton(
                    stringResource(R.string.common_load_more),
                    pager::loadMore,
                    size = RoundButtonSize.Small,
                    display = RoundButtonDisplay.Inverted,
                )
                else -> Spinner(Modifier.padding(bottom = ChatScreenSpec.emptyNoMessagesMarginBottom))
            }
        }
        Text(
            // "Created" is literal in happy-app (EmptyMessages.tsx).
            "Created ${formatRelativeTime(resources, session.session.createdAt, now)}",
            style = ChatScreenSpec.emptyCreated,
            color = colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.testTag(ChatScreenTags.EMPTY_CREATED),
        )
    }
}
