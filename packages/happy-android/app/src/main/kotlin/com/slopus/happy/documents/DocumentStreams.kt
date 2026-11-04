package com.slopus.happy.documents

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** What one open document hears from the account's event stream. */
sealed class DocumentStreamEvent {
    /** A stream is up under this name: subscribe to it, then catch up. */
    data class Connected(val streamId: String) : DocumentStreamEvent()
    /** The stream went away; its subscriptions with it. */
    data object Disconnected : DocumentStreamEvent()
    data class Update(val frame: DocumentUpdateFrame) : DocumentStreamEvent()
    data class Presence(val frame: DocumentPresenceFrame) : DocumentStreamEvent()
}

/**
 * Routes the event stream's live document frames to the documents open on
 * this account (iOS's `DocumentStreams`). The session owns the one stream
 * and says when it opens, what its `hello` named it, and when it closes;
 * frames never touch the journal or the catalog.
 */
class DocumentStreams {
    private class Listener(val surfaceId: String, val channel: SendChannel<DocumentStreamEvent>)

    private val lock = Any()
    private var streamId: String? = null
    private val listeners = LinkedHashSet<Listener>()

    /** The stream's current name, if one is up. */
    val current: String? get() = synchronized(lock) { streamId }

    /** Events for one document, starting with [DocumentStreamEvent.Connected] when a stream is already up. */
    fun events(surfaceId: String): Flow<DocumentStreamEvent> = callbackFlow {
        val listener = Listener(surfaceId, channel)
        synchronized(lock) {
            listeners += listener
            streamId?.let { trySend(DocumentStreamEvent.Connected(it)) }
        }
        awaitClose { synchronized(lock) { listeners -= listener } }
    }.buffer(Channel.UNLIMITED)

    /** The `hello` frame. Daemons without collaborative documents name no stream. */
    fun opened(hello: JsonObject) {
        val id = (hello["streamId"] as? JsonPrimitive)?.contentOrNull ?: return
        val event = DocumentStreamEvent.Connected(id)
        synchronized(lock) {
            streamId = id
            listeners.forEach { it.channel.trySend(event) }
        }
    }

    fun closed() {
        synchronized(lock) {
            if (streamId == null) return
            streamId = null
            listeners.forEach { it.channel.trySend(DocumentStreamEvent.Disconnected) }
        }
    }

    fun frame(event: String, data: String) {
        val (surfaceId, decoded) = when (event) {
            UPDATE -> DocumentRoutes.decodeUpdate(data)?.let { it.surfaceId to DocumentStreamEvent.Update(it) }
            PRESENCE -> DocumentRoutes.decodePresence(data)?.let { it.surfaceId to DocumentStreamEvent.Presence(it) }
            else -> null
        } ?: return
        synchronized(lock) {
            listeners.forEach { if (it.surfaceId == surfaceId) it.channel.trySend(decoded) }
        }
    }

    fun stop() {
        synchronized(lock) {
            streamId = null
            listeners.forEach { it.channel.close() }
            listeners.clear()
        }
    }

    companion object {
        const val UPDATE = "document.update"
        const val PRESENCE = "document.presence"

        /** Whether [event] is a live document frame, routed here, rather than a journal event. */
        fun isDocumentFrame(event: String): Boolean = event == UPDATE || event == PRESENCE
    }
}
