package com.slopus.happy.ui.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.chat.ChatActions
import com.slopus.happy.chat.ChatFeed
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.ComposerModeResolver
import com.slopus.happy.chat.NoLivePresence
import com.slopus.happy.chat.PendingAgentCommunication
import com.slopus.happy.chat.StoreChatMessagesSource
import com.slopus.happy.chat.StoreChatSessionSource
import com.slopus.happy.chat.SyncChatActions
import com.slopus.happy.chat.SyncChatMessagesSource
import com.slopus.happy.chat.SyncChatPresenceSource
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.ui.attachments.LocalSessionAttachments
import com.slopus.happy.ui.attachments.rememberSessionAttachments
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** `/session/{id}`: one chat. */
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
    composable<SessionRoute> { entry ->
        val route = entry.toRoute<SessionRoute>()
        ChatRoute(graph, route.id, actions, onBack = { nav.popBackStack() }, onInfo = { onInfo(route.id) })
    }
}

@Composable
private fun ChatRoute(graph: AppGraph, sessionId: String, actions: ChatActions, onBack: () -> Unit, onInfo: () -> Unit) {
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
    // One flow per account and chat: a new one would start a new draft.
    val mirrorFlow = remember(account, sessionId) { account?.composer?.mirror(sessionId) }
    val mirror by remember(mirrorFlow) { mirrorFlow ?: flowOf(ComposerMirror()) }.collectAsStateWithLifecycle(ComposerMirror())
    val draft = rememberComposerDraft(mirrorFlow, onWrite = { text -> actions.setDraft(sessionId, text) })
    val resources = LocalContext.current.resources
    val metadata = state.session?.metadata
    val modes = remember(metadata, mirror, settings.agentDefaultOverrides) {
        ComposerModeResolver.resolve(metadata, mirror, settings.agentDefaultOverrides, resources::getString)
    }
    val latestMirror by rememberUpdatedState(mirror)
    val scope = rememberCoroutineScope()
    var aborting by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val notSent = stringResource(R.string.errors_unknown_error)
    val latestState by rememberUpdatedState(state)

    fun report(e: Exception) {
        failure = e.message?.takeIf { it.isNotBlank() } ?: notSent
    }

    val screenActions = remember(sessionId, actions, feed, draft) {
        ChatScreenActions(
            onBack = onBack,
            onInfo = onInfo,
            onDraftChange = draft::set,
            onSend = onSend@{ text ->
                if (text.isBlank() || sending) return@onSend
                // Questions the agent is blocked on are dismissed once the
                // message is delivered: it stands as the user's answer.
                val questions = latestState.pendingCommunications
                sending = true
                scope.launch {
                    try {
                        actions.send(sessionId, text, awaitDelivery = questions.isNotEmpty())
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
            onAbort = {
                scope.launch {
                    aborting = true
                    try {
                        actions.abort(sessionId)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        report(e)
                    } finally {
                        aborting = false
                    }
                }
            },
            loadOlder = { account?.messages?.loadOlder(sessionId) ?: false },
            onPermission = { answer, mode ->
                actions.answerPermission(sessionId, answer)
                if (mode != null) actions.setModes(sessionId, mapOf(AgentModeField.PERMISSION_MODE to mode))
            },
            onRetry = { localId -> scope.launch { runCatching { actions.retry(sessionId, localId) } } },
            onDiscard = { localId -> scope.launch { runCatching { actions.discard(sessionId, localId) } } },
            onAnswerQuestion = { id, answers, kind -> actions.answerQuestion(sessionId, id, answers, kind) },
            onCancelQuestion = { id, kind -> actions.cancelQuestion(sessionId, id, kind) },
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

    CompositionLocalProvider(LocalSessionAttachments provides rememberSessionAttachments(graph, sessionId)) {
        ChatScreen(
            state = state,
            draft = draft.text,
            bubbleColor = settings.userMessageBubbleColor,
            actions = screenActions,
            aborting = aborting,
            compactToolCalls = settings.compactToolCalls,
            showLineNumbersInToolViews = settings.showLineNumbersInToolViews,
            modes = modes,
        )
    }
    failure?.let { message ->
        HappyAlert(
            Alert(stringResource(R.string.common_error), message, listOf(AlertButton(stringResource(R.string.common_ok)))),
            onDismiss = { failure = null },
        )
    }
}
