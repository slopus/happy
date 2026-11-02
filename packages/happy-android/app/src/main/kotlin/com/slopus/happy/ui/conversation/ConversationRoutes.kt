package com.slopus.happy.ui.conversation

import com.slopus.happy.connection.LinkState
import com.slopus.happy.connection.networkPath
import com.slopus.happy.ui.chat.rememberShownLinkState
import com.slopus.happy.ui.page
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.chat.obj
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.ConversationApiException
import com.slopus.happy.conversation.ConversationKeeper
import com.slopus.happy.conversation.ConversationSignal
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.conversation.NewTask
import com.slopus.happy.conversation.UnsentWork
import com.slopus.happy.conversation.WorkChoice
import com.slopus.happy.conversation.WorkKind
import kotlinx.serialization.json.JsonObject
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.artifacts.openArtifact
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import androidx.compose.ui.platform.LocalContext
import com.slopus.happy.ui.artifacts.BrowserRoute
import com.slopus.happy.ui.artifacts.computerName
import com.slopus.happy.ui.browser.LinkOpener
import com.slopus.happy.ui.browser.ProvideLinks
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.serialization.Serializable

/**
 * One conversation of the agent connection [connectionId]; [agentId] null
 * is a new, empty chat. [prefill] goes in the composer once, unsent
 * ([Conversation.prefill]).
 */
@Serializable data class ConversationRoute(val connectionId: String, val agentId: String? = null, val prefill: String? = null)

/** The connection's Chief of Staff chat, found when opened, with [prefix] waiting in its composer. */
@Serializable data class ChiefOfStaffRoute(val connectionId: String, val prefix: String)

/** A conversation's agent page ([AgentPageEntry]). */
@Serializable data class ConversationDetailsRoute(val connectionId: String, val agentId: String)

/** The conversation screens. HappyApp's NavHost calls this once. */
fun NavGraphBuilder.conversationRoutes(graph: AppGraph, nav: NavHostController) {
    page<ConversationRoute> { entry ->
        val route = entry.toRoute<ConversationRoute>()
        ConversationEntry(graph, nav, route)
    }
    page<ChiefOfStaffRoute> { entry ->
        val route = entry.toRoute<ChiefOfStaffRoute>()
        ChiefOfStaffEntry(graph, nav, route)
    }
    page<ConversationDetailsRoute> { entry ->
        val route = entry.toRoute<ConversationDetailsRoute>()
        AgentPageEntry(graph, nav, route)
    }
}

/** Opens a conversation over whatever is up, with [prefill] waiting unsent in its composer. */
fun NavHostController.openConversation(connectionId: String, agentId: String, prefill: String? = null) {
    navigate(ConversationRoute(connectionId, agentId, prefill))
}

/**
 * Opens the connection's Chief of Staff chat with [prefix] in its
 * composer. The chief is looked up when the screen opens; once found the
 * chat takes this screen's place, so Back returns to where this was opened.
 */
fun NavHostController.openChiefOfStaff(connectionId: String, prefix: String) {
    navigate(ChiefOfStaffRoute(connectionId, prefix))
}

/**
 * A new, empty chat: pushed from home; from a chat it replaces that chat
 * (animated by the NavHost's transition), so Back goes home.
 */
fun NavHostController.composeConversation(connectionId: String) {
    val current = currentBackStackEntry
    if (current?.destination?.hasRoute<ConversationRoute>() == true) {
        navigate(ConversationRoute(connectionId)) {
            popUpTo(current.destination.id) { inclusive = true }
        }
    } else {
        navigate(ConversationRoute(connectionId))
    }
}

/**
 * The chat of [agentId] held on this back stack, if its screen's state is
 * still kept there: a page over it reads what it already shows instead of
 * waiting for the computer. Never makes one.
 */
internal fun NavHostController.heldConversation(agentId: String): Conversation? {
    val none = object : ViewModelProvider.Factory {}
    return currentBackStack.value.asReversed().asSequence()
        .filter { it.destination.hasRoute<ConversationRoute>() }
        .mapNotNull { entry ->
            try {
                ViewModelProvider.create(entry.viewModelStore, none)["conversation", ConversationHolder::class].conversation
            } catch (_: Exception) {
                null
            }
        }
        .firstOrNull { it.agentId == agentId }
}

/** The agent connection's client as a conversation asks it: refusals become [ConversationApiException]. */
internal fun AgentSession.conversationRequest(): AgentRequest = { method, path, body, category ->
    try {
        client.send(method, path, body, category = category)
    } catch (e: AgentApiException) {
        throw ConversationApiException(e.status, e.code, e.message)
    }
}

/** Where [agentId]'s newest history is kept, beside the connection's catalog and gone with it. */
internal fun AgentSession.conversationKeeper(agentId: String): ConversationKeeper = object : ConversationKeeper {
    private val key = "conversation$agentId"
    override fun read(): JsonObject? = cachedResource(key)
    override fun write(value: JsonObject) = keepResource(key, value)
}

/** The connection's journal as one conversation hears it: its own events, and a resync on every (re)connect. */
internal fun Flow<AgentEvent>.signalsFor(agentId: String): Flow<ConversationSignal> = mapNotNull { event ->
    when {
        event.type == AgentEvent.HELLO -> ConversationSignal.Resync
        event.agentId == agentId -> ConversationSignal.Event(event.type, event.data)
        else -> null
    }
}

/**
 * The conversation a back stack entry shows, kept through recreation. A
 * new chat's ids, kind and name are saved, so after process death the same
 * chat comes back (and its task or bot, made again with the same ids, is the
 * same one); once made it opens as the chat it became. Left before its first
 * message, it is the connection's unsent work, which the next compose opens
 * as it was left (iOS's Store `unsent`).
 */
internal class ConversationHolder(
    private val session: AgentSession,
    route: ConversationRoute,
    private val saved: SavedStateHandle,
    /** Lays the rows' text out on the conversation's lane. */
    typesetter: Typesetter? = null,
) : ViewModel() {
    /** Not viewModelScope: a send or draft save in flight finishes after the screen goes. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val conversation: Conversation
    private val task: NewTask?

    init {
        // A new chat that is not this entry's own yet takes the work left unsent, if any.
        val unsent = if (route.agentId == null && saved.get<String>(TASK) == null) session.unsentWork?.also { session.unsentWork = null } else null
        task = if (route.agentId != null) null else NewTask(
            saved.get<String>(TASK) ?: (unsent?.task?.taskId ?: ConversationApi.clientId()).also { saved[TASK] = it },
            saved.get<String>(WORKSPACE) ?: (unsent?.task?.workspaceId ?: ConversationApi.clientId()).also { saved[WORKSPACE] = it },
            saved.get<String>(AGENT) ?: (unsent?.task?.agentId ?: ConversationApi.clientId()).also { saved[AGENT] = it },
            saved.get<String>(MUTATION) ?: (unsent?.task?.mutationId ?: ConversationApi.clientId()).also { saved[MUTATION] = it },
        )
        val choice = unsent?.choice ?: WorkChoice(
            if (saved.get<String>(KIND) == WorkKind.Bot.name) WorkKind.Bot else WorkKind.Task,
            saved.get<String>(NAME).orEmpty(),
        )
        unsent?.let { setChoiceSaved(it.choice) }
        val agentId = route.agentId ?: task!!.agentId
        conversation = Conversation(
            api = ConversationApi(session.conversationRequest()),
            signals = session.events.signalsFor(agentId),
            scope = scope,
            agentId = agentId,
            newTask = task.takeIf { saved.get<Boolean>(CREATED) != true },
            initialDraft = unsent?.draft.orEmpty(),
            // The row that was tapped already had a name: the bar has it from the first frame.
            knownTitle = route.agentId?.let(session.feed.value::title),
            initialChoice = choice,
            onTaskCreated = { answer ->
                saved[CREATED] = true
                answer["task"].obj?.let { session.upsertTask(it, answer["membership"].obj) }
                answer["bot"].obj?.let(session::upsertBot)
            },
            keeper = session.conversationKeeper(agentId),
            typesetter = typesetter,
        )
        conversation.start()
        saved.takePrefill(route.prefill)?.let(conversation::prefill)
    }

    /** Task or Bot and the name, kept with the entry as they are picked. */
    fun setChoice(choice: WorkChoice) {
        setChoiceSaved(choice)
        conversation.setChoice(choice)
    }

    private fun setChoiceSaved(choice: WorkChoice) {
        saved[KIND] = choice.kind.name
        saved[NAME] = choice.name
    }

    override fun onCleared() {
        val state = conversation.state.value
        val work = state.newWork
        // Left unmade and not on its way: the next compose opens it as it was.
        if (task != null && work != null && !work.making && saved.get<Boolean>(CREATED) != true) {
            session.unsentWork = UnsentWork(task, work.choice, state.draft)
        }
        conversation.close()
    }

    private companion object {
        const val TASK = "taskId"
        const val WORKSPACE = "workspaceId"
        const val AGENT = "agentId"
        const val MUTATION = "mutationId"
        const val CREATED = "created"
        const val KIND = "kind"
        const val NAME = "name"
    }
}

/**
 * A route's prefill the first time this back stack entry asks for it, and
 * null ever after: a rotation or a return from process death keeps the
 * draft the person has been editing instead of writing the prompt again.
 */
internal fun SavedStateHandle.takePrefill(prefill: String?): String? {
    if (prefill == null || get<Boolean>(PREFILLED) == true) return null
    this[PREFILLED] = true
    return prefill
}

private const val PREFILLED = "prefilled"

/** An agent connection's link as its chats' headers say it: a computer that didn't answer, or a pairing to redo, is offline. */
internal fun AgentLinkStatus?.linkState(syncing: Boolean, network: Boolean): LinkState = when {
    !network -> LinkState.WaitingForNetwork
    this == null || this == AgentLinkStatus.Connected -> if (syncing) LinkState.Syncing else LinkState.Online
    this == AgentLinkStatus.Connecting -> LinkState.Connecting
    else -> LinkState.Offline
}

@Composable
internal fun linkStatusText(status: AgentLinkStatus?, syncing: Boolean = false): String? = when (status) {
    null, AgentLinkStatus.Connected -> if (syncing) stringResource(R.string.status_syncing) else null
    AgentLinkStatus.Connecting -> stringResource(R.string.status_connecting)
    AgentLinkStatus.Offline -> stringResource(R.string.status_offline)
    AgentLinkStatus.Revoked -> stringResource(R.string.conversation_revoked)
    AgentLinkStatus.UpdateRequired -> stringResource(R.string.conversation_update_required)
    AgentLinkStatus.SignInRequired -> stringResource(R.string.team_server_error_sign_in_required)
}

@Composable
private fun ConversationEntry(graph: AppGraph, nav: NavHostController, route: ConversationRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    if (session == null) {
        AgentPageScreen(
            AgentPageState(route.agentId.orEmpty(), reading = false, error = stringResource(R.string.conversation_unavailable)),
            AgentPageActions(onBack = { nav.popBackStack() }),
        )
        return
    }
    val typesetter = Typesetter.of(LocalContext.current)
    // Before the conversation's lane lays out its first rows, which it draws ahead in these colours.
    typesetter.reportPalette(ProsePalette.of(HappyTheme.colors))
    val holder = viewModel(key = "conversation") { ConversationHolder(session, route, createSavedStateHandle(), typesetter) }
    val conversation = holder.conversation
    com.slopus.happy.ui.components.StartedEffect(conversation) {
        conversation.setObserving(true)
        try { kotlinx.coroutines.awaitCancellation() } finally { conversation.setObserving(false) }
    }
    val state by conversation.state.collectAsStateWithLifecycle()
    val status by session.status.collectAsStateWithLifecycle()
    val syncing by session.isSyncing.collectAsStateWithLifecycle()
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    DisposableEffect(conversation) { onDispose { conversation.setVisible(false) } }
    // A link in this chat browses through this chat's agent's workspace (iOS's openBrowser(session:agentID:)).
    val context = LocalContext.current
    val network by remember(context) { context.networkPath() }.collectAsStateWithLifecycle(initialValue = true)
    val link = rememberShownLinkState(status.linkState(syncing, network))
    val computer = computerName(graph, route.connectionId)
    val links = remember(nav, computer, conversation.agentId) {
        LinkOpener.agent(context, computer) { url -> nav.navigate(BrowserRoute(route.connectionId, url, conversation.agentId)) }
    }
    // A command's artwork is read and kept as the agent's other pictures are.
    ProvideLinks(links) { androidx.compose.runtime.CompositionLocalProvider(com.slopus.happy.ui.connection.LocalAgentPictures provides session.pictures) {
        ConversationScreen(
            state = state,
            // Offline says why in words of its own; the link on its way spins (iOS 7aee3a9b8).
            connection = if (link == LinkState.Offline) linkStatusText(status) ?: stringResource(R.string.status_offline) else null,
            link = link,
            bubbleColor = settings.userMessageBubbleColor,
            actions = remember(conversation, nav) {
                ConversationScreenActions(
                    onBack = { nav.popBackStack() },
                    onCompose = { nav.composeConversation(route.connectionId) },
                    onDetails = { nav.navigate(ConversationDetailsRoute(route.connectionId, conversation.agentId)) },
                    onDraftChange = conversation::setDraft,
                    onSend = { words, attachments -> conversation.send(words, attachments) },
                    onModeChange = conversation::setMode,
                    onStop = conversation::stop,
                    onRetrySend = conversation::retrySend,
                    onDiscardSend = conversation::discardSend,
                    onRetryFailure = conversation::retryFailure,
                    onAnswer = conversation::answer,
                    onLoadOlder = { retry -> conversation.loadOlder(retry) },
                    onOpenArtifact = { row -> nav.openArtifact(route.connectionId, row.ref) },
                    onRetryLoad = conversation::retryLoad,
                    loadMedia = conversation::media,
                    // A recording streams a range at a time, as iOS's MediaStream asks.
                    loadMediaRange = { ref, range ->
                        session.client.send(
                            "GET",
                            ConversationApi.mediaPath(conversation.agentId, ref.toolCallId, ref.index),
                            headers = mapOf("Range" to "bytes=${range.first}-${range.last}"),
                            category = RequestCategory.File,
                        )
                    },
                    onVisible = conversation::setVisible,
                    onChoiceChange = holder::setChoice,
                    onCommand = conversation::runCommand,
                    onToggleTurn = conversation::toggleTurn,
                    onToggleMessage = conversation::toggleMessage,
                    // The values typed into a secret go in this one request to the computer and nowhere else.
                    secrets = SecretRequestActions(
                        secrets = { ConversationApi(session.conversationRequest()).secrets() },
                        create = { id, description, values -> ConversationApi(session.conversationRequest()).createSecret(id, description, values) },
                    ),
                )
            },
        )
    } }
    // New work that could not be made says why; nothing was sent, and the composer keeps it all.
    val message = state.alert?.let { problemText(it) } ?: state.workFailure?.let { failure ->
        stringResource(if (failure.kind == WorkKind.Bot) R.string.new_work_bot_failed else R.string.new_work_task_failed, problemText(failure.reason))
    }
    message?.let {
        val title = stringResource(R.string.common_error)
        val ok = stringResource(R.string.common_ok)
        HappyAlert(Alert(title, it, listOf(AlertButton(ok))), onDismiss = conversation::dismissAlert)
    }
}

/**
 * Finds the connection's Chief of Staff ([ConversationApi.chiefOfStaffAgentId])
 * and opens its chat in this screen's place. Until then the bar says
 * "Chief of Staff" over a spinner; offline, or with no chief on the
 * computer, it says so with Retry, and never opens another chat.
 */
@Composable
private fun ChiefOfStaffEntry(graph: AppGraph, nav: NavHostController, route: ChiefOfStaffRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    val missing = stringResource(R.string.conversation_chief_missing)
    val unavailable = stringResource(R.string.conversation_unavailable)
    var attempt by rememberSaveable { mutableIntStateOf(0) }
    val resources = LocalResources.current
    var problem by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(session, attempt) {
        problem = null
        if (session == null) {
            problem = unavailable
            return@LaunchedEffect
        }
        val agentId = try {
            ConversationApi(session.conversationRequest()).chiefOfStaffAgentId()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            problem = resources.problemText(Conversation.describe(e))
            return@LaunchedEffect
        }
        if (agentId == null) {
            problem = missing
            return@LaunchedEffect
        }
        nav.navigate(ConversationRoute(route.connectionId, agentId, route.prefix)) {
            popUpTo<ChiefOfStaffRoute> { inclusive = true }
        }
    }
    ChiefOfStaffScreen(problem, onRetry = { attempt++ }, onBack = { nav.popBackStack() })
}
