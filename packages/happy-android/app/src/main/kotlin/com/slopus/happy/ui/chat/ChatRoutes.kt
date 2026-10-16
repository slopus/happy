package com.slopus.happy.ui.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.chat.ChatActions
import com.slopus.happy.chat.ChatDrafts
import com.slopus.happy.chat.ChatFeed
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.NoLivePresence
import com.slopus.happy.chat.StoreChatMessagesSource
import com.slopus.happy.chat.StoreChatSessionSource
import com.slopus.happy.chat.SyncChatActions
import com.slopus.happy.chat.SyncChatMessagesSource
import com.slopus.happy.chat.SyncChatPresenceSource
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** `/session/{id}`: one chat. */
@Serializable
data class SessionRoute(val id: String)

/** Composer drafts survive leaving the chat, for the life of the process (happy-app keeps them per session). */
private val drafts = ChatDrafts()

/**
 * The chat's destinations. [actions] go to the signed-in account's session
 * RPCs; sending fails with a notice until Sync's sender lands. [onInfo] opens
 * `/session/{id}/info`.
 */
fun NavGraphBuilder.chatRoutes(
    graph: AppGraph,
    nav: NavHostController,
    actions: ChatActions = SyncChatActions { graph.account.value?.sessionOps },
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
            messages = sync?.let { SyncChatMessagesSource(it.messages) } ?: StoreChatMessagesSource(graph.store),
            sessions = StoreChatSessionSource(graph.store),
            presence = sync?.let { SyncChatPresenceSource(it.presence) } ?: NoLivePresence,
        )
    }
    val state by remember(feed, sessionId) { feed.state(sessionId) }.collectAsStateWithLifecycle(ChatState())
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val allDrafts by drafts.all.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var aborting by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val unavailable = stringResource(R.string.chat_send_unavailable)

    val screenActions = remember(sessionId, actions, feed) {
        ChatScreenActions(
            onBack = onBack,
            onInfo = onInfo,
            onDraftChange = { drafts.set(sessionId, it) },
            onSend = { text ->
                if (text.isNotBlank()) {
                    val previous = drafts.get(sessionId)
                    drafts.set(sessionId, "")
                    scope.launch {
                        try {
                            actions.send(sessionId, text)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: UnsupportedOperationException) {
                            drafts.set(sessionId, previous)
                            failure = unavailable
                        } catch (e: Exception) {
                            drafts.set(sessionId, previous)
                            failure = e.message ?: unavailable
                        }
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
                        failure = if (e is UnsupportedOperationException) unavailable else e.message ?: unavailable
                    } finally {
                        aborting = false
                    }
                }
            },
            loadOlder = { account?.messages?.loadOlder(sessionId) ?: false },
            onPermission = { answer, mode ->
                actions.answerPermission(sessionId, answer)
                if (mode != null) actions.setModes(sessionId, permissionMode = mode, modelMode = null, effortLevel = null)
            },
        )
    }

    ChatScreen(
        state = state,
        draft = allDrafts[sessionId].orEmpty(),
        bubbleColor = settings.userMessageBubbleColor,
        actions = screenActions,
        aborting = aborting,
        compactToolCalls = settings.compactToolCalls,
        showLineNumbersInToolViews = settings.showLineNumbersInToolViews,
    )
    failure?.let { message ->
        HappyAlert(
            Alert(stringResource(R.string.common_error), message, listOf(AlertButton(stringResource(R.string.common_ok)))),
            onDismiss = { failure = null },
        )
    }
}
