package com.slopus.happy.documents

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.documents.yjs.YAny
import com.slopus.happy.documents.yjs.YAwarenessState
import com.slopus.happy.documents.yjs.YDoc
import com.slopus.happy.documents.yjs.YRelativePosition
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.util.Base64

/** Where the document's own changes stand, as the editor's header says it. */
enum class DocumentSaveState {
    /** The computer has everything made here. */
    Saved,
    /** On its way now. */
    Saving,
    /** Kept on this phone until the computer can be reached. */
    Waiting,
}

/** Another editor in the document: who, and where their cursor is. */
data class DocumentPeer(
    /** The daemon's name for their stream's presence (`clientKey`). */
    val key: String,
    val clientID: Long,
    val name: String,
    /** CSS colour as desktop sends it (`#rrggbb`). */
    val color: String,
    val anchor: YRelativePosition? = null,
    val head: YRelativePosition? = null,
) {
    companion object {
        /** BlockNote's awareness state: `{ user: { name, color }, cursor: { anchor, head } }`. */
        fun of(key: String, clientID: Long, state: YAny): DocumentPeer? {
            val user = state["user"] ?: return null
            return DocumentPeer(
                key, clientID, user["name"]?.stringValue ?: "", user["color"]?.stringValue ?: "#888888",
                state["cursor"]?.get("anchor")?.let(YRelativePosition::fromJson),
                state["cursor"]?.get("head")?.let(YRelativePosition::fromJson),
            )
        }

        /** This phone's state in the same shape, for desktop to draw. */
        fun state(name: String, color: String, anchor: YRelativePosition?, head: YRelativePosition?): YAny {
            val pairs = mutableListOf<Pair<String, YAny>>("user" to YAny.Object(listOf("name" to YAny.Str(name), "color" to YAny.Str(color))))
            if (anchor != null && head != null) pairs += "cursor" to YAny.Object(listOf("anchor" to anchor.json, "head" to head.json))
            return YAny.Object(pairs)
        }
    }
}

sealed class DocumentOpening {
    data object Ready : DocumentOpening()
    /**
     * The computer keeps this document as Markdown only (no
     * `collaborativeDocuments`): it can be read, not edited.
     */
    data object MarkdownOnly : DocumentOpening()
    /** Nothing kept here, and the computer can't be reached: the agent's words, or the link's [connection] failure. */
    data class Unavailable(val reason: String, val connection: AgentConnectionException.Reason? = null) : DocumentOpening()
}

sealed class DocumentSyncEvent {
    /** A change from elsewhere, for the editor's replica. */
    class Remote(val update: ByteArray) : DocumentSyncEvent()
    /** The computer's copy replaces this one (a change it refused twice): a fresh editor over it. */
    class Reset(val editor: DocumentEditor) : DocumentSyncEvent()
    data class Save(val state: DocumentSaveState) : DocumentSyncEvent()
    data class Peers(val peers: List<DocumentPeer>) : DocumentSyncEvent()
    /** Something to say for a moment: a change refused, in the agent's words (empty where it gave none). */
    data class Notice(val text: String) : DocumentSyncEvent()
    /** The document is gone from the computer. */
    data object Gone : DocumentSyncEvent()
}

/**
 * One document's sync, off the main thread (iOS's `DocumentSync`,
 * docs/DOCUMENT-EDITOR.md). Everything it holds is touched only on its own
 * one-at-a-time dispatcher, as iOS's actor: suspensions (the network)
 * interleave, nothing else does.
 *
 * It keeps its own replica of the document, beside the editor's: every
 * change the editor makes comes here through [local], is kept on disk at
 * once ([DocumentKeep]), and goes to the computer in batches, one at a
 * time and at least [SPACING] apart, each under a mutation ID that a retry
 * repeats. Changes from elsewhere land here first and go on to the editor
 * only when they changed something. A reconnect subscribes the new stream
 * and catches up by state vector, so nothing a dropped stream carried is
 * missed.
 *
 * It lives while an editor holds it, and after that until everything made
 * here is sent ([DocumentLibrary]).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DocumentSync internal constructor(
    val surfaceId: String,
    private val client: AgentClient,
    private val streams: DocumentStreams,
    directory: File?,
    parent: CoroutineScope,
    private val retire: suspend (DocumentSync) -> Unit = {},
) {
    private val confined = Dispatchers.IO.limitedParallelism(1)
    private val scope = CoroutineScope(parent.coroutineContext + SupervisorJob(parent.coroutineContext[Job]) + confined)
    private val keep: DocumentKeep? = directory?.let { DocumentKeep(DocumentKeep.directory(it, surfaceId)) }
    private val localChannel = Channel<ByteArray>(Channel.UNLIMITED)
    private class PresenceState(val state: YAny?)
    private val presenceChannel = Channel<PresenceState>(Channel.CONFLATED)

    private var replica = YDoc()
    /** Whether the replica's last transaction changed anything: set from inside its own transactions. */
    private var changed = false
    private var meta = DocumentKeep.Meta()
    private var sending: DocumentKeep.Sending? = null
    /** A local change came after the batch on its way was made. */
    private var changedSinceBatch = false
    private var editorClient = 0L
    private var holders = 0
    private var opening: DocumentOpening? = null
    private var streamId: String? = null
    private var caughtUp = false
    private var refusals = 0
    private var lastPost: Long? = null
    private var flushing: Job? = null
    private var connecting: Job? = null
    private var compacting: Job? = null
    private val following = ArrayList<Job>()
    private val listeners = ArrayList<Channel<DocumentSyncEvent>>()
    private var save = DocumentSaveState.Saved
    private var localPresence: YAny? = null
    private var presenceClock = 0
    private var presenceSending: Job? = null
    private var presenceDirty = false
    private val peers = HashMap<String, Pair<Int, DocumentPeer?>>()
    private var closed = false

    /** Updates posted, for tests that count them. */
    @Volatile var posts = 0
        private set
    /** Local changes taken in and kept. */
    @Volatile var kept = 0
        private set

    /** Each local change the editor made, in order ([DocumentEditor.onLocalUpdate]); from any thread. */
    fun local(update: ByteArray) {
        localChannel.trySend(update)
    }

    /** This phone's awareness state; null when it leaves. From any thread; only the latest counts. */
    fun presence(state: YAny?) {
        presenceChannel.trySend(PresenceState(state))
    }

    /** What happens to the document from now, starting with where saving stands. Cancel it to stop listening. */
    suspend fun events(): ReceiveChannel<DocumentSyncEvent> = withContext(confined) {
        val channel = Channel<DocumentSyncEvent>(Channel.UNLIMITED)
        channel.trySend(DocumentSyncEvent.Save(save))
        if (closed) channel.close() else listeners += channel
        channel
    }

    private fun emit(event: DocumentSyncEvent) {
        listeners.removeAll { it.trySend(event).isClosed }
    }

    // Opening

    /** The document from disk if it was kept, else from the computer. Once. */
    suspend fun start(): DocumentOpening = withContext(confined) {
        opening?.let { return@withContext it }
        val result = load()
        if (opening == null) opening = result
        if (result == DocumentOpening.Ready && following.isEmpty()) follow()
        publishSave()
        opening ?: result
    }

    private suspend fun load(): DocumentOpening {
        watchReplica()
        val keep = keep
        if (keep != null && keep.exists) {
            val kept = keep.read()
            meta = kept.meta
            sending = kept.sending
            kept.state?.let { runCatching { replica.applyUpdate(it) } }
            for (update in kept.local) runCatching { replica.applyUpdate(update) }
            if (kept.local.isNotEmpty()) meta = meta.copy(unsent = true)
            return DocumentOpening.Ready
        }
        return try {
            val state = DocumentRoutes.state(client, surfaceId)
            replica.applyUpdate(state.update)
            meta = meta.copy(serverVector = state.stateVector, seq = state.seq)
            runCatching { keep?.writeState(replica.encodeStateAsUpdate()) }
            runCatching { keep?.writeMeta(meta) }
            DocumentOpening.Ready
        } catch (e: CancellationException) {
            throw e
        } catch (e: AgentApiException) {
            if (e.status == 404 || e.status == 501) {
                // A computer without shared documents has no `/state`; one with them doesn't know this one.
                val collaborative = try { DocumentRoutes.collaborativeDocuments(client) } catch (c: CancellationException) { throw c } catch (_: Exception) { false }
                if (collaborative) DocumentOpening.Unavailable("") else DocumentOpening.MarkdownOnly
            } else {
                DocumentOpening.Unavailable(e.message.orEmpty())
            }
        } catch (e: AgentConnectionException) {
            DocumentOpening.Unavailable("", e.reason)
        } catch (_: Exception) {
            DocumentOpening.Unavailable("", AgentConnectionException.Reason.InvalidResponse)
        }
    }

    private fun watchReplica() {
        replica.onTransaction = { result -> if (result.changed.isNotEmpty() || !result.deleteSet.isEmpty) changed = true }
    }

    /**
     * An editor over the replica as it stands, for the main thread. Later
     * remote changes come as [DocumentSyncEvent.Remote] events in order
     * after it: listen to [events] first, and a change that lands between
     * the two comes twice, which merges as once.
     */
    suspend fun editor(): DocumentEditor? = withContext(confined) {
        if (opening != DocumentOpening.Ready || closed) return@withContext null
        holders += 1
        makeEditor()
    }

    private fun makeEditor(): DocumentEditor {
        val vector = replica.stateVector()
        var clientID = YDoc.randomClientID()
        while (vector.containsKey(clientID) || clientID in meta.localClients) clientID = YDoc.randomClientID()
        val doc = YDoc(clientID)
        doc.applyUpdate(replica.encodeStateAsUpdate())
        editorClient = clientID
        meta = meta.copy(localClients = meta.localClients + clientID)
        runCatching { keep?.writeMeta(meta) }
        return DocumentEditor(doc)
    }

    /**
     * The editor is gone. Its presence leaves now; the sync itself once
     * everything made here has reached the computer.
     */
    suspend fun release() = withContext(confined) {
        holders = maxOf(0, holders - 1)
        if (holders != 0) return@withContext
        setPresence(null)
        if (save == DocumentSaveState.Saved) shutDown()
    }

    private fun follow() {
        following += scope.launch { for (update in localChannel) received(update) }
        following += scope.launch { for (presence in presenceChannel) setPresence(presence.state) }
        following += scope.launch { streams.events(surfaceId).collect { received(it) } }
    }

    // Local changes

    private fun received(update: ByteArray) {
        if (closed) return
        runCatching { replica.applyUpdate(update, origin = "local") }
        runCatching { keep?.append(update) }
        kept += 1
        changedSinceBatch = true
        if (!meta.unsent) {
            meta = meta.copy(unsent = true)
            runCatching { keep?.writeMeta(meta) }
        }
        // A second editor on the same document hears the first one's change.
        if (holders > 1) emit(DocumentSyncEvent.Remote(update))
        if ((keep?.logSize ?: 0) > 256 * 1024) compactNow()
        publishSave()
        flush()
    }

    private fun flush() {
        if (streamId == null || !caughtUp || flushing != null || (sending == null && !meta.unsent)) return
        flushing = scope.launch { flushLoop() }
    }

    private suspend fun flushLoop() {
        val me = currentCoroutineContext().job
        try {
            var failures = 0
            while (!closed && streamId != null && caughtUp) {
                if (sending == null) {
                    if (!meta.unsent) break
                    sending = makeBatch()
                    runCatching { keep?.writeSending(sending) }
                    changedSinceBatch = false
                }
                val batch = sending ?: break
                lastPost?.let { last ->
                    val wait = (last + SPACING * 1_000_000 - System.nanoTime()) / 1_000_000
                    if (wait > 0) delay(wait)
                }
                publishSave()
                lastPost = System.nanoTime()
                posts += 1
                try {
                    val seq = DocumentRoutes.sendUpdate(client, surfaceId, batch.mutationId, batch.bytes)
                    if (sending?.mutationId != batch.mutationId) continue
                    val vector = meta.serverVector.toMutableMap()
                    for ((client, clock) in batch.vector) vector[client] = maxOf(vector[client] ?: 0, clock)
                    meta = meta.copy(serverVector = vector, seq = maxOf(meta.seq, seq), unsent = meta.unsent && changedSinceBatch)
                    sending = null
                    runCatching { keep?.writeSending(null) }
                    runCatching { keep?.writeMeta(meta) }
                    failures = 0
                    refusals = 0
                } catch (e: CancellationException) {
                    throw e
                } catch (e: AgentApiException) {
                    if (e.status == 404) {
                        gone()
                        break
                    }
                    if (refusal(e.status)) {
                        refused(e.message.orEmpty())
                        break
                    }
                    if (streamId == null) break
                    failures += 1
                    delay(backoff(failures))
                } catch (_: Exception) {
                    if (streamId == null) break
                    failures += 1
                    delay(backoff(failures))
                }
            }
        } finally {
            if (flushing === me) flushing = null
        }
        publishSave()
        if (!closed && (sending != null || meta.unsent)) flush()
    }

    /**
     * Everything made here the computer is not known to have: local
     * clients' structs past what it took, and the delete set.
     */
    private fun makeBatch(): DocumentKeep.Sending {
        val since = replica.stateVector().toMutableMap()
        val vector = HashMap<Long, Int>()
        for (client in meta.localClients) {
            since[client]?.let { vector[client] = it }
            since[client] = meta.serverVector[client] ?: 0
        }
        return DocumentKeep.Sending(AgentClient.newId(), Base64.getEncoder().encodeToString(replica.encodeStateAsUpdate(since)), vector)
    }

    /**
     * A refusal: once, read the computer's state and send what it lacks
     * again; twice, take the computer's copy and drop what it won't have.
     */
    private suspend fun refused(reason: String) {
        sending = null
        runCatching { keep?.writeSending(null) }
        refusals += 1
        if (refusals < 2) {
            caughtUp = false
            try {
                catchUp()
                caughtUp = streamId != null
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
            return
        }
        refusals = 0
        try {
            val state = DocumentRoutes.state(client, surfaceId)
            replica = YDoc()
            watchReplica()
            replica.applyUpdate(state.update)
            meta = DocumentKeep.Meta(serverVector = state.stateVector, seq = state.seq)
            keep?.remove()
            runCatching { keep?.writeState(replica.encodeStateAsUpdate()) }
            if (holders > 0) emit(DocumentSyncEvent.Reset(makeEditor())) else runCatching { keep?.writeMeta(meta) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
        emit(DocumentSyncEvent.Notice(reason))
    }

    private fun gone() {
        keep?.remove()
        meta = DocumentKeep.Meta()
        sending = null
        emit(DocumentSyncEvent.Gone)
        scope.launch { shutDown() }
    }

    // The stream

    private fun received(event: DocumentStreamEvent) {
        if (closed) return
        when (event) {
            is DocumentStreamEvent.Connected -> {
                streamId = event.streamId
                caughtUp = false
                connecting?.cancel()
                connecting = scope.launch { connect(event.streamId) }
            }
            DocumentStreamEvent.Disconnected -> {
                streamId = null
                caughtUp = false
                connecting?.cancel(); connecting = null
                flushing?.cancel(); flushing = null
                presenceSending?.cancel(); presenceSending = null
                if (peers.isNotEmpty()) {
                    peers.clear()
                    publishPeers()
                }
                publishSave()
            }
            is DocumentStreamEvent.Update -> {
                val bytes = runCatching { Base64.getDecoder().decode(event.frame.update) }.getOrNull() ?: return
                applyRemote(bytes)
                meta = meta.copy(seq = maxOf(meta.seq, event.frame.seq))
            }
            is DocumentStreamEvent.Presence -> receivedPresence(event.frame)
        }
    }

    private suspend fun connect(id: String) {
        var failures = 0
        while (streamId == id && !closed) {
            try {
                DocumentRoutes.subscribe(client, surfaceId, id)
                if (streamId != id) return
                catchUp()
                if (streamId != id) return
                caughtUp = true
                presenceDirty = localPresence != null
                sendPresenceSoon()
                flush()
                publishSave()
                return
            } catch (e: CancellationException) {
                throw e
            } catch (e: AgentApiException) {
                if (e.status == 404) {
                    gone()
                    return
                }
                failures += 1
                delay(backoff(failures))
            } catch (_: Exception) {
                failures += 1
                delay(backoff(failures))
            }
        }
    }

    /** Only what the replica lacks, and what the computer holds now. */
    private suspend fun catchUp() {
        val state = DocumentRoutes.state(client, surfaceId, stateVector = replica.stateVector())
        applyRemote(state.update)
        meta = meta.copy(serverVector = state.stateVector, seq = maxOf(meta.seq, state.seq))
        val vector = replica.stateVector()
        if (meta.localClients.any { (vector[it] ?: 0) > (state.stateVector[it] ?: 0) }) meta = meta.copy(unsent = true)
        runCatching { keep?.writeMeta(meta) }
    }

    private fun applyRemote(update: ByteArray) {
        changed = false
        runCatching { replica.applyUpdate(update, origin = "remote") }
        if (!changed) return
        changed = false
        emit(DocumentSyncEvent.Remote(update))
        compactSoon()
    }

    // Keeping

    private fun compactSoon() {
        if (compacting != null) return
        compacting = scope.launch {
            delay(3_000)
            compactNow()
        }
    }

    private fun compactNow() {
        compacting?.cancel()
        compacting = null
        if (closed && keep?.exists != true) return
        runCatching { keep?.writeState(replica.encodeStateAsUpdate()) }
    }

    // Presence

    private fun setPresence(state: YAny?) {
        if (closed || state == localPresence) return
        localPresence = state
        presenceDirty = true
        sendPresenceSoon()
    }

    private fun sendPresenceSoon() {
        if (presenceSending != null || streamId == null || !caughtUp || editorClient == 0L) return
        presenceSending = scope.launch { presenceLoop() }
    }

    /**
     * At most one awareness update per [PRESENCE_SPACING], and the same
     * again every [PRESENCE_REFRESH] so the daemon doesn't time it out.
     */
    private suspend fun presenceLoop() {
        val me = currentCoroutineContext().job
        try {
            var last: Long? = null
            while (!closed && caughtUp && currentCoroutineContext().isActive) {
                val id = streamId ?: break
                if (!presenceDirty) {
                    if (localPresence == null) break
                    delay(PRESENCE_SPACING)
                    if (last != null && (System.nanoTime() - last) / 1_000_000 >= PRESENCE_REFRESH) presenceDirty = true
                    continue
                }
                last?.let {
                    val wait = (it + PRESENCE_SPACING * 1_000_000 - System.nanoTime()) / 1_000_000
                    if (wait > 0) delay(wait)
                }
                presenceDirty = false
                presenceClock += 1
                last = System.nanoTime()
                sendPresence(id)
            }
        } finally {
            if (presenceSending === me) presenceSending = null
        }
    }

    private suspend fun sendPresence(id: String) {
        val update = YAwarenessState.encode(listOf(YAwarenessState(editorClient, presenceClock, localPresence)))
        try {
            DocumentRoutes.sendPresence(client, surfaceId, id, editorClient, update)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    private fun receivedPresence(frame: DocumentPresenceFrame) {
        val seen = peers[frame.clientKey]
        if (seen != null && seen.first >= frame.revision) return
        var peer: DocumentPeer? = null
        val text = frame.update
        if (frame.active && text != null) {
            val states = runCatching { YAwarenessState.decode(Base64.getDecoder().decode(text)) }.getOrNull()
            val state = states?.firstOrNull { it.clientID != editorClient }
            val value = state?.state
            if (value != null) peer = DocumentPeer.of(frame.clientKey, state.clientID, value)
        }
        peers[frame.clientKey] = frame.revision to peer
        publishPeers()
    }

    private fun publishPeers() {
        emit(DocumentSyncEvent.Peers(peers.values.mapNotNull { it.second }.sortedBy { it.key }))
    }

    // State

    private fun publishSave() {
        val next = when {
            sending == null && !meta.unsent -> DocumentSaveState.Saved
            streamId != null -> DocumentSaveState.Saving
            else -> DocumentSaveState.Waiting
        }
        if (next == save) return
        save = next
        emit(DocumentSyncEvent.Save(next))
        if (next == DocumentSaveState.Saved && holders == 0 && opening == DocumentOpening.Ready) {
            scope.launch { if (holders == 0 && save == DocumentSaveState.Saved) shutDown() }
        }
    }

    suspend fun saveState(): DocumentSaveState = withContext(confined) { save }
    suspend fun head(): Int = withContext(confined) { meta.seq }
    suspend fun isClosed(): Boolean = withContext(confined) { closed }

    /** Lets go of the stream and keeps the replica whole. */
    internal suspend fun shutDown(): Unit = withContext(confined + NonCancellable) {
        if (closed) return@withContext
        compactNow()
        closed = true
        following.forEach { it.cancel() }
        following.clear()
        presenceSending?.cancel(); presenceSending = null
        connecting?.cancel(); connecting = null
        flushing?.cancel(); flushing = null
        streamId?.let { id ->
            if (localPresence != null || presenceClock > 0) {
                localPresence = null
                presenceClock += 1
                sendPresence(id)
            }
            try {
                DocumentRoutes.unsubscribe(client, surfaceId, id)
            } catch (_: Exception) {
            }
        }
        keep?.close()
        listeners.forEach { it.close() }
        listeners.clear()
        retire(this@DocumentSync)
    }

    private fun refusal(status: Int) = status in 400..499 && status != 408 && status != 429

    private fun backoff(failures: Int): Long = minOf(30_000L, 1_000L shl minOf(failures - 1, 5))

    companion object {
        const val SPACING = 200L
        const val PRESENCE_SPACING = 250L
        const val PRESENCE_REFRESH = 15_000L
    }
}

/**
 * The documents of one connection (iOS's `DocumentLibrary`): one
 * [DocumentSync] per document while an editor holds it or it has changes to
 * send. When the stream comes back, those left with unsent changes (closed
 * offline, or kept across a relaunch) are opened again to send them, editor
 * or not.
 */
class DocumentLibrary(
    private val client: AgentClient,
    /** Where documents are kept (`<connection>.documents/`); null keeps nothing. */
    private val directory: File?,
    parent: CoroutineScope,
) {
    val streams = DocumentStreams()
    private val scope = CoroutineScope(parent.coroutineContext + SupervisorJob(parent.coroutineContext[Job]) + Dispatchers.IO)
    private val lock = Any()
    private val syncs = HashMap<String, DocumentSync>()

    fun document(surfaceId: String): DocumentSync = synchronized(lock) {
        syncs.getOrPut(surfaceId) {
            DocumentSync(surfaceId, client, streams, directory, scope) { retire(it) }
        }
    }

    private fun retire(sync: DocumentSync) {
        synchronized(lock) { if (syncs[sync.surfaceId] === sync) syncs.remove(sync.surfaceId) }
    }

    val open: List<String> get() = synchronized(lock) { syncs.keys.sorted() }

    fun opened(hello: JsonObject) {
        streams.opened(hello)
        if (streams.current == null) return
        scope.launch { resumeUnsent() }
    }

    fun closed() = streams.closed()

    fun frame(event: String, data: String) = streams.frame(event, data)

    suspend fun stop() {
        val all = synchronized(lock) { syncs.values.toList().also { syncs.clear() } }
        for (sync in all) sync.shutDown()
        streams.stop()
    }

    /** Those kept with something unsent, which no editor holds now. */
    private fun resumeUnsent() {
        val ids = directory?.list() ?: return
        for (id in ids) {
            if (synchronized(lock) { id in syncs }) continue
            val kept = DocumentKeep(File(directory, id)).read()
            if (!kept.meta.unsent && kept.sending == null && kept.local.isEmpty()) continue
            val sync = document(id)
            scope.launch { sync.start() }
        }
    }
}
