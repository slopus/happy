package com.slopus.happy.browser

import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.ChunkedDecoder
import com.slopus.happy.connection.TransportSocket
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withTimeout
import java.io.ByteArrayOutputStream
import java.net.Socket

/** A local socket (the WebView's or OkHttp's connection to the proxy) as a [TransportSocket]. */
internal class LocalSocket(private val socket: Socket) : TransportSocket {
    override suspend fun read(maximumBytes: Int): ByteArray = io {
        val buffer = ByteArray(maximumBytes)
        val count = socket.getInputStream().read(buffer)
        if (count < 0) ByteArray(0) else buffer.copyOf(count)
    }

    override suspend fun write(bytes: ByteArray) {
        io {
            socket.getOutputStream().write(bytes)
            socket.getOutputStream().flush()
        }
    }

    private suspend fun <T> io(block: () -> T): T = try {
        runInterruptible(Dispatchers.IO) { block() }
    } catch (e: CancellationException) {
        close()
        throw e
    }

    override fun close() {
        try {
            socket.close()
        } catch (_: Exception) {
            // Already gone.
        }
    }
}

/**
 * A page's connection to the proxy, read ahead by one reader of its own so
 * that waiting for it can be given up without closing it: [LocalSocket]'s
 * reads close the socket when cancelled. [input] waits for bytes or the
 * end without taking them, so an answer can watch for a page that went
 * away and still leave its next request whole.
 */
internal class PageConnection(private val socket: TransportSocket, scope: CoroutineScope) : TransportSocket {
    private class Buffer(val bytes: ByteArray, val ended: Boolean)

    private val state = MutableStateFlow(Buffer(ByteArray(0), false))
    private val lock = Mutex()
    private val reader = scope.launch {
        try {
            while (true) {
                // Read ahead at most this much: an upload waits for its tunnel.
                state.first { it.bytes.size < 262_144 }
                val bytes = socket.read(65536)
                lock.withLock { state.value = Buffer(state.value.bytes + bytes, bytes.isEmpty()) }
                if (bytes.isEmpty()) return@launch
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            lock.withLock { state.value = Buffer(state.value.bytes, true) }
        }
    }

    override val authority: String get() = socket.authority

    override suspend fun read(maximumBytes: Int): ByteArray {
        input()
        return lock.withLock {
            val buffered = state.value
            val taken = buffered.bytes.copyOf(minOf(maximumBytes, buffered.bytes.size))
            state.value = Buffer(buffered.bytes.copyOfRange(taken.size, buffered.bytes.size), buffered.ended)
            taken
        }
    }

    /** Until the page sends something or goes away; true when it sent something. */
    suspend fun input(): Boolean = state.first { it.bytes.isNotEmpty() || it.ended }.bytes.isNotEmpty()

    override suspend fun write(bytes: ByteArray) = socket.write(bytes)

    override fun close() {
        reader.cancel()
        socket.close()
    }
}

/** iOS's `BrowserRelay`: heads, bounded request bodies and duplex relays between two streams. */
object BrowserRelay {
    /** A request body is the artifact API's contract at most. */
    const val BODY_LIMIT = 1_048_576
    const val HEAD_TIMEOUT = 35_000L

    /** A head and whatever came after it, within 35 seconds and 32 KiB; a stream that ends first is unavailable. */
    suspend fun head(stream: TransportSocket, initial: ByteArray = ByteArray(0)): Pair<HttpHead, ByteArray> = try {
        withTimeout(HEAD_TIMEOUT) {
            var buffer = initial
            while (true) {
                HttpHead.parse(buffer)?.let { return@withTimeout it }
                val bytes = stream.read(65536)
                if (bytes.isEmpty()) throw BrowserException(BrowserException.Kind.Unavailable)
                buffer += bytes
            }
            @Suppress("UNREACHABLE_CODE") error("unreachable")
        }
    } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
        stream.close()
        throw BrowserException(BrowserException.Kind.Timeout)
    }

    /**
     * The request's whole body, bounded, and the head reframed to one exact
     * length: no trailer or pipelined request can enter the authenticated
     * daemon connection.
     */
    suspend fun requestBody(head: HttpHead, initial: ByteArray, stream: TransportSocket): Pair<HttpHead, ByteArray> {
        val lengths = head.fields.filter { it.first.equals("content-length", true) }
        val transfers = head.fields.filter { it.first.equals("transfer-encoding", true) }
        if (lengths.size > 1 || transfers.size > 1 || (lengths.isNotEmpty() && transfers.isNotEmpty())) throw BrowserException(BrowserException.Kind.Malformed)
        val body = ByteArrayOutputStream()
        val transfer = transfers.firstOrNull()
        if (transfer != null) {
            if (!transfer.second.equals("chunked", true)) throw BrowserException(BrowserException.Kind.Malformed)
            val decoder = ChunkedDecoder()
            var bytes = initial
            var received = 0
            while (true) {
                received += bytes.size
                if (received > BODY_LIMIT + 65536) throw BrowserException(BrowserException.Kind.TooLarge)
                try {
                    body.write(decoder.append(bytes))
                } catch (_: AgentConnectionException) {
                    throw BrowserException(BrowserException.Kind.Malformed)
                }
                if (body.size() > BODY_LIMIT) throw BrowserException(BrowserException.Kind.TooLarge)
                if (decoder.finished) break
                bytes = stream.read(65536)
                if (bytes.isEmpty()) throw BrowserException(BrowserException.Kind.Malformed)
            }
        } else {
            val text = lengths.firstOrNull()?.second ?: "0"
            val length = text.takeIf { it.isNotEmpty() && it.all(Char::isDigit) }?.toLongOrNull() ?: throw BrowserException(BrowserException.Kind.Malformed)
            if (initial.size > length) throw BrowserException(BrowserException.Kind.Malformed)
            if (length > BODY_LIMIT) throw BrowserException(BrowserException.Kind.TooLarge)
            body.write(initial)
            while (body.size() < length) {
                val bytes = stream.read(minOf(65536, (length - body.size()).toInt()))
                if (bytes.isEmpty() || bytes.size > length - body.size()) throw BrowserException(BrowserException.Kind.Malformed)
                body.write(bytes)
            }
        }
        val reframed = head.without("content-length", "transfer-encoding", "trailer")
        val bytes = body.toByteArray()
        return reframed.copy(fields = reframed.fields + ("Content-Length" to bytes.size.toString())) to bytes
    }

    /** Copies [source] to [destination] until it ends. */
    suspend fun pipe(source: TransportSocket, destination: TransportSocket) {
        while (true) {
            val bytes = source.read(65536)
            if (bytes.isEmpty()) return
            destination.write(bytes)
        }
    }

    /** Both ways until either side ends or fails; then both close, which wakes the other. */
    suspend fun duplex(first: TransportSocket, second: TransportSocket) {
        try {
            coroutineScope {
                val done = CompletableDeferred<Unit>()
                val ways = listOf(first to second, second to first).map { (from, to) ->
                    launch {
                        try {
                            pipe(from, to)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            // A failed side ends the relay as an ended one does.
                        }
                        done.complete(Unit)
                    }
                }
                done.await()
                first.close()
                second.close()
                ways.forEach { it.cancel() }
            }
        } finally {
            first.close()
            second.close()
        }
    }

    /** One HTTP answer read whole (bounded), by its length, its chunks, or to the close. */
    suspend fun response(stream: TransportSocket, limit: Int): Triple<HttpHead, ByteArray, Int> {
        val (head, rest) = head(stream)
        val status = head.status ?: throw BrowserException(BrowserException.Kind.Malformed)
        val chunked = head.value("transfer-encoding")?.lowercase()?.contains("chunked") == true
        val length = if (chunked) null else head.value("content-length")?.toLongOrNull()
        if (length != null && length > limit) throw BrowserException(BrowserException.Kind.TooLarge)
        val decoder = if (chunked) ChunkedDecoder() else null
        val body = ByteArrayOutputStream()
        fun take(bytes: ByteArray) {
            try {
                body.write(decoder?.append(bytes) ?: bytes)
            } catch (_: AgentConnectionException) {
                throw BrowserException(BrowserException.Kind.Malformed)
            }
            if (body.size() > limit) throw BrowserException(BrowserException.Kind.TooLarge)
        }
        take(rest)
        while (!(decoder?.finished ?: false) && body.size() < (length ?: Long.MAX_VALUE)) {
            val bytes = stream.read(65536)
            if (bytes.isEmpty()) {
                // Closed: the body is what came, unless more was promised.
                if (length != null || chunked) throw BrowserException(BrowserException.Kind.Malformed)
                break
            }
            take(bytes)
        }
        val all = body.toByteArray()
        return Triple(head, if (length != null) all.copyOf(minOf(all.size.toLong(), length).toInt()) else all, status)
    }
}
