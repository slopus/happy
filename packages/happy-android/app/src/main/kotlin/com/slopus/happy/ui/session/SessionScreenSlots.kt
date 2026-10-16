package com.slopus.happy.ui.session

import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.R
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatState
import com.slopus.happy.model.AgentGoalAction
import com.slopus.happy.model.PendingChat
import com.slopus.happy.model.PendingChatStatus
import com.slopus.happy.model.Session
import com.slopus.happy.model.formatPathRelativeToHome
import com.slopus.happy.model.forkSource
import com.slopus.happy.model.isPendingChatId
import com.slopus.happy.model.newSessionLikeSession
import com.slopus.happy.model.pendingChatsBeside
import com.slopus.happy.model.resolveWorktreeTabs
import com.slopus.happy.model.rigActivityIndicators
import com.slopus.happy.model.visibleAgentGoal
import com.slopus.happy.ui.chat.ChatPendingSlot
import com.slopus.happy.ui.chat.ComposerDraft
import com.slopus.happy.ui.chat.ChatScreenSlots
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.ui.home.HomeServices
import com.slopus.happy.ui.home.rememberSessionMenus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * SessionView's stand-in handling for one route: [sessionId] is the chat
 * the screen shows, the stand-in's id until a machine names it.
 * [writeDraft] and [submit] are true when they took the text for a chat
 * that does not exist yet (its record keeps it for the handover).
 */
@Stable
class PendingChatRoute internal constructor(
    private val services: HomeServices,
    private val routeId: String,
    val pending: PendingChat?,
) {
    val sessionId: String = pending?.sessionId ?: routeId

    private val unsettled get() = pending != null && pending.sessionId == null

    /** Keystrokes in a stand-in's composer go to its record. */
    fun writeDraft(text: String): Boolean {
        if (!unsettled) return false
        services.pendingChats.setDraft(routeId, text)
        return true
    }

    /** Send on a stand-in: the message waits in line for the handover. */
    fun submit(text: String): Boolean {
        if (!unsettled) return false
        if (text.isNotBlank()) services.pendingChats.submit(routeId, text)
        return true
    }

    /** A stand-in left mid-sentence and come back to: its record's text, once, on mount. */
    @Composable
    fun SeedDraft(draft: ComposerDraft) {
        val seed = pending?.takeIf { it.sessionId == null }?.draft
        LaunchedEffect(draft) { if (!seed.isNullOrEmpty() && draft.text.isEmpty()) draft.set(seed) }
    }
}

/** The route's [PendingChatRoute]: a plain session id passes through. */
@Composable
fun rememberPendingChatRoute(graph: AppGraph, routeId: String): PendingChatRoute {
    val services = remember(graph) { HomeServices.of(graph) }
    if (!isPendingChatId(routeId)) return remember(services, routeId) { PendingChatRoute(services, routeId, null) }
    val chats by services.pendingChats.chats.collectAsStateWithLifecycle()
    val pending = chats[routeId]
    // A new route object only when the chat is named or its status moves, not on every keystroke.
    val key = pending?.let { it.sessionId to it.status }
    return remember(services, routeId, key) { PendingChatRoute(services, routeId, pending) }
}

/** [chat] for ChatScreen's slots; [goalBar] and [activityBar] for its parameters of those names. */
@Immutable
class SessionScreenSlots(
    val chat: ChatScreenSlots,
    val goalBar: (@Composable () -> Unit)?,
    val activityBar: (@Composable () -> Unit)?,
)

/**
 * What Home puts on the session screen (SessionView.tsx): grouped by
 * project, the checkout's tab strip under the header, which then names the
 * checkout and counts its tabs; the agent's goal over the question banner;
 * Happy Agent's activity over the composer; and for a chat still being
 * started, "New chat", its placeholder and a composer configured by the
 * chat it was opened beside. A failed start returns to that chat; leaving
 * a stand-in that has settled or failed retires its record. [onSwitch]
 * replaces the route's chat in place; [onBack] leaves the screen.
 */
@Composable
fun rememberSessionScreenSlots(
    graph: AppGraph,
    routeId: String,
    pending: PendingChat?,
    state: ChatState,
    onSwitch: (String) -> Unit,
    onBack: () -> Unit,
): SessionScreenSlots {
    val services = remember(graph) { HomeServices.of(graph) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val list by services.list.state.collectAsStateWithLifecycle()
    val chats by services.pendingChats.chats.collectAsStateWithLifecycle()
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val local by graph.localSettings.values.collectAsStateWithLifecycle()
    val session = state.session
    val metadata = session?.metadata
    val anchorId = pending?.anchorSessionId ?: routeId
    val selectedId = pending?.sessionId ?: routeId

    // The stand-in's lifecycle: a failed start goes back to its anchor; a settled or failed record goes with its screen.
    val latestPending by rememberUpdatedState(pending)
    LaunchedEffect(pending?.status) { if (pending?.status == PendingChatStatus.Failed) onSwitch(pending.anchorSessionId) }
    DisposableEffect(routeId) {
        onDispose {
            val chat = latestPending
            if (chat != null && (chat.sessionId != null || chat.status == PendingChatStatus.Failed)) services.pendingChats.dismiss(chat.id)
        }
    }

    var alert by remember { mutableStateOf<Alert?>(null) }
    var prompt by remember { mutableStateOf<Prompt?>(null) }
    var duplicating by remember { mutableStateOf<Session?>(null) }
    val failure by services.pendingChatFailure.collectAsStateWithLifecycle()

    // The checkout: through the chat itself once it is in the list, else through the chat it was opened beside.
    val worktree = list?.worktrees?.let { it[selectedId] ?: it[anchorId] }
    var menuNeighbour by remember { mutableStateOf<String?>(null) }
    val latestSelected by rememberUpdatedState(selectedId)
    val menus = rememberSessionMenus(
        services = services,
        continuationExperiments = settings.expResumeSession,
        devMode = BuildConfig.DEBUG || local.devModeEnabled,
        onOpenSession = onSwitch,
        onDetails = null,
        onDuplicate = { duplicating = it },
        showAlert = { alert = it },
        // Archiving the open tab moves to its neighbour first, so the screen never plays the archive out.
        onBeforeArchive = { archived ->
            if (archived == latestSelected) {
                val neighbour = menuNeighbour
                if (neighbour != null && services.session(neighbour) != null) onSwitch(neighbour) else onBack()
            }
        },
    )

    val strip: (@androidx.compose.runtime.Composable () -> Unit)? = worktree?.let { checkout ->
        val tabs = resolveWorktreeTabs(checkout.tabs, pendingChatsBeside(chats.values, checkout.tabs.map { it.id }))
        val saved = services.stripOffsets[checkout.id]
        val listState = rememberLazyListState(saved?.first ?: 0, saved?.second ?: 0)
        LaunchedEffect(listState, checkout.id) {
            snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
                .distinctUntilChanged()
                .collect { services.stripOffsets[checkout.id] = it }
        }
        val strip: @Composable () -> Unit = {
            WorktreeTabStrip(
                tabs = tabs,
                selectedId = selectedId,
                onSelect = { id -> if (id != routeId && id != selectedId) onSwitch(id) },
                onMenu = { id, neighbour ->
                    menuNeighbour = neighbour
                    menus.open(id)
                },
                onNewTab = {
                    val open = services.session(selectedId) ?: services.session(anchorId)
                    if (open != null) {
                        val mirror = graph.account.value?.composer?.mirrors?.value?.get(open.id)
                        val chat = services.pendingChatStarter(context.applicationContext)
                            .open(open.id, checkout.tabs.map { it.id }, newSessionLikeSession(open, mirror))
                        onSwitch(chat.id)
                    }
                },
                listState = listState,
            )
        }
        strip
    }
    val tabCount = worktree?.let { resolveWorktreeTabs(it.tabs, pendingChatsBeside(chats.values, it.tabs.map { tab -> tab.id })) }
        ?.let { it.tabs.size + it.pending.size } ?: 0
    val headerSubtitle = if (worktree != null) pluralStringResource(R.plurals.sessions_filter_worktree_tabs, tabCount, tabCount) else null
    val headerTitle = worktree?.let { checkout ->
        checkout.workspaceName
            ?: metadata?.workspace?.name?.trim()?.takeIf { it.isNotEmpty() }
            ?: metadata?.gitBranch?.trim()?.takeIf { it.isNotEmpty() }
            ?: checkout.projectName
    }

    // The agent's goal, while its agent session is the one running.
    val goal = visibleAgentGoal(session?.agentState?.agentGoal, state.online, metadata)
    var inFlight by remember { mutableStateOf<AgentGoalAction?>(null) }
    val editTitle = stringResource(R.string.components_agent_goal_bar_edit_goal)
    val currentGoal = stringResource(R.string.components_agent_goal_bar_current_goal)
    val cancel = stringResource(R.string.common_cancel)
    val save = stringResource(R.string.common_save)
    val goalBar: (@Composable () -> Unit)? = goal?.let { visible ->
        {
            AgentGoalBar(
                goal = visible,
                onAction = { action ->
                    val sessionId = session?.id ?: return@AgentGoalBar
                    fun dispatch(objective: String?) {
                        inFlight = action
                        scope.launch {
                            try {
                                graph.account.value?.sessionOps?.goalAction(sessionId, action.wire, objective)
                            } catch (e: CancellationException) {
                                throw e
                            } catch (_: Exception) {
                                // agentGoalActionHandler logs and moves on.
                            } finally {
                                inFlight = null
                            }
                        }
                    }
                    when (action) {
                        // performAgentGoalAction: stop is offered but does nothing yet.
                        AgentGoalAction.Stop -> Unit
                        AgentGoalAction.Clear -> dispatch(null)
                        AgentGoalAction.Edit -> prompt = Prompt(
                            title = editTitle,
                            placeholder = currentGoal,
                            defaultValue = visible.text,
                            cancelText = cancel,
                            confirmText = save,
                            onResult = { next ->
                                val trimmed = next?.trim()
                                if (!trimmed.isNullOrEmpty() && trimmed != visible.text.trim()) dispatch(trimmed)
                            },
                        )
                    }
                },
                inFlight = inFlight,
            )
        }
    }
    val indicators = metadata.rigActivityIndicators()
    val activityBar: (@Composable () -> Unit)? = if (indicators.isEmpty()) null else ({ RigActivityBar(indicators) })

    val pendingSlot = pending?.takeIf { session == null }?.let { chat ->
        val anchor by produceState<ChatSessionInfo?>(null, chat.anchorSessionId) {
            value = withContext(Dispatchers.IO) { graph.store.session(chat.anchorSessionId)?.let(ChatSessionInfo::from) }
        }
        val path = anchor?.metadata?.let { formatPathRelativeToHome(it.path, it.homeDir) }
        ChatPendingSlot(anchor) { PendingChatPlaceholder(chat, path) }
    }

    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
    prompt?.let { PromptModal(it, onDismiss = { prompt = null }) }
    failure?.let { message ->
        HappyAlert(
            Alert(stringResource(R.string.common_error), message, listOf(AlertButton(stringResource(R.string.common_ok)))),
            onDismiss = services::dismissPendingChatFailure,
        )
    }
    duplicating?.let { source ->
        DuplicateSheet(
            source = source.forkSource(),
            continuations = services.continuations,
            onDismiss = { duplicating = null },
            onDuplicated = onSwitch,
        )
    }

    return SessionScreenSlots(
        chat = ChatScreenSlots(
            headerAccessory = strip,
            headerTitle = headerTitle,
            headerSubtitle = headerSubtitle,
            pending = pendingSlot,
        ),
        goalBar = goalBar,
        activityBar = activityBar,
    )
}
