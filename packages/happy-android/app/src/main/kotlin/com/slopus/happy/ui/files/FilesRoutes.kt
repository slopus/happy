package com.slopus.happy.ui.files

import android.content.ClipData
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.R
import com.slopus.happy.chat.ChatFeed
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.NoLivePresence
import com.slopus.happy.chat.StoreChatMessagesSource
import com.slopus.happy.chat.StoreChatSessionSource
import com.slopus.happy.chat.SyncChatMessagesSource
import com.slopus.happy.chat.SyncChatPresenceSource
import com.slopus.happy.chat.str
import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.gitStatusKey
import com.slopus.happy.model.isRig
import com.slopus.happy.sync.HappyAgentGit
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

/** `/session/{id}/changes?file=`: the session's changes, scrolled to [file] when set. */
@Serializable data class SessionChangesRoute(val id: String, val file: String? = null)

/** `/session/{id}/file?path=&line=&column=`: one file and its uncommitted diff. */
@Serializable data class SessionFileRoute(val id: String, val path: String, val line: Int? = null, val column: Int? = null)

/** `/session/{id}/message/{messageId}?file=`: one message in full; [file] narrows a patch to the file tapped. */
@Serializable data class MessageDetailRoute(val id: String, val messageId: String, val file: String? = null)

/** `/text-selection?textId=`: text stored with [TempText.store]. */
@Serializable data class TextSelectionRoute(val textId: String)

/**
 * ToolView.tsx `handlePress`: Edit, MultiEdit and Write open the file they
 * changed; every other tool opens its message.
 */
fun toolPressRoute(sessionId: String, message: ChatMessage.ToolCallMessage): Any {
    val tool = message.tool
    val path = if (tool.name in setOf("Edit", "MultiEdit", "Write")) (tool.input as? kotlinx.serialization.json.JsonObject)?.get("file_path").str else null
    return if (path != null) SessionFileRoute(sessionId, path) else MessageDetailRoute(sessionId, message.id)
}

fun NavGraphBuilder.filesRoutes(graph: AppGraph, nav: NavHostController) {
    composable<SessionChangesRoute> { entry ->
        val route = entry.toRoute<SessionChangesRoute>()
        ChangesRouteScreen(graph, route.id, route.file, onBack = { nav.popBackStack() })
    }
    composable<SessionFileRoute> { entry ->
        val route = entry.toRoute<SessionFileRoute>()
        FileRouteScreen(graph, route, onBack = { nav.popBackStack() })
    }
    composable<MessageDetailRoute> { entry ->
        val route = entry.toRoute<MessageDetailRoute>()
        MessageDetailRouteScreen(graph, route, onBack = { nav.popBackStack() })
    }
    composable<TextSelectionRoute> { entry ->
        val route = entry.toRoute<TextSelectionRoute>()
        TextSelectionRouteScreen(route.textId, onBack = { nav.popBackStack() })
    }
}

private fun HappyStore.metadataFlow(sessionId: String): Flow<SessionMetadata?> =
    versions.map { it.sessions }.distinctUntilChanged().map { SessionMetadata.parse(session(sessionId)?.metadataJson) }
        .distinctUntilChanged().flowOn(Dispatchers.IO)

/** A session's metadata as stored, and whether the store has answered yet. */
@Composable
private fun rememberMetadata(graph: AppGraph, sessionId: String): Pair<Boolean, SessionMetadata?> {
    val flow = remember(sessionId) { graph.store.metadataFlow(sessionId).map { true to it } }
    val value by flow.collectAsStateWithLifecycle(false to null)
    return value
}

@Composable
private fun ChangesRouteScreen(graph: AppGraph, sessionId: String, file: String?, onBack: () -> Unit) {
    val account by graph.account.collectAsStateWithLifecycle()
    val (_, metadata) = rememberMetadata(graph, sessionId)
    val scope = rememberCoroutineScope()
    val sync = account
    val ops = remember(sync) { sync?.let(::SyncSessionFileOps) }
    // Opened outside the chat: tell sync the session is on screen so its state stays fresh.
    LaunchedEffect(sync, sessionId) { sync?.messages?.onSessionVisible(sessionId) }
    val rig = metadata?.isRig()
    val legacy = remember(ops, sessionId, rig, metadata?.path, metadata?.machineId) {
        if (ops != null && sync != null && rig == false) {
            LegacyChanges(scope, ops, sessionId, metadata.path, sync.fileCache, gitStatusKey(metadata.machineId, metadata.path))
        } else {
            null
        }
    }
    val agent = remember(ops, sessionId, rig) {
        if (ops != null && rig == true) AgentChanges(scope, ops, sessionId, HappyAgentGit.supportsHappyAgentGit(metadata)) else null
    }
    // Every return to the screen reads git again (useFocusEffect).
    LifecycleResumeEffect(legacy, agent) {
        legacy?.refresh()
        agent?.refresh()
        onPauseOrDispose { }
    }
    val content = when {
        legacy != null -> ChangesContent.Legacy(legacy.state.collectAsStateWithLifecycle().value)
        agent != null -> ChangesContent.Agent(agent.state.collectAsStateWithLifecycle().value, agent.supported)
        else -> ChangesContent.Loading
    }
    ChangesScreen(
        content,
        ChangesActions(
            onBack = onBack,
            onExpandContext = { path -> legacy?.expandContext(path); agent?.expandContext(path) },
            onRequestContent = { path -> agent?.requestContent(path) },
            onRetry = { agent?.refresh() },
        ),
        scrollToFile = file,
    )
}

@Composable
private fun FileRouteScreen(graph: AppGraph, route: SessionFileRoute, onBack: () -> Unit) {
    val account by graph.account.collectAsStateWithLifecycle()
    val (loaded, metadata) = rememberMetadata(graph, route.id)
    val sessionPath = metadata?.path
    val resolved = remember(route.path, sessionPath) { SessionFilePaths.resolve(route.path, sessionPath) }
    val filePath = resolved?.absolutePath ?: route.path
    val gitDiffPath = resolved?.takeIf { it.withinSessionRoot }?.relativePath
    val sync = account
    val load by produceState<FileLoad>(FileLoad.Loading, sync, loaded, filePath, gitDiffPath) {
        if (sync == null || !loaded) return@produceState
        SyncSessionFileOps(sync).fileLoads(sync.fileCache, route.id, filePath, sessionPath, gitDiffPath).collect { value = it }
    }
    FileScreen(load, filePath, onBack, route.line, route.column)
}

/** The message and the nested sub-agent messages under it, by id. */
private fun findMessage(rows: List<ChatMessage>, id: String): ChatMessage? {
    for (message in rows) {
        if (message.id == id) return message
        if (message is ChatMessage.ToolCallMessage) findMessage(message.children, id)?.let { return it }
    }
    return null
}

@Composable
private fun MessageDetailRouteScreen(graph: AppGraph, route: MessageDetailRoute, onBack: () -> Unit) {
    val account by graph.account.collectAsStateWithLifecycle()
    val feed = remember(account) {
        val sync = account
        ChatFeed(
            messages = sync?.let { SyncChatMessagesSource(it.messages, it.sender) } ?: StoreChatMessagesSource(graph.store),
            sessions = StoreChatSessionSource(graph.store),
            presence = sync?.let { SyncChatPresenceSource(it.presence) } ?: NoLivePresence,
        )
    }
    val state by remember(feed, route.id) { feed.state(route.id) }.collectAsStateWithLifecycle(ChatState())
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val local by graph.localSettings.values.collectAsStateWithLifecycle()
    val message = remember(state.snapshot.rows, route.messageId) { findMessage(state.snapshot.rows.map { it.message }, route.messageId) }
    val loaded = state.sessionLoaded && state.session != null && state.snapshot.loaded
    // A message that is gone once everything has loaded: nothing to show, go back.
    LaunchedEffect(loaded, message) { if (loaded && message == null) onBack() }
    MessageDetailScreen(
        message = message,
        loaded = loaded,
        env = MessageDetailEnvironment(
            path = state.session?.metadata?.path,
            flavor = state.session?.metadata?.flavor,
            showLineNumbers = settings.showLineNumbersInToolViews,
            devMode = BuildConfig.DEBUG || local.devModeEnabled,
        ),
        onBack = onBack,
        focusFile = route.file,
    )
}

@Composable
private fun TextSelectionRouteScreen(textId: String, onBack: () -> Unit) {
    val text = remember(textId) { TempText.retrieve(textId) }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var alert by remember { mutableStateOf<Pair<Alert, Boolean>?>(null) }
    val error = stringResource(R.string.common_error)
    val ok = stringResource(R.string.common_ok)
    val notFound = stringResource(R.string.text_selection_text_not_found)
    val copied = stringResource(R.string.text_selection_text_copied)
    val failed = stringResource(R.string.text_selection_failed_to_copy)
    val noText = stringResource(R.string.text_selection_no_text_to_copy)
    LaunchedEffect(textId) {
        if (text == null) alert = Alert(error, notFound, listOf(AlertButton(ok))) to true
    }
    TextSelectionScreen(
        text = text.orEmpty(),
        onBack = onBack,
        onCopy = {
            if (text.isNullOrEmpty()) {
                alert = Alert(error, noText, listOf(AlertButton(ok))) to false
            } else {
                scope.launch {
                    alert = try {
                        withContext(Dispatchers.Main) { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(text, text))) }
                        Alert(copied, null, listOf(AlertButton(ok))) to false
                    } catch (_: Exception) {
                        Alert(error, failed, listOf(AlertButton(ok))) to false
                    }
                }
            }
        },
    )
    alert?.let { (shown, back) ->
        HappyAlert(shown, onDismiss = {
            alert = null
            if (back) onBack()
        })
    }
}
