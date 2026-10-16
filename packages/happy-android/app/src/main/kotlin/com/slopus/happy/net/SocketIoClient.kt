package com.slopus.happy.net

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random

/** apiSocket.ts's connection statuses, as Home's header shows them. */
enum class ConnectionStatus { DISCONNECTED, CONNECTING, CONNECTED, ERROR }

sealed interface SocketEvent {
    /**
     * The namespace handshake completed. The server runs without connection
     * state recovery, so every connect is a fresh session: anything sent
     * while the socket was down was missed, and the caller must resync.
     */
    data object Connected : SocketEvent

    data class Message(val name: String, val payload: JsonElement?) : SocketEvent
}

/** The socket is down, the server refused it, or an acknowledgement never came. */
class SocketIoException(message: String) : IOException(message)

/**
 * A minimal Socket.IO client for the default namespace over OkHttp's
 * WebSocket: the auth handshake, heartbeat replies, events in, events and
 * acknowledged calls out, and reconnects with socket.io-client's backoff as
 * apiSocket.ts configures it (1 s doubling to 5 s, jitter 0.5, forever).
 *
 * Why not a library: socket.io-client-java speaks the protocol but brings
 * its own OkHttp-based Engine.IO stack, org.json and a callback threading
 * model; the subset Happy uses is five packet types, small enough to own and
 * test against the wire format directly.
 *
 * Heartbeat replies and acknowledgements are answered on OkHttp's reader
 * thread, so a slow consumer never delays a pong. Everything else is
 * delivered in order through [events], which never drops: a live update
 * lost here is a message the user does not see.
 */
class SocketIoClient(
    private val client: OkHttpClient,
    private val url: () -> HttpUrl?,
    private val scope: CoroutineScope,
    private val headers: Map<String, String> = emptyMap(),
    private val reconnectDelayMs: (attempt: Int) -> Long = ::socketIoBackoff,
    private val auth: () -> JsonObject,
) {
    private val statusState = MutableStateFlow(ConnectionStatus.DISCONNECTED)
    val status: StateFlow<ConnectionStatus> = statusState.asStateFlow()

    private val eventChannel = Channel<SocketEvent>(Channel.UNLIMITED)

    /** Every connect and every server event, in arrival order. One consumer. */
    val events: kotlinx.coroutines.channels.ReceiveChannel<SocketEvent> get() = eventChannel

    private val nextAckId = AtomicLong()
    private val pendingAcks = ConcurrentHashMap<Long, CompletableDeferred<List<JsonElement>>>()
    private val wakeUp = Channel<Unit>(Channel.CONFLATED)
    private var loop: Job? = null

    @Volatile private var current: Connection? = null

    private inner class Connection : WebSocketListener() {
        lateinit var socket: WebSocket
        val closed = CompletableDeferred<Throwable?>()
        @Volatile var connected = false
        @Volatile var lastPacketAt = System.nanoTime()
        @Volatile var handshake: EngineIoHandshake? = null

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (current !== this) return
            lastPacketAt = System.nanoTime()
            when (val packet = EngineIoPacket.decode(text)) {
                is EngineIoPacket.Open -> {
                    handshake = packet.handshake
                    webSocket.send(EngineIoPacket.Message(SocketIoPacket.Connect(auth()).encode()).encode())
                }
                EngineIoPacket.Ping -> webSocket.send(EngineIoPacket.Pong.encode())
                EngineIoPacket.Close -> fail(SocketIoException("Server closed the connection"))
                is EngineIoPacket.Message -> onSocketIo(SocketIoPacket.decode(packet.payload) ?: return)
                EngineIoPacket.Pong, EngineIoPacket.Noop, null -> Unit
            }
        }

        private fun onSocketIo(packet: SocketIoPacket) {
            when (packet) {
                is SocketIoPacket.Connect -> {
                    connected = true
                    attempt = 0
                    wakeUp.tryReceive()
                    statusState.value = ConnectionStatus.CONNECTED
                    eventChannel.trySend(SocketEvent.Connected)
                }
                is SocketIoPacket.ConnectError -> {
                    val reason = (packet.payload as? JsonObject)?.get("message")?.jsonPrimitive?.contentOrNull
                    fail(SocketIoException("Connection refused: ${reason ?: "unknown reason"}"))
                }
                SocketIoPacket.Disconnect -> fail(SocketIoException("Server disconnected the socket"))
                is SocketIoPacket.Event -> eventChannel.trySend(SocketEvent.Message(packet.name, packet.arguments.firstOrNull()))
                is SocketIoPacket.Ack -> pendingAcks.remove(packet.id)?.complete(packet.arguments)
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            closed.complete(null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            closed.complete(null)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            closed.complete(t)
        }

        fun fail(error: Throwable) {
            socket.cancel()
            closed.complete(error)
        }
    }

    @Volatile private var attempt = 0

    /** Starts connecting, and keeps reconnecting until [disconnect]. */
    fun connect() {
        if (loop?.isActive == true) return
        statusState.value = ConnectionStatus.CONNECTING
        loop = scope.launch { runLoop() }
    }

    /** Drops the connection and stops reconnecting. */
    suspend fun disconnect() {
        loop?.cancelAndJoin()
        loop = null
        statusState.value = ConnectionStatus.DISCONNECTED
    }

    /** Skips the remaining reconnect delay, e.g. when the app returns to the foreground. */
    fun reconnectNow() {
        wakeUp.trySend(Unit)
    }

    /** Sends an event if connected. Not buffered: false means it was not sent. */
    fun emit(name: String, payload: JsonElement): Boolean {
        val connection = current?.takeIf { it.connected } ?: return false
        return connection.socket.send(EngineIoPacket.Message(SocketIoPacket.Event(name, listOf(payload)).encode()).encode())
    }

    /**
     * Sends an event and waits for the server's acknowledgement. A call made
     * while the socket is down waits for it to come back, as socket.io-client
     * buffers it; past [timeoutMs] in total it fails rather than wait forever.
     */
    suspend fun emitWithAck(name: String, payload: JsonElement, timeoutMs: Long): List<JsonElement> = try {
        withTimeout(timeoutMs) {
            var connection: Connection?
            while (true) {
                statusState.first { it == ConnectionStatus.CONNECTED }
                connection = current?.takeIf { it.connected && !it.closed.isCompleted }
                if (connection != null) break
                delay(STATUS_SETTLE_MS) // the status lags a connection that just closed
            }
            val live = connection!!
            val id = nextAckId.getAndIncrement()
            val result = CompletableDeferred<List<JsonElement>>()
            pendingAcks[id] = result
            try {
                val text = EngineIoPacket.Message(SocketIoPacket.Event(name, listOf(payload), ackId = id).encode()).encode()
                if (!live.socket.send(text)) throw SocketIoException("Not connected to the server")
                select {
                    result.onAwait { it }
                    live.closed.onAwait { throw SocketIoException("Connection lost before $name was acknowledged") }
                }
            } finally {
                pendingAcks.remove(id)
            }
        }
    } catch (e: TimeoutCancellationException) {
        throw SocketIoException("No acknowledgement for $name")
    }

    private suspend fun runLoop(): Nothing {
        while (true) {
            val failure = runConnection()
            statusState.value = if (failure != null) ConnectionStatus.ERROR else ConnectionStatus.DISCONNECTED
            attempt++
            withTimeoutOrNull(reconnectDelayMs(attempt)) { wakeUp.receive() }
        }
    }

    /** One connection's life. Null when it ended cleanly, else why it failed. */
    private suspend fun runConnection(): Throwable? {
        val target = url() ?: return SocketIoException("Invalid server URL")
        val request = Request.Builder().url(target).apply { headers.forEach { (k, v) -> header(k, v) } }.build()
        val connection = Connection()
        current = connection
        connection.socket = client.newWebSocket(request, connection)
        val watchdog = scope.launch { watch(connection) }
        try {
            val failure = connection.closed.await()
            // A socket that never completed the namespace handshake failed to connect.
            return failure ?: if (connection.connected) null else SocketIoException("Connection closed during handshake")
        } catch (e: CancellationException) {
            connection.socket.send(EngineIoPacket.Message(SocketIoPacket.Disconnect.encode()).encode())
            connection.socket.close(1000, null)
            throw e
        } finally {
            watchdog.cancel()
            if (current === connection) current = null
        }
    }

    /** The server pings every interval; silence past interval + timeout means a dead link TCP has not noticed. */
    private suspend fun watch(connection: Connection) {
        while (true) {
            delay(WATCHDOG_TICK_MS)
            val handshake = connection.handshake ?: continue
            val silentMs = (System.nanoTime() - connection.lastPacketAt) / 1_000_000
            if (silentMs > handshake.pingInterval + handshake.pingTimeout) {
                connection.fail(SocketIoException("Heartbeat timed out"))
                return
            }
        }
    }

    private companion object {
        const val WATCHDOG_TICK_MS = 1_000L
        const val STATUS_SETTLE_MS = 50L
    }
}

/** socket.io-client's reconnection delay: 1 s doubling to 5 s, ±50% jitter. */
fun socketIoBackoff(attempt: Int, random: Random = Random.Default): Long {
    val base = (1_000L shl (attempt - 1).coerceIn(0, 10)).coerceAtMost(5_000L)
    val deviation = (random.nextDouble() * 0.5 * base).toLong()
    val jittered = if (random.nextBoolean()) base + deviation else base - deviation
    return jittered.coerceIn(0, 5_000L)
}
