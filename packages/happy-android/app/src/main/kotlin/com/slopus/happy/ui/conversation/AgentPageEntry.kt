package com.slopus.happy.ui.conversation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentFamily
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.HappyLink
import com.slopus.happy.agent.HappyReferenceKind
import com.slopus.happy.agent.HappyShareLinks
import com.slopus.happy.agent.HappyUrls
import com.slopus.happy.agent.string
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.conversation.AgentDetail
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.Problem
import com.slopus.happy.conversation.Shared
import com.slopus.happy.conversation.SharedFeed
import com.slopus.happy.ui.artifacts.BrowserRoute
import com.slopus.happy.ui.artifacts.computerName
import com.slopus.happy.ui.browser.LinkOpener
import com.slopus.happy.ui.browser.ProvideLinks
import com.slopus.happy.ui.connection.LocalAgentPictures
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * What the agent page reads of the computer, kept through recreation (iOS's
 * `SessionDetailFeed` and `SharedFeed`): the bootstrap, read at once and
 * again as the agent's events come (a moment after the first, then at
 * most every two seconds while they keep coming, as a working agent
 * streams many); history's shared media and links, a page at a time as the
 * page asks; and the computer's model catalog, once, for the models' names.
 */
internal class AgentPageModel(private val session: AgentSession, private val agentId: String) : ViewModel() {
    @androidx.compose.runtime.Immutable
    data class Read(val detail: AgentDetail? = null, val reading: Boolean = true, val error: Problem? = null)

    private val request = session.conversationRequest()
    private val api = ConversationApi(bytesRequest = null, request = request, cloud = session.client.cloud)
    private val readState = MutableStateFlow(Read())
    val read: StateFlow<Read> = readState.asStateFlow()
    private val sharedFeed = SharedFeed(api, agentId) { readState.value.detail?.agent?.parentAgentId }
    private val sharedState = MutableStateFlow(SharedFeed.State())
    val shared: StateFlow<SharedFeed.State> = sharedState.asStateFlow()
    private val catalogState = MutableStateFlow<ModeCatalog?>(null)
    val catalog: StateFlow<ModeCatalog?> = catalogState.asStateFlow()
    private var wanted = 0 to 0
    private var asking: Job? = null
    private var observing = false

    suspend fun observe(): Unit = kotlinx.coroutines.coroutineScope {
        observing = true
        val pokes = Channel<Unit>(Channel.CONFLATED)
        launch { session.events.signalsFor(agentId).collect { pokes.trySend(Unit) } }
        launch {
            readDetail()
            for (poke in pokes) {
                delay(FIRST_DELAY_MS)
                readDetail()
                delay(EVERY_MS - FIRST_DELAY_MS)
            }
        }
        if (catalogState.value == null) launch {
            catalogState.value = try {
                api.catalog()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The tiles keep the model's ID.
                null
            }
        }
        if (wanted != (0 to 0)) want(wanted.first, wanted.second)
        try { kotlinx.coroutines.awaitCancellation() } finally {
            observing = false
            asking?.cancel()
            pokes.close()
        }
    }

    private suspend fun readDetail() {
        val path = "/v0/agents/${ConversationApi.escape(agentId)}/bootstrap"
        readState.value = try {
            val detail = AgentDetail.parse(ConversationApi.decode(request("GET", path, null, RequestCategory.Query))) ?: throw IllegalStateException()
            Read(detail, reading = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // What was read stays; the page says why only while it has nothing.
            readState.value.copy(reading = false, error = Conversation.describe(e))
        }
    }

    /** History back far enough for [media] media and [links] links; asked while reading, it asks again once that is in. */
    fun want(media: Int, links: Int) {
        wanted = maxOf(wanted.first, media) to maxOf(wanted.second, links)
        if (!observing || asking?.isActive == true) return
        asking = viewModelScope.launch {
            do {
                val target = wanted
                sharedState.value = sharedFeed.load(target.first, target.second)
            } while (wanted != target && sharedState.value.hasMore && !sharedState.value.failed)
        }
    }

    private companion object {
        const val FIRST_DELAY_MS = 400L
        const val EVERY_MS = 2_000L
    }
}

/**
 * The agent page of [route]'s agent: what its chat under this page already
 * holds (its rows, mode and catalog, at once, as iOS's warm chat), home's
 * row and tree for its name, mark and family, the catalog's projects and
 * workspaces, and [AgentPageModel]'s reads.
 */
@Composable
internal fun AgentPageEntry(graph: AppGraph, nav: NavHostController, route: ConversationDetailsRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    if (session == null) {
        AgentPageScreen(
            AgentPageState(route.agentId, reading = false, error = stringResource(R.string.conversation_unavailable)),
            AgentPageActions(onBack = { nav.popBackStack() }),
        )
        return
    }
    val model = viewModel(key = "agentPage") { AgentPageModel(session, route.agentId) }
    com.slopus.happy.ui.components.StartedEffect(model) { model.observe() }
    val held = remember(nav, route.agentId) { nav.heldConversation(route.agentId) }
    val warm = held?.state?.collectAsStateWithLifecycle()?.value
    val read by model.read.collectAsStateWithLifecycle()
    val history by model.shared.collectAsStateWithLifecycle()
    val readCatalog by model.catalog.collectAsStateWithLifecycle()
    val feed by session.feed.collectAsStateWithLifecycle()
    val catalog by session.catalog.collectAsStateWithLifecycle()
    // What the chat in hand shows, read off the main thread as it changes.
    val rows = warm?.rows
    val inHand by produceState(Shared(), rows) { value = withContext(Dispatchers.Default) { Shared.of(rows.orEmpty()) } }

    val agent = read.detail?.agent ?: warm?.agent
    val row = remember(feed, route.agentId) { feed.conversations.firstOrNull { it.agentId == route.agentId } }
    val family = remember(feed, route.agentId) { AgentFamily.of(route.agentId, feed.rows) }
    val mode = read.detail?.mode ?: warm?.mode
    val choice = mode?.let { (warm?.catalog ?: readCatalog)?.model(it.providerId, it.modelId) }
    val workspace = agent?.workspaceId?.let(catalog.workspaces::get)
    val projectId = workspace?.string("projectId") ?: agent?.workspaceId?.takeIf { it in catalog.projects }
    val state = AgentPageState(
        agentId = route.agentId,
        name = row?.title ?: agent?.title?.takeIf { it.isNotBlank() } ?: warm?.title,
        kind = agentKind(row, agent?.subtask, agent?.parentAgentId),
        working = agent?.isWorking == true,
        awaitingAnswer = agent?.pendingQuestionId != null,
        row = row,
        family = family,
        mode = mode,
        modelName = choice?.name,
        providerName = choice?.providerName,
        detail = read.detail,
        reading = read.reading,
        error = read.error?.let { problemText(it) },
        shared = inHand.merged(history.shared),
        sharedMore = history.hasMore,
        sharedReading = !history.read && inHand.isEmpty,
        project = projectId?.let(catalog.projects::get)?.string("name")?.takeIf { it.isNotBlank() },
        // A worktree of a project; a bot's or task's own folder is the bot or task.
        workspace = workspace?.takeIf { projectId != null && it.string("id") != projectId }?.string("name")?.takeIf { it.isNotBlank() },
        parent = agent?.parentAgentId?.let { id -> AgentPageParent(id, feed.title(id) ?: catalog.agent(id)?.title?.takeIf { it.isNotBlank() }) },
        // Happy Cloud has no folders: no Changes or Files.
        workspaceId = (agent?.workspaceId ?: row?.workspaceId)?.takeUnless { session.client.cloud },
        lineChanges = row?.lineChanges,
        // The chat beneath picks it, once it knows its mode or the catalog's default, as its header did.
        chatMode = held?.let { warm?.mode ?: warm?.catalog?.defaults },
    )
    val kept = rememberKeptMedia(graph, session, route.agentId)
    val connections by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    val instanceId = connections.firstOrNull { it.id == route.connectionId }?.instanceId?.takeIf(HappyUrls::isInstanceId)
    val kind = state.kind
    val actions = remember(nav, model, session, route, kept, held, instanceId, kind) {
        AgentPageActions(
            onBack = { nav.popBackStack() },
            onOpenConversation = { id -> if (id == route.agentId) nav.popBackStack() else nav.openConversation(route.connectionId, id) },
            onWant = model::want,
            onOpenChanges = { workspaceId -> nav.navigate(WorkspaceChangesRoute(route.connectionId, workspaceId)) },
            onOpenFiles = { workspaceId -> nav.navigate(com.slopus.happy.ui.files.WorkspaceFilesRoute(route.connectionId, workspaceId)) },
            loadMedia = { ref -> ConversationApi(session.conversationRequest()).media(route.agentId, ref) },
            loadMediaRange = { ref, range ->
                session.client.send(
                    "GET",
                    ConversationApi.mediaPath(route.agentId, ref),
                    headers = mapOf("Range" to "bytes=${range.first}-${range.last}"),
                    category = RequestCategory.File,
                )
            },
            kept = kept,
            onModeChange = { mode -> held?.setMode(mode) },
            link = HappyShareLinks.format(HappyLink.Reference(HappyReferenceKind.Agent, route.agentId), instanceId, kind?.shareRole()),
        )
    }
    // A link opens as one in the chat does: through this agent's workspace.
    val context = LocalContext.current
    val computer = computerName(graph, route.connectionId)
    // A Happy URL, or a share link carrying one, opens in the app.
    val happyLinks = com.slopus.happy.ui.connection.LocalHappyLinks.current
    val links = remember(nav, computer, route.agentId, happyLinks) {
        LinkOpener.agent(context, computer, app = { url -> happyLinks?.open(url, route.connectionId) == true }) { url ->
            nav.navigate(BrowserRoute(route.connectionId, url, route.agentId))
        }
    }
    CompositionLocalProvider(LocalAgentPictures provides session.pictures) {
        ProvideLinks(links) { AgentPageScreen(state, actions) }
    }
}
