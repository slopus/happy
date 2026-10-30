package com.slopus.happy.ui.conversation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.chat.obj
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ArtifactView
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.ConversationApiException
import com.slopus.happy.conversation.ConversationSignal
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.NewTask
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
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

/** One artifact of the computer this conversation is on. */
@Serializable data class ArtifactRoute(val connectionId: String, val artifactId: String)

/** A conversation's details. */
@Serializable data class ConversationDetailsRoute(val connectionId: String, val agentId: String)

/** The conversation screens. HappyApp's NavHost calls this once. */
fun NavGraphBuilder.conversationRoutes(graph: AppGraph, nav: NavHostController) {
    composable<ConversationRoute> { entry ->
        val route = entry.toRoute<ConversationRoute>()
        ConversationEntry(graph, nav, route)
    }
    composable<ChiefOfStaffRoute> { entry ->
        val route = entry.toRoute<ChiefOfStaffRoute>()
        ChiefOfStaffEntry(graph, nav, route)
    }
    composable<ArtifactRoute> { entry ->
        val route = entry.toRoute<ArtifactRoute>()
        ArtifactEntry(graph, nav, route)
    }
    composable<ConversationDetailsRoute> { entry ->
        val route = entry.toRoute<ConversationDetailsRoute>()
        ConversationDetails(graph, nav, route)
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

/** The agent connection's client as a conversation asks it: refusals become [ConversationApiException]. */
internal fun AgentSession.conversationRequest(): AgentRequest = { method, path, body ->
    try {
        client.send(method, path, body)
    } catch (e: AgentApiException) {
        throw ConversationApiException(e.status, e.code, e.message)
    }
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
 * new chat's ids are made once and saved, so after process death the same
 * chat comes back (and its task, made again with the same ids, is the same
 * task); once made it opens as the chat it became.
 */
private class ConversationHolder(session: AgentSession, route: ConversationRoute, saved: SavedStateHandle) : ViewModel() {
    /** Not viewModelScope: a send or draft save in flight finishes after the screen goes. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val conversation: Conversation

    init {
        val task = if (route.agentId != null) null else NewTask(
            saved.get<String>(TASK) ?: ConversationApi.clientId().also { saved[TASK] = it },
            saved.get<String>(WORKSPACE) ?: ConversationApi.clientId().also { saved[WORKSPACE] = it },
            saved.get<String>(AGENT) ?: ConversationApi.clientId().also { saved[AGENT] = it },
            saved.get<String>(MUTATION) ?: ConversationApi.clientId().also { saved[MUTATION] = it },
        )
        val agentId = route.agentId ?: task!!.agentId
        conversation = Conversation(
            api = ConversationApi(session.conversationRequest()),
            signals = session.events.signalsFor(agentId),
            scope = scope,
            agentId = agentId,
            newTask = task.takeIf { saved.get<Boolean>(CREATED) != true },
            // The row that was tapped already had a name: the bar has it from the first frame.
            knownTitle = route.agentId?.let(session.feed.value::title),
            onTaskCreated = { answer ->
                saved[CREATED] = true
                answer["task"].obj?.let { session.upsertTask(it, answer["membership"].obj) }
            },
        )
        conversation.start()
        saved.takePrefill(route.prefill)?.let(conversation::prefill)
    }

    override fun onCleared() {
        conversation.close()
    }

    private companion object {
        const val TASK = "taskId"
        const val WORKSPACE = "workspaceId"
        const val AGENT = "agentId"
        const val MUTATION = "mutationId"
        const val CREATED = "created"
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

@Composable
internal fun linkStatusText(status: AgentLinkStatus?, syncing: Boolean = false): String? = when (status) {
    null, AgentLinkStatus.Connected -> if (syncing) stringResource(R.string.status_syncing) else null
    AgentLinkStatus.Connecting -> stringResource(R.string.status_connecting)
    AgentLinkStatus.Offline -> stringResource(R.string.status_offline)
    AgentLinkStatus.Revoked -> stringResource(R.string.conversation_revoked)
    AgentLinkStatus.UpdateRequired -> stringResource(R.string.conversation_update_required)
}

@Composable
private fun ConversationEntry(graph: AppGraph, nav: NavHostController, route: ConversationRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    if (session == null) {
        ConversationDetailsScreen(null, null, stringResource(R.string.conversation_unavailable)) { nav.popBackStack() }
        return
    }
    val holder = viewModel(key = "conversation") { ConversationHolder(session, route, createSavedStateHandle()) }
    val conversation = holder.conversation
    val state by conversation.state.collectAsStateWithLifecycle()
    val status by session.status.collectAsStateWithLifecycle()
    val syncing by session.isSyncing.collectAsStateWithLifecycle()
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    DisposableEffect(conversation) { onDispose { conversation.setVisible(false) } }
    ConversationScreen(
        state = state,
        connection = linkStatusText(status, syncing),
        bubbleColor = settings.userMessageBubbleColor,
        actions = remember(conversation, nav) {
            ConversationScreenActions(
                onBack = { nav.popBackStack() },
                onCompose = { nav.composeConversation(route.connectionId) },
                onDetails = { nav.navigate(ConversationDetailsRoute(route.connectionId, conversation.agentId)) },
                onDraftChange = conversation::setDraft,
                onSend = { words, files -> conversation.send(words, files) },
                onModeChange = conversation::setMode,
                onStop = conversation::stop,
                onRetrySend = conversation::retrySend,
                onDiscardSend = conversation::discardSend,
                onRetryFailure = conversation::retryFailure,
                onAnswer = conversation::answer,
                onLoadOlder = { retry -> conversation.loadOlder(retry) },
                onOpenArtifact = { artifactId -> nav.navigate(ArtifactRoute(route.connectionId, artifactId)) },
                onRetryLoad = conversation::retryLoad,
                loadMedia = conversation::media,
                onVisible = conversation::setVisible,
                // The values typed into a secret go in this one request to the computer and nowhere else.
                secrets = SecretRequestActions(
                    secrets = { ConversationApi(session.conversationRequest()).secrets() },
                    create = { id, description, values -> ConversationApi(session.conversationRequest()).createSecret(id, description, values) },
                ),
            )
        },
    )
    state.alert?.let { message ->
        val title = stringResource(R.string.common_error)
        val ok = stringResource(R.string.common_ok)
        HappyAlert(Alert(title, message, listOf(AlertButton(ok))), onDismiss = conversation::dismissAlert)
    }
}

@Composable
private fun ConversationDetails(graph: AppGraph, nav: NavHostController, route: ConversationDetailsRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    val unavailable = stringResource(R.string.conversation_unavailable)
    val read by produceState<Triple<AgentInfo?, Mode?, String?>>(Triple(null, null, null), session, route.agentId) {
        value = if (session == null) {
            Triple(null, null, unavailable)
        } else {
            try {
                val start = ConversationApi(session.conversationRequest()).bootstrap(route.agentId)
                Triple(start.agent, start.draft?.mode ?: start.mode, null)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Triple(null, null, Conversation.describe(e))
            }
        }
    }
    ConversationDetailsScreen(read.first, read.second, read.third) { nav.popBackStack() }
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
            problem = Conversation.describe(e)
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

/**
 * One artifact, read through the connection this conversation is on, so
 * its own credential carries the request and nothing of it is handed to
 * anything else. Its pictures are read here; words are read here; a video
 * or document is handed to whatever on the phone reads it, through the
 * same one directory as a conversation's media. A read that fails, a
 * deleted artifact and an offline computer each say so, with Retry.
 */
@Composable
private fun ArtifactEntry(graph: AppGraph, nav: NavHostController, route: ArtifactRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    ArtifactRouteContent(session, route.artifactId, onBack = { nav.popBackStack() }) {
        session?.let { ConversationApi(it.conversationRequest()) }
    }
}

/**
 * [ArtifactEntry]'s body, moved out unchanged. [connection] is only a key:
 * when it changes, the artifact is read again (the session there); the loader
 * uses nothing of it. [api] makes a client each time one is needed, null for
 * a connection this device doesn't have. Internal, not private, only so the
 * instrumented harness (src/androidTest) drives this loader rather than a
 * copy of it.
 */
@Composable
internal fun ArtifactRouteContent(connection: Any?, artifactId: String, onBack: () -> Unit, api: () -> ConversationApi?) {
    val unavailable = stringResource(R.string.conversation_unavailable)
    val deleted = stringResource(R.string.conversation_artifact_deleted)
    var attempt by rememberSaveable { mutableIntStateOf(0) }
    val pictures = rememberPictureViewer()
    val media = rememberMediaOpener()
    val content by produceState<ArtifactContent>(ArtifactContent.Reading, connection, artifactId, attempt) {
        value = ArtifactContent.Reading
        val api = api()
        if (api == null) {
            value = ArtifactContent.Failed(unavailable)
            return@produceState
        }
        value = try {
            val artifact = api.readArtifact(artifactId)
            when {
                artifact == null -> ArtifactContent.Failed(unavailable)
                artifact.deleted -> ArtifactContent.Failed(deleted)
                else -> when (val view = artifact.view()) {
                    is ArtifactView.Words -> {
                        val entry = artifact.entryFile
                        val words = entry?.let { String(api.artifactFile(artifact.id, artifact.version.toString(), it.path), Charsets.UTF_8) }.orEmpty()
                        ArtifactContent.Ready(artifact, ArtifactView.Words(words), emptyMap())
                    }
                    is ArtifactView.Pictures -> {
                        val bytes = view.files.associate { it.path to api.artifactFile(artifact.id, artifact.version.toString(), it.path) }
                        ArtifactContent.Ready(artifact, view, bytes)
                    }
                    else -> ArtifactContent.Ready(artifact, view, emptyMap())
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            ArtifactContent.Failed(Conversation.describe(e))
        }
    }
    val ready = content as? ArtifactContent.Ready
    val openable = (ready?.view as? ArtifactView.Openable)?.file
    ArtifactScreen(
        content = content,
        onBack = onBack,
        onRetry = { attempt++ },
        onOpenPicture = pictures::show,
        onOpenFile = { file ->
            val artifact = ready?.artifact ?: return@ArtifactScreen
            val key = "artifact-${artifact.id}-${artifact.version}"
            media.open(key, MediaItem("file", file.path, file.mimeType)) {
                api()!!.artifactFile(artifact.id, artifact.version.toString(), file.path)
            }
        },
        opening = openable?.let { media.state("artifact-${ready.artifact.id}-${ready.artifact.version}") },
    )
    PictureViewerHost(pictures)
}
