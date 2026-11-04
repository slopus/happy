package com.slopus.happy.ui.documents

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.documents.DocumentEditor
import com.slopus.happy.documents.DocumentOpening
import com.slopus.happy.documents.DocumentPeer
import com.slopus.happy.documents.DocumentRoutes
import com.slopus.happy.documents.DocumentSaveState
import com.slopus.happy.documents.DocumentSync
import com.slopus.happy.documents.DocumentSyncEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * One open document, for as long as its screen is on the back stack
 * (iOS's `DocumentViewController` without its views): it holds the
 * document's [DocumentSync] while open, gives the screen the editor once
 * it is made, and passes what the sync says on. A rotation keeps it, so the
 * document isn't opened again; leaving the screen lets the sync go once
 * everything made here is sent.
 *
 * The editor is the main thread's: changes from elsewhere reach it here,
 * through the text controller when the screen has one up.
 */
class DocumentHolder(private val session: AgentSession, val surfaceId: String) : ViewModel() {
    sealed interface Phase {
        data object Loading : Phase
        /** Editable; a new [editor] (a reset) is installed again. */
        data class Ready(val editor: DocumentEditor) : Phase
        /** The computer keeps it as Markdown only: shown read-only, null when even that couldn't be read. */
        data class Markdown(val text: String?) : Phase
        /** Nothing kept and no answer: the agent's words, empty where it gave none. */
        data class Unavailable(val reason: String) : Phase
        data object Gone : Phase
    }

    private val sync: DocumentSync = session.documents.document(surfaceId)
    private val phaseState = MutableStateFlow<Phase>(Phase.Loading)
    val phase: StateFlow<Phase> = phaseState.asStateFlow()
    private val saveState = MutableStateFlow(DocumentSaveState.Saved)
    val save: StateFlow<DocumentSaveState> = saveState.asStateFlow()
    /** A change the computer refused, in the agent's words (empty where it gave none), for 4 s. */
    private val noticeState = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = noticeState.asStateFlow()
    private val peersState = MutableStateFlow<List<DocumentPeer>>(emptyList())
    val peers: StateFlow<List<DocumentPeer>> = peersState.asStateFlow()
    private var noticeClearing: Job? = null

    /** The screen's text controller while it has one; main thread. */
    var controller: DocumentTextController? = null

    init {
        session.profile.refresh()
        viewModelScope.launch { open() }
    }

    private suspend fun open() {
        when (val opening = sync.start()) {
            DocumentOpening.Ready -> {
                // Listened to first: a change landing between the two comes twice, which merges as once.
                val events = sync.events()
                val editor = sync.editor() ?: return
                adopt(editor)
                try {
                    for (event in events) received(event)
                } finally {
                    events.cancel()
                }
            }
            DocumentOpening.MarkdownOnly -> {
                val text = try {
                    DocumentRoutes.markdown(session.client, surfaceId).first
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    null
                }
                phaseState.value = Phase.Markdown(text)
            }
            is DocumentOpening.Unavailable -> phaseState.value = Phase.Unavailable(opening.reason)
        }
    }

    private fun adopt(editor: DocumentEditor) {
        editor.onLocalUpdate = { sync.local(it) }
        phaseState.value = Phase.Ready(editor)
    }

    private fun received(event: DocumentSyncEvent) {
        when (event) {
            is DocumentSyncEvent.Remote -> {
                val shown = controller
                if (shown != null) shown.applyRemote(event.update)
                else (phaseState.value as? Phase.Ready)?.editor?.let { runCatching { it.applyRemote(event.update) } }
            }
            is DocumentSyncEvent.Reset -> adopt(event.editor)
            is DocumentSyncEvent.Save -> saveState.value = event.state
            is DocumentSyncEvent.Peers -> peersState.value = event.peers
            is DocumentSyncEvent.Notice -> {
                noticeState.value = event.text
                noticeClearing?.cancel()
                noticeClearing = viewModelScope.launch {
                    delay(NOTICE_MILLIS)
                    noticeState.value = null
                }
            }
            DocumentSyncEvent.Gone -> phaseState.value = Phase.Gone
        }
    }

    /** Where this phone's caret is, for the others to draw; null when it isn't in the document. */
    fun presence(controller: DocumentTextController, focused: Boolean, fallbackName: String) {
        val carets = controller.selectionCarets?.takeIf { focused }
        if (carets == null) {
            sync.presence(null)
            return
        }
        val editor = controller.editor
        val name = session.profile.state.value.name.ifEmpty { fallbackName }
        val seed = session.catalog.value.userId?.takeIf { it.isNotEmpty() } ?: "person:${session.connectionId}"
        sync.presence(DocumentPeer.state(name, peerColor(seed), editor.relativePosition(carets.first), editor.relativePosition(carets.second)))
    }

    /** Kept and sent like any rename, shown at once. */
    fun rename(name: String) {
        viewModelScope.launch { session.rename("surface", surfaceId, name) }
    }

    override fun onCleared() {
        controller?.detach()
        controller = null
        sync.releaseLater()
    }

    companion object {
        const val NOTICE_MILLIS = 4_000L
        private val colors = listOf("#958DF1", "#F98181", "#FBBC88", "#FAF594", "#70CFF8", "#94FADB", "#B9F18D")

        /** iOS's `DocumentPeersView.color(for:)`: the person's colour among desktop's cursor colours, the same on every device. */
        fun peerColor(seed: String): String {
            var sum = 0
            for (c in seed.codePoints()) sum = (sum * 31 + c) and 0x7fffffff
            return colors[sum % colors.size]
        }
    }
}
