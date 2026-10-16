package com.slopus.happy.ui.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalResources
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
import com.slopus.happy.chat.NoLivePresence
import com.slopus.happy.chat.PendingAgentCommunication
import com.slopus.happy.chat.StoreChatMessagesSource
import com.slopus.happy.chat.StoreChatSessionSource
import com.slopus.happy.chat.SyncChatActions
import com.slopus.happy.chat.SyncChatMessagesSource
import com.slopus.happy.chat.SyncChatPresenceSource
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.ui.attachments.LocalComposerImages
import com.slopus.happy.ui.attachments.LocalSessionAttachments
import com.slopus.happy.ui.attachments.attachmentNoticeAlert
import com.slopus.happy.ui.attachments.canUseAttachments
import com.slopus.happy.ui.attachments.prepareComposerAttachments
import com.slopus.happy.ui.attachments.rememberComposerImages
import com.slopus.happy.ui.attachments.rememberSessionAttachments
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import kotlinx.coroutines.CancellationException
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
    val draft = rememberComposerDraft(account?.composer?.mirror(sessionId), onWrite = { text -> actions.setDraft(sessionId, text) })
    val scope = rememberCoroutineScope()
    var aborting by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val notSent = stringResource(R.string.errors_unknown_error)
    val latestState by rememberUpdatedState(state)
    val images = rememberComposerImages(enabled = state.session != null && canUseAttachments(state.session?.metadata))
    val latestImages by rememberUpdatedState(images)
    val resources = LocalResources.current
    val notices = remember { mutableStateListOf<Alert>() }

    fun report(e: Exception) {
        failure = e.message?.takeIf { it.isNotBlank() } ?: notSent
    }

    val screenActions = remember(sessionId, actions, feed, draft, resources) {
        ChatScreenActions(
            onBack = onBack,
            onInfo = onInfo,
            onDraftChange = draft::set,
            onSend = onSend@{ text ->
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
        )
    }

    CompositionLocalProvider(
        LocalSessionAttachments provides rememberSessionAttachments(graph, sessionId),
        LocalComposerImages provides images,
    ) {
        ChatScreen(
            state = state,
            draft = draft.text,
            bubbleColor = settings.userMessageBubbleColor,
            actions = screenActions,
            aborting = aborting,
            compactToolCalls = settings.compactToolCalls,
            showLineNumbersInToolViews = settings.showLineNumbersInToolViews,
        )
    }
    notices.firstOrNull()?.let { HappyAlert(it, onDismiss = { notices.removeAt(0) }) }
    failure?.let { message ->
        HappyAlert(
            Alert(stringResource(R.string.common_error), message, listOf(AlertButton(stringResource(R.string.common_ok)))),
            onDismiss = { failure = null },
        )
    }
}
