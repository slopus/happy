package com.slopus.happy.ui.conversation

import com.slopus.happy.agent.Permission
import com.slopus.happy.analytics.Analytics
import com.slopus.happy.analytics.AnalyticsEvent
import com.slopus.happy.analytics.ChatAddress
import com.slopus.happy.analytics.FailureKind
import com.slopus.happy.analytics.ProviderKind
import com.slopus.happy.analytics.SessionClient
import com.slopus.happy.ui.backStackEntries

import com.slopus.happy.connection.LinkState
import com.slopus.happy.connection.networkPath
import com.slopus.happy.ui.files.workspaceSource
import com.slopus.happy.ui.chat.rememberShownLinkState
import com.slopus.happy.ui.page
import com.slopus.happy.ui.plugins.openPlugin
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavBackStackEntry
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
import com.slopus.happy.agent.chiefOfStaffName
import com.slopus.happy.chat.obj
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.ConversationApiException
import com.slopus.happy.conversation.ConversationKeeper
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationSignal
import com.slopus.happy.conversation.HeldConversations
import com.slopus.happy.conversation.RowTypesetter
import com.slopus.happy.conversation.KeptMedia
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.conversation.NewTask
import com.slopus.happy.conversation.UnsentWork
import com.slopus.happy.conversation.WorkChoice
import com.slopus.happy.conversation.WorkKind
import com.slopus.happy.media.MediaPiece
import kotlinx.serialization.json.JsonObject
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.artifacts.openArtifact
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import androidx.compose.ui.platform.LocalContext
import com.slopus.happy.browser.BrowserPolicy
import com.slopus.happy.ui.artifacts.BrowserRoute
import com.slopus.happy.ui.artifacts.InlinePages
import com.slopus.happy.ui.genui.GenUiInline
import com.slopus.happy.ui.artifacts.computerName
import com.slopus.happy.ui.browser.LinkOpener
import com.slopus.happy.ui.browser.ProvideLinks
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.serialization.Serializable

/**
 * One conversation of the agent connection [connectionId]; [agentId] null
 * is a new, empty chat. [prefill] goes in the composer once, unsent
 * ([Conversation.prefill]).
 */
@Serializable data class ConversationRoute(
    val connectionId: String,
    val agentId: String? = null,
    val prefill: String? = null,
    /** New work opens with "+"'s sheet up (search's "New task with a picture", happy-ios 7a605f6ce). */
    val attach: Boolean = false,
)

/** The connection's Chief of Staff chat, found when opened, with [prefix] waiting in its composer. */
@Serializable data class ChiefOfStaffRoute(val connectionId: String, val prefix: String)

/** A conversation's agent page ([AgentPageEntry]). */
@Serializable data class ConversationDetailsRoute(val connectionId: String, val agentId: String)

/** One tool call of [agentId]'s conversation on its own screen ([ToolCallEntry]); with [file], that one file of its edit. */
@Serializable data class ToolCallRoute(val connectionId: String, val agentId: String, val callId: String, val file: String? = null)

/** A workspace's changes against its comparison base ([WorkspaceChangesEntry]). */
@Serializable data class WorkspaceChangesRoute(val connectionId: String, val workspaceId: String)

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
    page<ToolCallRoute> { entry ->
        val route = entry.toRoute<ToolCallRoute>()
        ToolCallEntry(graph, nav, route)
    }
    page<WorkspaceChangesRoute> { entry ->
        val route = entry.toRoute<WorkspaceChangesRoute>()
        WorkspaceChangesEntry(graph, nav, route)
    }
}

/** Opens a conversation over whatever is up, with [prefill] waiting unsent in its composer. */
fun NavHostController.openConversation(connectionId: String, agentId: String, prefill: String? = null) {
    navigate(ConversationRoute(connectionId, agentId, prefill))
}

/**
 * A conversation a voice call opens (iOS's `CallNavigation`): in place of a
 * conversation on top, so going from one to the next never piles them up
 * behind each other; pushed over anything else (home, Settings, a profile),
 * which stays under it.
 */
fun NavHostController.openConversationInPlace(connectionId: String, agentId: String) {
    val current = currentBackStackEntry
    if (current?.destination?.hasRoute<ConversationRoute>() == true) {
        navigate(ConversationRoute(connectionId, agentId)) {
            popUpTo(current.destination.id) { inclusive = true }
        }
    } else {
        navigate(ConversationRoute(connectionId, agentId))
    }
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
fun NavHostController.composeConversation(connectionId: String, attach: Boolean = false) {
    val current = currentBackStackEntry
    if (current?.destination?.hasRoute<ConversationRoute>() == true) {
        navigate(ConversationRoute(connectionId, attach = attach)) {
            popUpTo(current.destination.id) { inclusive = true }
        }
    } else {
        navigate(ConversationRoute(connectionId, attach = attach))
    }
}

/** The conversation [entry] shows, once its screen holds one ([ConversationHolder]); null for any other page. */
internal fun NavBackStackEntry.shownConversation(): Conversation? {
    if (!destination.hasRoute<ConversationRoute>()) return null
    val none = object : ViewModelProvider.Factory {}
    return try {
        ViewModelProvider.create(viewModelStore, none)["conversation", ConversationHolder::class].conversation
    } catch (_: Exception) {
        null
    }
}

/**
 * The chat of [agentId] held on this back stack, if its screen's state is
 * still kept there: a page over it reads what it already shows instead of
 * waiting for the computer. Never makes one.
 */
internal fun NavHostController.heldConversation(agentId: String): Conversation? {
    val none = object : ViewModelProvider.Factory {}
    return backStackEntries.value.asReversed().asSequence()
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
        throw ConversationApiException(e.status, e.code, e.message, e.body as? kotlinx.serialization.json.JsonObject)
    }
}

/** [conversationRequest] for a body already made as JSON bytes: a workspace file's upload. */
internal fun AgentSession.conversationBytesRequest(): com.slopus.happy.conversation.AgentBytesRequest = { method, path, body, _ ->
    try {
        client.sendBytes(method, path, body, mapOf("Content-Type" to "application/json"))
    } catch (e: AgentApiException) {
        throw ConversationApiException(e.status, e.code, e.message, e.body as? kotlinx.serialization.json.JsonObject)
    }
}

/** [conversationRequest] for a file's own bytes, with their type and range: an attachment's upload. */
internal fun AgentSession.conversationFileRequest(): com.slopus.happy.conversation.AgentFileRequest = { method, path, body, headers ->
    try {
        client.sendBytes(method, path, body, headers)
    } catch (e: AgentApiException) {
        throw ConversationApiException(e.status, e.code, e.message, e.body as? kotlinx.serialization.json.JsonObject)
    }
}

/**
 * [agentId]'s conversation as each of its holders has it
 * ([AgentSession.conversations]): the connection's requests, keeper, read and
 * references, laid out by the process's [typesetter]. Its [newTask] and the
 * rest are a new chat's, when its screen makes it.
 */
internal fun AgentSession.makeConversation(
    agentId: String,
    typesetter: RowTypesetter?,
    newTask: NewTask? = null,
    initialDraft: String = "",
    initialChoice: WorkChoice = WorkChoice(),
    created: () -> Unit = {},
): Conversation = Conversation(
    api = ConversationApi(
        bytesRequest = conversationBytesRequest(), request = conversationRequest(), cloud = client.cloud, fileRequest = conversationFileRequest(),
        sendingDevice = { client.environment.sendingDeviceId },
    ),
    signals = events.signalsFor(agentId),
    // No screen's or call's: a send or draft save in flight finishes after they go.
    scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    agentId = agentId,
    newTask = newTask,
    initialDraft = initialDraft,
    // The row that was tapped already had a name: the bar has it from the first frame.
    knownTitle = feed.value.title(agentId),
    initialChoice = initialChoice,
    onTaskCreated = { answer ->
        created()
        answer["task"].obj?.let { upsertTask(it, answer["membership"].obj) }
        answer["bot"].obj?.let(::upsertBot)
    },
    keeper = conversationKeeper(agentId),
    typesetter = typesetter,
    read = ::markRead,
    references = references,
    hasSettingsPage = settingsPages(),
    cloudFiles = client.cloud,
    attachmentRoute = attachmentRoute,
    keepAttachment = { id, file -> media?.store?.keep(com.slopus.happy.conversation.KeptMedia.attachmentId(agentId, id), file) },
    here = ::isHere,
    preferences = modelPreferences,
    onStarted = ::recordStart,
    address = { ChatAddress.of(catalog.value, agentId) },
)

/** Which settings pages this connection has ([com.slopus.happy.ui.connection.SettingsLinks]): a link to any other reads as its words. */
internal fun AgentSession.settingsPages(): (String) -> Boolean {
    val cloud = com.slopus.happy.connection.HappyCloud.isServer(server)
    return { page -> com.slopus.happy.ui.connection.SettingsLinks.place(page, server, cloud) != null }
}

/** Where [agentId]'s newest history is kept, beside the connection's catalog and gone with it. */
internal fun AgentSession.conversationKeeper(agentId: String): ConversationKeeper = object : ConversationKeeper {
    private val key = "conversation$agentId"
    override fun read(): JsonObject? = cachedResource(key)
    override fun write(value: JsonObject) = keepResource(key, value)
}

/** The connection's journal as one conversation hears it: its own events, configuration and skill changes, and a resync on every (re)connect. */
internal fun Flow<AgentEvent>.signalsFor(agentId: String): Flow<ConversationSignal> = mapNotNull { event ->
    when {
        event.type == AgentEvent.HELLO -> ConversationSignal.Resync
        event.agentId == agentId -> ConversationSignal.Event(event.type, event.data)
        // The computer's configuration (its models) changed: every conversation's pickers follow.
        event.type == "config.updated" -> ConversationSignal.Event(event.type, event.data)
        // Its skills changed: a new chat's "/" list follows.
        event.type == Conversation.SKILLS_UPDATED -> ConversationSignal.Event(event.type, event.data)
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
    /** This screen's claim on the connection's one conversation of its agent, which a call may share. */
    val hold: HeldConversations.Hold
    val conversation: Conversation get() = hold.conversation
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
        // The one a call holds, or a send still on its way when this chat was last left (new work's first message
        // too): the same conversation, so it shows and never goes twice.
        hold = session.conversations.hold(agentId) {
            session.makeConversation(
                agentId,
                typesetter,
                newTask = task.takeIf { saved.get<Boolean>(CREATED) != true },
                initialDraft = unsent?.draft.orEmpty(),
                initialChoice = choice,
                created = {
                    saved[CREATED] = true
                    // Made, it is home's to open now, not the next compose's.
                    if (session.unsentWork?.task?.agentId == agentId) session.unsentWork = null
                },
            )
        }
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
        // Left unmade, its first message on its way or not: the next compose opens it as it was.
        if (task != null && work != null && saved.get<Boolean>(CREATED) != true) {
            session.unsentWork = UnsentWork(task, work.choice, state.draft)
        }
        // Closed once nobody holds it, unless a send is in hand: then it finishes in this conversation (desktop 01659140).
        hold.release()
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

/** `chat_failure_shown` for [row], a Happy Agent conversation's, once per message while fresh. */
private fun failureShown(row: ConversationRow.Failure, address: ChatAddress) {
    val event = AnalyticsEvent.ChatFailureShown(FailureKind.of(row.kind), ProviderKind.of(row.providerType), row.pool, address.target, SessionClient.HappyAgent)
    Analytics.failureShown(row.messageId, row.createdAt, event)
}

/**
 * An agent connection's link as its chats' headers say it. No link is ever
 * offline: one not connected is asked again until it is, so it is
 * connecting, whatever kept it away (a computer that didn't answer, a
 * pairing to redo: home says those in words of its own). Reading the
 * snapshot is catching up, not connecting: the computer or server answered
 * (iOS's `Session.headerState`, `.connected` with the stream down).
 */
internal fun AgentLinkStatus?.linkState(syncing: Boolean, network: Boolean): LinkState = when {
    !network -> LinkState.WaitingForNetwork
    syncing -> LinkState.Syncing
    this == null || this == AgentLinkStatus.Connected -> LinkState.Online
    else -> LinkState.Connecting
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
    com.slopus.happy.ui.references.ProvideReferenceWords(session.references)
    val holder = viewModel(key = "conversation") { ConversationHolder(session, route, createSavedStateHandle(), typesetter) }
    val conversation = holder.conversation
    com.slopus.happy.ui.components.StartedEffect(conversation) {
        holder.hold.observe(true)
        try { kotlinx.coroutines.awaitCancellation() } finally { holder.hold.observe(false) }
    }
    val state by conversation.state.collectAsStateWithLifecycle()
    // The model label warns as its account runs low, so the readings are followed while the chat shows.
    com.slopus.happy.ui.components.StartedEffect(session) {
        val following = session.usage.follow()
        try { kotlinx.coroutines.awaitCancellation() } finally { following.close() }
    }
    val usage by session.usage.usage.collectAsStateWithLifecycle()
    val status by session.status.collectAsStateWithLifecycle()
    val syncing by session.isSyncing.collectAsStateWithLifecycle()
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    DisposableEffect(holder) { onDispose { holder.hold.show(false) } }
    // A link in this chat browses through this chat's agent's workspace (iOS's openBrowser(session:agentID:)).
    val context = LocalContext.current
    val network by remember(context) { context.networkPath() }.collectAsStateWithLifecycle(initialValue = true)
    val link = rememberShownLinkState(status.linkState(syncing, network))
    val computer = computerName(graph, route.connectionId)
    // A name a message wrote, or a Happy URL, opens what it names here.
    val happyLinks = com.slopus.happy.ui.connection.LocalHappyLinks.current
    val references = remember(nav, session, happyLinks) { com.slopus.happy.ui.references.ReferenceOpener(nav, route.connectionId, session.references, happyLinks) }
    val links = remember(nav, computer, conversation.agentId, references) {
        LinkOpener.agent(context, computer, app = references::open, opens = references::opens) { url -> nav.navigate(BrowserRoute(route.connectionId, url, conversation.agentId)) }
    }
    val kept = rememberKeptMedia(graph, session, conversation.agentId)
    // A team's role writes content; the Chief of Staff, an admin bot, takes words only from those who manage bots.
    val permissions by session.permissions.collectAsStateWithLifecycle()
    val chief by remember(session, conversation.agentId) {
        session.catalog.map { ChatAddress.of(it, conversation.agentId).chiefOfStaff }.distinctUntilChanged()
    }.collectAsStateWithLifecycle(false)
    val roleCanSend = permissions.allows(if (chief) Permission.BOTS_MANAGE else Permission.CONTENT_WRITE)
    // A command's artwork is read and kept as the agent's other pictures are.
    ProvideLinks(links) { androidx.compose.runtime.CompositionLocalProvider(com.slopus.happy.ui.connection.LocalAgentPictures provides session.pictures) {
        ConversationScreen(
            state = state,
            opensAttach = route.attach,
            roleCanSend = roleCanSend,
            roleCanCompose = permissions.canWrite,
            link = link,
            usage = usage,
            onRefreshUsage = session.usage::refresh,
            bubbleColor = settings.userMessageBubbleColor,
            actions = remember(conversation, nav, kept) {
                ConversationScreenActions(
                    onBack = { nav.popBackStack() },
                    onCompose = { nav.composeConversation(route.connectionId) },
                    onDetails = { nav.navigate(ConversationDetailsRoute(route.connectionId, conversation.agentId)) },
                    onDraftChange = conversation::setDraft,
                    onSend = { words, attachments -> conversation.send(words, attachments) },
                    onSendPending = { words, attachments, pending -> conversation.send(words, attachments, pending) },
                    onModeChange = conversation::setMode,
                    onStop = conversation::stop,
                    onRetrySend = conversation::retrySend,
                    onDiscardSend = conversation::discardSend,
                    uploads = conversation.uploads,
                    onRemovePicture = conversation::removePicture,
                    onRetryFailure = conversation::retryFailure,
                    onFailureShown = { row -> failureShown(row, ChatAddress.of(session.catalog.value, conversation.agentId)) },
                    onAnswer = conversation::answer,
                    onLoadOlder = { retry -> conversation.loadOlder(retry) },
                    onOpenArtifact = { row -> nav.openArtifact(route.connectionId, row.ref) },
                    // A Happy URL a page followed opens in the app; any other its own browser.
                    pages = InlinePages.of(session.client) { url ->
                        if (happyLinks?.open(url, route.connectionId) != true && BrowserPolicy.route(url) == BrowserPolicy.Route.Web) {
                            nav.navigate(BrowserRoute(route.connectionId, url, conversation.agentId))
                        }
                    },
                    genUi = GenUiInline(
                        session.client, session.media, conversation.agentId,
                        onMessage = { words -> conversation.send(words) },
                        onOpenWeb = { url -> nav.navigate(BrowserRoute(route.connectionId, url, conversation.agentId)) },
                        plugins = session.pluginsAvailable,
                        onOpenPlugin = { id -> nav.openPlugin(route.connectionId, id) },
                    ),
                    onRetryLoad = conversation::retryLoad,
                    loadMedia = conversation::media,
                    // A recording streams a range at a time, as iOS's MediaStream asks.
                    loadMediaRange = { ref, range ->
                        session.client.send(
                            "GET",
                            ConversationApi.mediaPath(conversation.agentId, ref),
                            headers = mapOf("Range" to "bytes=${range.first}-${range.last}"),
                            category = RequestCategory.File,
                        )
                    },
                    kept = kept,
                    onVisible = holder.hold::show,
                    onChoiceChange = holder::setChoice,
                    onCommand = conversation::runCommand,
                    onToggleTurn = conversation::toggleTurn,
                    onToggleMessage = conversation::toggleMessage,
                    onOpenTool = { callId -> nav.navigate(ToolCallRoute(route.connectionId, conversation.agentId, callId)) },
                    workspace = if (session.client.cloud) null else session::workspaceSource,
                    // The values typed into a secret go in this one request to the computer and nowhere else.
                    secrets = SecretRequestActions(
                        secrets = { ConversationApi(session.conversationRequest()).secrets() },
                        create = { id, description, values -> ConversationApi(session.conversationRequest()).createSecret(id, description, values) },
                    ),
                )
            },
        )
    } }
    state.alert?.let { problemText(it) }?.let {
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
    // Its name as the computer calls it, read live from the bot whose systemKey is chief_of_staff (desktop ca4c303f).
    val chief by remember(session) { session?.feed?.map { feed -> feed.chiefOfStaffName() } ?: flowOf(null) }
        .collectAsStateWithLifecycle(initialValue = remember(session) { session?.feed?.value?.chiefOfStaffName() })
    ChiefOfStaffScreen(problem, onRetry = { attempt++ }, onBack = { nav.popBackStack() }, name = chief)
}

/** [agentId]'s presented media, read into the connection's library once and kept (iOS ba7b68346); null where the session keeps nothing. */
@Composable
internal fun rememberKeptMedia(graph: AppGraph, session: AgentSession, agentId: String): KeptMedia? {
    val scope = rememberCoroutineScope()
    return remember(session, agentId) {
        session.media?.let { library ->
            KeptMedia(
                library = library,
                agentId = agentId,
                range = { ref, span ->
                    session.client.send(
                        "GET",
                        ConversationApi.mediaPath(agentId, ref),
                        headers = mapOf("Range" to MediaPiece.header(span)),
                        category = RequestCategory.File,
                    )
                },
                rules = graph.mediaAutoDownload.rules,
                scope = scope,
            )
        }
    }
}
