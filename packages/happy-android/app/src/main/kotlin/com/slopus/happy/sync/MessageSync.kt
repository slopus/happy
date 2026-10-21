package com.slopus.happy.sync

import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.MessageRecord
import com.slopus.happy.net.HttpStatusException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

/**
 * One batch of a session's messages, oldest first, as stored (sync.ts
 * applyMessages' source). A [PRELOAD][StoredSource.PRELOAD] batch was
 * fetched before the chat opened; [OPENED][StoredSource.OPENED] carries no
 * messages and says the chat has since opened and caught up.
 */
data class StoredMessages(
    val sessionId: String,
    val messages: List<MessageRecord>,
    val source: StoredSource = StoredSource.SYNC,
)

enum class StoredSource { SYNC, PRELOAD, OPENED }

/** A chat's paging state (sync.ts sessionMessages: isLoaded, hasMoreOlder, isLoadingOlder). */
data class MessagePaging(val isLoaded: Boolean, val hasMoreOlder: Boolean, val isLoadingOlder: Boolean)

/**
 * A session's messages: the stored run and how it grows (sync.ts
 * fetchMessages, fetchInitialLatestPage, fetchForwardSince,
 * loadOlderMessages, fetchOlderMessagesInBackground).
 *
 * A session with nothing stored starts from its newest page; from then on
 * the run grows forwards (live messages, catch-up after a gap or reconnect)
 * and backwards on demand. One lock per session orders all of it, so a
 * page and a live message never interleave their writes.
 */
class MessageSync(
    private val api: SyncApi,
    private val store: HappyStore,
    private val decoder: RecordDecoder,
    private val scope: CoroutineScope,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val prefetchPauseMs: Long = 250,
    private val onSessionGone: (String) -> Unit = {},
) {
    private val locks = ConcurrentHashMap<String, Mutex>()
    private val syncs = ConcurrentHashMap<String, InvalidateSync>()
    private val prefetchAttempts = ConcurrentHashMap<String, Int>()
    private val prefetching = ConcurrentHashMap.newKeySet<String>()
    private val viewing = ConcurrentHashMap<String, Int>()
    private val preloadSlot = AtomicReference<Preload?>(null)
    private val preloaded = ConcurrentHashMap.newKeySet<String>()

    private val loadingOlderState = MutableStateFlow<Set<String>>(emptySet())

    private val storedEvents = MutableSharedFlow<StoredMessages>(
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /**
     * Each batch of new messages as it is stored (sync.ts applyMessages with
     * source 'sync'): the newest page, a forward page, a live message. Older
     * history is not news and is not reported.
     */
    val stored: SharedFlow<StoredMessages> = storedEvents.asSharedFlow()

    /**
     * A batch was stored, here or by LiveUpdates' fast path. Pages arrive
     * newest first; the batch is reported oldest first, since a plan mode
     * entered and then left must not read as entered.
     */
    fun noteStored(sessionId: String, messages: List<MessageRecord>, source: StoredSource = StoredSource.SYNC) {
        if (messages.isNotEmpty()) storedEvents.tryEmit(StoredMessages(sessionId, messages.sortedBy { it.seq }, source))
    }

    /** Sessions loading an older page right now. */
    val loadingOlder: StateFlow<Set<String>> = loadingOlderState.asStateFlow()

    /**
     * A session's stored messages, oldest first, re-read whenever they
     * change. Collecting it opens the chat: its newest messages are fetched,
     * then a few older pages in the background.
     */
    fun messages(sessionId: String): Flow<List<MessageRecord>> = store.messageChanges(sessionId)
        .map { store.messages(sessionId) }
        .distinctUntilChanged()
        .onStart {
            viewing.merge(sessionId, 1, Int::plus)
            onSessionVisible(sessionId)
        }
        .onCompletion { viewing.computeIfPresent(sessionId) { _, count -> if (count <= 1) null else count - 1 } }
        .flowOn(io)

    fun paging(sessionId: String): Flow<MessagePaging> = combine(
        store.messageChanges(sessionId).map { store.messageHistory(sessionId) },
        loadingOlderState.map { sessionId in it },
    ) { history, loading ->
        MessagePaging(
            isLoaded = history?.isLoaded == true,
            hasMoreOlder = history?.hasOlder == true,
            isLoadingOlder = loading,
        )
    }.distinctUntilChanged().flowOn(io)

    /** The user opened the chat (sync.ts onSessionVisible): catch up, then fill in history. */
    fun onSessionVisible(sessionId: String) {
        // The chat's catch-up now waits on a touch's page: another touch must not cancel it.
        preloadSlot.getAndUpdate { if (it?.sessionId == sessionId) null else it }
        scope.launch {
            invalidateAndAwait(sessionId)
            if (preloaded.remove(sessionId)) storedEvents.tryEmit(StoredMessages(sessionId, emptyList(), StoredSource.OPENED))
            prefetchOlder(sessionId)
        }
    }

    /**
     * A finger landed on the session's row (sync.ts preloadSession,
     * sessionMessagePreloader.ts): its newest page starts loading so the chat
     * opens on messages. One page, one session at a time; a touch on another
     * row cancels it, and nothing happens for a chat already open, already
     * loading or already stored. No retry: the chat's own catch-up covers a
     * failure. Nothing here marks a visit, reads, or fetches older history.
     */
    fun preload(sessionId: String) {
        if (viewing.containsKey(sessionId)) return
        val current = preloadSlot.get()
        if (current?.sessionId == sessionId) return
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                preloadNewestPage(sessionId)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }
        val next = Preload(sessionId, job)
        if (!preloadSlot.compareAndSet(current, next)) {
            job.cancel()
            return
        }
        current?.job?.cancel()
        job.invokeOnCompletion { preloadSlot.compareAndSet(next, null) }
        job.start()
    }

    private suspend fun preloadNewestPage(sessionId: String) = lock(sessionId).withLock {
        withContext(io) {
            // Rechecked inside the lock: the chat's catch-up or an earlier touch may have stored it meanwhile.
            val session = store.session(sessionId) ?: return@withContext
            if (store.messageHistory(sessionId)?.isLoaded != false) return@withContext
            val cipher = decoder.cipher(session.wrappedDataKey) ?: return@withContext
            val page = api.messagesBefore(sessionId, SEQ_BACKWARD_INITIAL_SENTINEL, PAGE_SIZE)
            val newest = page.messages.map { decoder.message(sessionId, it, cipher) }
            // A page for a row touched since, or a session deleted while it decrypted, is dropped.
            ensureActive()
            if (store.session(sessionId) == null) return@withContext
            store.applyNewestPage(sessionId, newest, page.hasMore)
            preloaded.add(sessionId)
            noteStored(sessionId, newest, StoredSource.PRELOAD)
        }
    }

    /** Asks for a catch-up of one session; requests made while one runs collapse into one more. */
    fun invalidate(sessionId: String) = sync(sessionId).invalidate()

    suspend fun invalidateAndAwait(sessionId: String) = sync(sessionId).invalidateAndAwait()

    /** Catch-ups for the open chats: after a reconnect or a return to the foreground they missed what was said meanwhile. */
    fun invalidateViewing() = viewing.keys.forEach(::invalidate)

    /** The chats open right now (sync.ts currentViewingSessionId). */
    fun viewingSessionIds(): Set<String> = viewing.keys.toSet()

    /** The session is gone: drop its in-memory state. */
    fun forget(sessionId: String) {
        preloadSlot.get()?.takeIf { it.sessionId == sessionId }?.let { if (preloadSlot.compareAndSet(it, null)) it.job.cancel() }
        preloaded.remove(sessionId)
        syncs.remove(sessionId)?.cancel()
        prefetchAttempts.remove(sessionId)
        locks.remove(sessionId)
    }

    private fun sync(sessionId: String): InvalidateSync =
        syncs.computeIfAbsent(sessionId) { InvalidateSync(scope) { catchUp(sessionId) } }

    /**
     * Brings the stored run up to the server's newest message: the newest
     * page if nothing is stored, then everything after the run's end.
     */
    suspend fun catchUp(sessionId: String) = lock(sessionId).withLock {
        withContext(io) {
            val session = store.session(sessionId) ?: return@withContext
            val cipher = decoder.cipher(session.wrappedDataKey) ?: throw IOException("Session encryption not ready for $sessionId")
            try {
                if (store.messageHistory(sessionId)?.isLoaded == false) {
                    val page = api.messagesBefore(sessionId, SEQ_BACKWARD_INITIAL_SENTINEL, PAGE_SIZE)
                    val newest = page.messages.map { decoder.message(sessionId, it, cipher) }
                    store.applyNewestPage(sessionId, newest, page.hasMore)
                    noteStored(sessionId, newest)
                    if (store.messagesSeq(sessionId) >= session.seq) return@withContext
                }
                var afterSeq = store.messagesSeq(sessionId)
                while (true) {
                    val page = api.messagesAfter(sessionId, afterSeq, FORWARD_PAGE_SIZE)
                    val forward = page.messages.map { decoder.message(sessionId, it, cipher) }
                    store.insertMessages(sessionId, forward)
                    noteStored(sessionId, forward)
                    val maxSeq = page.messages.maxOfOrNull { it.seq } ?: afterSeq
                    // A page that does not move the cursor would be fetched forever.
                    if (!page.hasMore || maxSeq <= afterSeq) break
                    afterSeq = maxSeq
                }
                // Everything up to the seq the listing reported is here now,
                // even if some of those seqs had no message to return.
                store.markMessagesSynced(sessionId, session.seq)
            } catch (e: HttpStatusException) {
                if (e.status != 404) throw e
                store.deleteSessions(listOf(sessionId))
                onSessionGone(sessionId)
            }
        }
    }

    /**
     * One page of history before the stored run. True only when the run
     * moved back: a caller paging automatically continues on true and stops
     * on false. No-op while a load is in flight or when history is complete.
     */
    suspend fun loadOlder(sessionId: String): Boolean {
        val history = withContext(io) { store.messageHistory(sessionId) } ?: return false
        if (!history.isLoaded || history.oldestSeq <= 1 || !history.hasOlder) return false
        if (!markLoading(sessionId)) return false
        try {
            return lock(sessionId).withLock {
                withContext(io) {
                    val session = store.session(sessionId) ?: return@withContext false
                    // Thrown, not skipped: a silent no-op would leave hasMoreOlder
                    // set with nothing changed, and automatic paging would ask again.
                    val cipher = decoder.cipher(session.wrappedDataKey)
                        ?: throw IOException("Session encryption not ready for $sessionId")
                    val current = store.messageHistory(sessionId) ?: return@withContext false
                    if (!current.isLoaded || current.oldestSeq <= 1 || !current.hasOlder) return@withContext false
                    val page = api.messagesBefore(sessionId, current.oldestSeq, PAGE_SIZE)
                    store.applyOlderPage(
                        sessionId,
                        beforeSeq = current.oldestSeq,
                        messages = page.messages.map { decoder.message(sessionId, it, cipher) },
                        hasMore = page.hasMore,
                    )
                }
            }
        } finally {
            loadingOlderState.update { it - sessionId }
        }
    }

    /**
     * After a visit, history fills in without the user scrolling: up to
     * [MAX_PREFETCH_ATTEMPTS] pages per session per sign-in, failures
     * included, so repeated visits cannot restart unlimited speculative work.
     * Scrolling back still loads further on demand.
     */
    suspend fun prefetchOlder(sessionId: String) {
        if (!prefetching.add(sessionId)) return
        try {
            while ((prefetchAttempts[sessionId] ?: 0) < MAX_PREFETCH_ATTEMPTS) {
                prefetchAttempts.merge(sessionId, 1, Int::plus)
                val advanced = try {
                    loadOlder(sessionId)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    return
                }
                if (!advanced) return
                delay(prefetchPauseMs)
            }
        } finally {
            prefetching.remove(sessionId)
        }
    }

    private fun markLoading(sessionId: String): Boolean {
        while (true) {
            val before = loadingOlderState.value
            if (sessionId in before) return false
            if (loadingOlderState.compareAndSet(before, before + sessionId)) return true
        }
    }

    private fun lock(sessionId: String): Mutex = locks.computeIfAbsent(sessionId) { Mutex() }

    private class Preload(val sessionId: String, val job: Job)

    companion object {
        /** `before_seq` of a first backward fetch: above any seq (the server's seq is a Postgres int4). */
        const val SEQ_BACKWARD_INITIAL_SENTINEL = 2_147_483_647L
        const val PAGE_SIZE = 100
        const val FORWARD_PAGE_SIZE = 500
        const val MAX_PREFETCH_ATTEMPTS = 5
    }
}
