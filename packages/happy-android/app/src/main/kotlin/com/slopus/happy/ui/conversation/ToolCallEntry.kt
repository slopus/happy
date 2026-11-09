package com.slopus.happy.ui.conversation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.LocatedCall
import com.slopus.happy.conversation.Problem
import com.slopus.happy.conversation.ToolCallReader
import com.slopus.happy.ui.artifacts.BrowserRoute
import com.slopus.happy.ui.artifacts.computerName
import com.slopus.happy.ui.browser.LinkOpener
import com.slopus.happy.ui.browser.ProvideLinks
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * One tool call as its screen reads it (iOS ToolDetailFeed): from the
 * chat under the page while it is held there, following it while it runs;
 * once it has finished, its raw data read whole from history when the
 * chat had it left out or cut, once. Without the chat (after process
 * death), from history alone.
 */
internal class ToolCallModel(
    private val reader: ToolCallReader,
    private val callId: String,
    private val held: Conversation?,
) : ViewModel() {
    data class State(
        val call: Block.ToolCall? = null,
        val reading: Boolean = true,
        val readingWhole: Boolean = false,
        val wholeFailed: Boolean = false,
        val error: Problem? = null,
    )

    private val mutable = MutableStateFlow(State())
    val state: StateFlow<State> = mutable.asStateFlow()

    /** Read whole: nothing the chat holds replaces it. */
    private var whole: Block.ToolCall? = null
    private var wholeTried = false

    suspend fun observe() {
        if (whole != null) return
        if (held == null) return readAlone()
        held.state.collect {
            val located = held.toolCall(callId)
            if (located == null) {
                // Not in the chat as it is held (paged out): read it from history.
                if (mutable.value.call == null) readAlone()
                return@collect
            }
            if (whole == null) mutable.update { it.copy(call = located.call, reading = false) }
            if (!wholeTried && wants(located.call)) readWhole(located)
        }
    }

    private suspend fun readAlone() {
        if (wholeTried) return
        wholeTried = true
        mutable.update { it.copy(reading = true) }
        try {
            val call = reader.read(callId)
            whole = call
            mutable.update { it.copy(call = call ?: it.call, reading = false) }
        } catch (e: CancellationException) {
            wholeTried = false
            throw e
        } catch (e: Exception) {
            mutable.update { it.copy(reading = false, error = Conversation.describe(e)) }
        }
    }

    private suspend fun readWhole(located: LocatedCall) {
        wholeTried = true
        mutable.update { it.copy(readingWhole = true) }
        try {
            val call = reader.read(callId, located)
            if (call != null) whole = call
            mutable.update { it.copy(call = call ?: it.call, readingWhole = false, wholeFailed = call == null) }
        } catch (e: CancellationException) {
            wholeTried = false
            mutable.update { it.copy(readingWhole = false) }
            throw e
        } catch (_: Exception) {
            mutable.update { it.copy(readingWhole = false, wholeFailed = true) }
        }
    }

    companion object {
        /** A finished call whose raw data the chat doesn't have whole: left out by history, or cut. */
        fun wants(call: Block.ToolCall): Boolean = !call.running && (
            call.cut || (call.result == null && (call.arguments == null || call.presentation != null))
        ) // Compact presented history may retain only arguments.description, not the whole input.
    }
}

/** A tool call's screen ([ToolCallScreen]) for [route]. */
@Composable
internal fun ToolCallEntry(graph: AppGraph, nav: NavHostController, route: ToolCallRoute) {
    val session = remember(route.connectionId) { graph.agentSessions.session(route.connectionId) }
    if (session == null) {
        ToolCallScreen(ToolCallScreenState(reading = false, error = stringResource(R.string.conversation_unavailable)), ToolCallActions(onBack = { nav.popBackStack() }))
        return
    }
    val held = remember(nav, route.agentId) { nav.heldConversation(route.agentId) }
    val model = viewModel(key = "toolCall") {
        ToolCallModel(ToolCallReader(ConversationApi(session.conversationRequest()), route.agentId), route.callId, held)
    }
    com.slopus.happy.ui.components.StartedEffect(model) { model.observe() }
    val read by model.state.collectAsStateWithLifecycle()
    val state = ToolCallScreenState(
        call = read.call,
        reading = read.reading,
        readingWhole = read.readingWhole,
        wholeFailed = read.wholeFailed,
        error = read.error?.let { problemText(it) },
        file = route.file,
    )
    val actions = remember(nav, route) {
        ToolCallActions(
            onBack = { nav.popBackStack() },
            onOpenFile = { path -> nav.navigate(route.copy(file = path)) },
        )
    }
    // A link opens as one in the chat does: through this agent's workspace.
    val context = LocalContext.current
    val computer = computerName(graph, route.connectionId)
    val links = remember(nav, computer, route.agentId) {
        LinkOpener.agent(context, computer) { url -> nav.navigate(BrowserRoute(route.connectionId, url, route.agentId)) }
    }
    ProvideLinks(links) { ToolCallScreen(state, actions) }
}
