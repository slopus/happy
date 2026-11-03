package com.slopus.happy.ui.files

import com.slopus.happy.R
import com.slopus.happy.agent.WorkspaceFiles
import com.slopus.happy.text.Words
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** How a folder's listing reads: the daemon's pages for [path], one at a time. */
fun interface FolderPages {
    suspend fun page(path: String, cursor: String?): WorkspaceFiles.Page
}

/**
 * One folder of a workspace as the browser lists it (desktop's
 * `workspaceFileTreeRead` behind FileTree; Telegram's
 * ChatAttachAlertDocumentLayout `listFiles`): the first page on [open],
 * the next as the reader nears the end ([more]). Folders come first, then
 * files, each by name ignoring case (ChatAttachAlertDocumentLayout.java:1028
 * `sortFileItems`), re-sorted as pages arrive.
 */
class WorkspaceFolder(private val scope: CoroutineScope, private val pages: FolderPages, val path: String) {
    data class State(
        val entries: List<WorkspaceFiles.Entry> = emptyList(),
        /** The first page hasn't answered. */
        val loading: Boolean = true,
        val error: Words? = null,
        val nextCursor: String? = null,
        val loadingMore: Boolean = false,
    ) {
        val empty: Boolean get() = !loading && error == null && entries.isEmpty()
    }

    private val mutable = MutableStateFlow(State())
    val state: StateFlow<State> = mutable.asStateFlow()
    private var job: Job? = null

    /** The first page, again after a failure; a folder already listed keeps its rows while it is read again. */
    fun open() {
        job?.cancel()
        mutable.update { it.copy(loading = it.entries.isEmpty(), error = null, loadingMore = false) }
        job = scope.launch {
            try {
                val page = pages.page(path, null)
                mutable.value = State(sorted(page.entries), loading = false, nextCursor = page.nextCursor)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mutable.update { it.copy(loading = false, error = describe(e)) }
            }
        }
    }

    /** The next page, once: called as the last rows come into view. */
    fun more() {
        val current = mutable.value
        val cursor = current.nextCursor ?: return
        if (current.loadingMore || current.loading || job?.isActive == true) return
        mutable.update { it.copy(loadingMore = true) }
        job = scope.launch {
            try {
                val page = pages.page(path, cursor)
                mutable.update { it.copy(entries = sorted(it.entries + page.entries), nextCursor = page.nextCursor, loadingMore = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The rows in hand stay; reaching the end again asks again.
                mutable.update { it.copy(loadingMore = false) }
            }
        }
    }

    companion object {
        private val order = compareBy<WorkspaceFiles.Entry> { !it.directory }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name }

        fun sorted(entries: List<WorkspaceFiles.Entry>): List<WorkspaceFiles.Entry> = entries.distinctBy { it.path }.sortedWith(order)

        /** Why a listing or a read failed, in the reader's words where the API says what happened. */
        fun describe(error: Exception): Words = when {
            error is com.slopus.happy.agent.AgentApiException && error.status == 404 -> Words.ours(R.string.workspace_not_found)
            error is com.slopus.happy.agent.AgentApiException && error.status == 409 -> Words.ours(R.string.workspace_initializing)
            error is WorkspaceFiles.TooLarge -> Words.ours(R.string.workspace_file_too_large)
            error is com.slopus.happy.connection.AgentConnectionException -> Words.ours(R.string.workspace_unreachable)
            else -> Words.said(error.message, R.string.files_load_failed)
        }
    }
}
