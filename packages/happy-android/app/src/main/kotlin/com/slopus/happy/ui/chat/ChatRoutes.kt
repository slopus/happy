package com.slopus.happy.ui.chat

import com.slopus.happy.ui.page
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.chat.ChatActions
import com.slopus.happy.chat.ChatFeed
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.ComposerModeResolver
import com.slopus.happy.chat.NoLivePresence
import com.slopus.happy.chat.PendingAgentCommunication
import com.slopus.happy.chat.StoreChatMessagesSource
import com.slopus.happy.chat.StoreChatSessionSource
import com.slopus.happy.chat.SyncChatActions
import com.slopus.happy.chat.SyncChatMessagesSource
import com.slopus.happy.chat.SyncChatPresenceSource
import com.slopus.happy.model.Machine
import com.slopus.happy.model.SessionState
import com.slopus.happy.model.gitStatusKey
import com.slopus.happy.model.isCliOutdated
import com.slopus.happy.model.resumeCommandBlock
import com.slopus.happy.projects.GitStatusServices
import com.slopus.happy.resume.ChatResumeOps
import com.slopus.happy.resume.ResumeOutcome
import com.slopus.happy.resume.SessionResumer
import com.slopus.happy.resume.rememberResumeTexts
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.ui.attachments.LocalComposerImages
import com.slopus.happy.ui.attachments.LocalSessionAttachments
import com.slopus.happy.ui.attachments.attachmentNoticeAlert
import com.slopus.happy.ui.attachments.canUseAttachments
import com.slopus.happy.ui.attachments.prepareComposerAttachments
import com.slopus.happy.ui.attachments.rememberComposerImages
import com.slopus.happy.ui.attachments.rememberSessionAttachments
import com.slopus.happy.ui.autocomplete.LocalSuggestionSource
import com.slopus.happy.ui.autocomplete.rememberSessionSuggestions
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.session.rememberPendingChatRoute
import com.slopus.happy.ui.session.rememberSessionScreenSlots
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.files.MessageDetailRoute
import com.slopus.happy.ui.files.toolPressRoute
import com.slopus.happy.ui.home.SessionViewingEffect
import com.slopus.happy.ui.home.resumeAvailability
import com.slopus.happy.ui.usage.LocalUsageDisplay
import com.slopus.happy.ui.usage.UsageDisplay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

/** `/session/{id}`: one chat, or an empty one compose opened (a `compose-chat:` id, [ComposeChat]). */
@Serializable
data class SessionRoute(val id: String)

/**
 * The chat's destinations. [actions] go to the signed-in account (its
 * sender, composer and session RPCs). [onInfo] opens `/session/{id}/info`.
 */
fun NavGraphBuilder.chatRoutes(
    graph: AppGraph,
    nav: NavHostController,
    actions: ChatActions = SyncChatActions { graph.account.value },
    onInfo: (sessionId: String) -> Unit = {},
) {
    page<SessionRoute> { entry ->
        val route = entry.toRoute<SessionRoute>()
        // Each takes the chat the screen shows, which a compose chat's route id is not once it has started.
        ChatRoute(
            graph, route.id, actions,
            onBack = { nav.popBackStack() },
            onInfo = onInfo,
            // An empty chat in this one's place, so Back still leads home.
            onCompose = { nav.composeChat(inPlace = true) },
            onToolPress = { sessionId, message -> nav.navigate(toolPressRoute(sessionId, message)) },
            onToolFilePress = { sessionId, message, file -> nav.navigate(MessageDetailRoute(sessionId, message.id, file = file)) },
            // A resume that comes back as another session, or another tab of the checkout, replaces this chat in place.
            onOpenSession = { shown, id -> if (id != shown) nav.navigate(SessionRoute(id)) { popUpTo<SessionRoute> { inclusive = true } } },
            onComposeStarted = { id -> entry.savedStateHandle[COMPOSE_STARTED] = id },
        )
    }
}

@Composable
private fun ChatRoute(
    graph: AppGraph,
    routeId: String,
    actions: ChatActions,
    onBack: () -> Unit,
    onInfo: (sessionId: String) -> Unit,
    onCompose: () -> Unit,
    onToolPress: (sessionId: String, ChatMessage.ToolCallMessage) -> Unit,
    onToolFilePress: (sessionId: String, ChatMessage.ToolCallMessage, String) -> Unit,
    onOpenSession: (shown: String, sessionId: String) -> Unit,
    /** A compose chat's first send started this session. */
    onComposeStarted: (sessionId: String) -> Unit = {},
) {
    // A chat opened from a tab strip's `+` stands on its stand-in's id until the machine names it (Home's pending chats);
    // one compose opened, on its own id until its first send has started the session.
    val route = rememberPendingChatRoute(graph, routeId)
    val compose = rememberComposeChat(graph, routeId)
    compose?.startedId?.let { started -> LaunchedEffect(started) { onComposeStarted(started) } }
    val sessionId = compose?.sessionId ?: route.sessionId
    val account by graph.account.collectAsStateWithLifecycle()
    val feed = remember(account) {
        val sync = account
        ChatFeed(
            messages = sync?.let { SyncChatMessagesSource(it.messages, it.sender) } ?: StoreChatMessagesSource(graph.store),
            sessions = StoreChatSessionSource(graph.store),
            presence = sync?.let { SyncChatPresenceSource(it.presence) } ?: NoLivePresence,
        )
    }
    val state by remember(feed, sessionId) { feed.state(sessionId) }.collectAsStateWithLifecycle(ChatState())
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    // No session yet: the composer is the new-session draft's.
    val drafting = compose?.composing == true
    // The empty chat stands until the session its send started has loaded, so nothing flashes between.
    val composing = compose != null && (drafting || state.session == null)
    // One flow per account and chat: a new one would start a new draft.
    val mirrorFlow = remember(account, sessionId, drafting) { if (drafting) compose?.mirror else account?.composer?.mirror(sessionId) }
    val mirror by remember(mirrorFlow, drafting) { mirrorFlow.takeUnless { drafting } ?: flowOf(ComposerMirror()) }.collectAsStateWithLifecycle(ComposerMirror())
    val draft = rememberComposerDraft(mirrorFlow, onWrite = { text ->
        when {
            compose?.composing == true -> compose.writeDraft(text)
            !route.writeDraft(text) -> actions.setDraft(sessionId, text)
        }
    })
    route.SeedDraft(draft)
    val resources = LocalResources.current
    val metadata = state.session?.metadata
    val modes = remember(metadata, mirror, settings.agentDefaultOverrides) {
        ComposerModeResolver.resolve(metadata, mirror, settings.agentDefaultOverrides, resources::getString)
    }
    val latestMirror by rememberUpdatedState(mirror)
    val local by graph.localSettings.values.collectAsStateWithLifecycle()

    // sync.ts onSessionVisible's git half: the checkout is asked for its status now.
    val git = remember(graph) { GitStatusServices.of(graph) }
    LaunchedEffect(git, sessionId, account, drafting) { if (account != null && !drafting) git.sessionVisible(sessionId) }
    // useSessionVisibility: the open chat reads at once and can't turn unread.
    if (!drafting) SessionViewingEffect(graph, sessionId)
    val statuses by git.statuses.collectAsStateWithLifecycle()
    val gitStatus = gitStatusKey(metadata?.machineId, metadata?.path)?.let(statuses::get)

    // SessionView.tsx `shouldShowCliWarning`: an outdated CLI not yet acknowledged on this machine.
    val cliVersion = metadata?.version
    val machineId = metadata?.machineId
    val showCliWarning = isCliOutdated(cliVersion) && !(machineId != null && local.acknowledgedCliVersions[machineId] == cliVersion)
    val machine by rememberMachine(graph, machineId)
    var resuming by remember { mutableStateOf(false) }
    val resumer = remember(graph) { SessionResumer.of(graph) }
    val resumeTexts = rememberResumeTexts()
    val scope = rememberCoroutineScope()
    var sending by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val notSent = stringResource(R.string.errors_unknown_error)
    val latestState by rememberUpdatedState(state)
    val latestSettings by rememberUpdatedState(settings)
    // An empty chat takes images for its first message; whether they can go is the start's to say.
    val images = rememberComposerImages(enabled = composing || (state.session != null && canUseAttachments(state.session?.metadata)))
    val latestImages by rememberUpdatedState(images)
    val notices = remember { mutableStateListOf<Alert>() }
    // Not lifecycle-bound: the change to the background is the one that matters.
    val foreground by graph.isForeground.collectAsState()

    fun report(e: Exception) {
        failure = e.message?.takeIf { it.isNotBlank() } ?: notSent
    }

    val latestCompose by rememberUpdatedState(onCompose)
    val screenActions = remember(sessionId, actions, feed, draft, resources, route, compose) {
        ChatScreenActions(
            onBack = onBack,
            onInfo = { onInfo(sessionId) },
            // An empty chat already here stays.
            onCompose = { if (compose?.composing != true) latestCompose() },
            onToolPress = { message -> onToolPress(sessionId, message) },
            onToolFilePress = { message, file -> onToolFilePress(sessionId, message, file) },
            onDraftChange = draft::set,
            onSend = onSend@{ text ->
                if (compose != null && compose.composing) {
                    return@onSend compose.send(text, latestImages) { started, rest -> actions.setDraft(started, rest) }
                }
                if (route.submit(text)) return@onSend draft.set("")
                val picked = latestImages?.images?.toList().orEmpty()
                if ((text.isBlank() && picked.isEmpty()) || sending) return@onSend
                // Questions the agent is blocked on are dismissed once the
                // message is delivered: it stands as the user's answer.
                val questions = latestState.pendingCommunications
                sending = true
                scope.launch {
                    try {
                        val plan = prepareComposerAttachments(graph, sessionId, latestState.session?.metadata, text, latestImages)
                        plan.notices.forEach { notices += attachmentNoticeAlert(it, resources) }
                        if (!plan.send || (text.isBlank() && plan.records.isEmpty())) return@launch
                        actions.send(sessionId, text, attachments = plan.records, awaitDelivery = questions.isNotEmpty())
                        picked.forEach { latestImages?.remove(it.id) }
                        // The composer empties once the text is accepted, unless it was edited meanwhile.
                        if (draft.text == text) draft.set("")
                        for (question in questions) {
                            val kind = (question as? PendingAgentCommunication.Unsupported)?.rawKind ?: "form"
                            runCatching { actions.cancelQuestion(sessionId, question.id, kind) }
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        report(e)
                    } finally {
                        sending = false
                    }
                }
            },
            // AgentInput.tsx: a failed stop shakes the button rather than raising an alert.
            onAbort = { actions.abort(sessionId) },
            loadOlder = { account?.messages?.loadOlder(sessionId) ?: false },
            onPermission = { answer, mode ->
                actions.answerPermission(sessionId, answer)
                if (mode != null) actions.setModes(sessionId, mapOf(AgentModeField.PERMISSION_MODE to mode))
            },
            onRetry = { localId -> scope.launch { runCatching { actions.retry(sessionId, localId) } } },
            onDiscard = { localId -> scope.launch { runCatching { actions.discard(sessionId, localId) } } },
            onAnswerQuestion = { id, answers, kind -> actions.answerQuestion(sessionId, id, answers, kind) },
            onCancelQuestion = { id, kind -> actions.cancelQuestion(sessionId, id, kind) },
            onDismissCliWarning = {
                val machine = latestState.session?.metadata?.machineId
                val version = latestState.session?.metadata?.version
                if (machine != null && version != null) {
                    graph.localSettings.change { it.copy(acknowledgedCliVersions = it.acknowledgedCliVersions + (machine to version)) }
                }
            },
            onResume = onResume@{
                val session = latestState.session ?: return@onResume
                val machine = session.metadata?.machineId ?: return@onResume
                if (resuming) return@onResume
                resuming = true
                scope.launch {
                    try {
                        val ops = ChatResumeOps(actions, { latestMirror }, { latestSettings.agentDefaultOverrides })
                        when (val outcome = resumer.resume(ops, sessionId, machine, session.metadata, resumeTexts)) {
                            is ResumeOutcome.Resumed -> onOpenSession(sessionId, outcome.sessionId)
                            is ResumeOutcome.Failed -> failure = outcome.message
                            ResumeOutcome.InFlight -> Unit
                        }
                    } finally {
                        resuming = false
                    }
                }
            },
            onModeChange = { field, option ->
                val patch = ComposerModeResolver.patch(field, option, latestState.session?.metadata, latestMirror)
                scope.launch {
                    try {
                        actions.setModes(sessionId, patch)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        report(e)
                    }
                }
            },
        )
    }

    CompositionLocalProvider(
        LocalSessionAttachments provides rememberSessionAttachments(graph, sessionId),
        LocalComposerImages provides images,
        LocalSuggestionSource provides rememberSessionSuggestions(graph, sessionId, state.session?.metadata),
        LocalUsageDisplay provides UsageDisplay(settings.alwaysShowContextSize, settings.usageLimitShowRemaining),
    ) {
        // A compose chat that has started is its session's chat: the checkout's tabs are that session's.
        val slots = rememberSessionScreenSlots(graph, if (compose != null) sessionId else routeId, route.pending, state, onSwitch = { onOpenSession(sessionId, it) }, onBack = onBack)
        val chatSlots = if (compose != null && composing) {
            ChatScreenSlots(
                headerSubtitle = compose.progress(),
                pending = ChatPendingSlot(compose.session, focusComposer = true) { ComposeTarget(compose) },
            )
        } else {
            slots.chat
        }
        ChatScreen(
            state = state,
            draft = draft.text,
            bubbleColor = settings.userMessageBubbleColor,
            actions = screenActions,
            compactToolCalls = settings.compactToolCalls,
            groupToolCalls = settings.groupToolCalls,
            foreground = foreground,
            showLineNumbersInToolViews = settings.showLineNumbersInToolViews,
            modes = modes,
            gitStatus = gitStatus,
            showCliWarning = showCliWarning,
            slots = chatSlots,
            goalBar = slots.goalBar,
            activityBar = slots.activityBar,
            inactiveHint = state.session?.let { session ->
                // happy-app: a disconnected Happy CLI session; a Happy Agent session has its own lifecycle.
                if (state.sessionState != SessionState.Disconnected || session.isRig) return@let null
                InactiveHint(resumeAvailability(session.session, machine).canResume, resuming, session.metadata.resumeCommandBlock())
            },
        )
    }
    compose?.Dialogs()
    notices.firstOrNull()?.let { HappyAlert(it, onDismiss = { notices.removeAt(0) }) }
    failure?.let { message ->
        HappyAlert(
            Alert(stringResource(R.string.common_error), message, listOf(AlertButton(stringResource(R.string.common_ok)))),
            onDismiss = { failure = null },
        )
    }
}

/** The session's machine as the store has it now, re-read when machines change (off the main thread). */
@Composable
private fun rememberMachine(graph: AppGraph, machineId: String?): State<Machine?> {
    val versions by graph.store.versions.collectAsStateWithLifecycle()
    return produceState<Machine?>(null, machineId, versions.machines, versions.machineActivity) {
        value = machineId?.let { id -> withContext(Dispatchers.IO) { graph.store.machine(id)?.let(Machine::from) } }
    }
}
