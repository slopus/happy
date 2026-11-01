package com.slopus.happy.connection

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.delay
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit

/** A WebSocket upgrade was answered with [response] instead of `101`: a daemon refusal, or the edge's. */
class UpgradeRefused(val response: TransportResponse) : Exception("Upgrade refused: ${response.status}")

/**
 * A tunnel over one WebSocket (edge SSO contract §4): the daemon's
 * `…/proxy/websocket` twin of a `CONNECT` route, for load balancers that
 * don't pass CONNECT through. Binary messages carry the bytes that would
 * follow CONNECT's `200`, split anywhere; an empty one ends that direction.
 * Not resumable: a dropped tunnel is gone.
 *
 * Keepalive: OkHttp pings every [PING_SECONDS] and fails a socket whose
 * pong doesn't come back before the next ping, so a dead link is found
 * within two intervals, inside the contract's 45 s. Redirects are never
 * followed, and the credential goes only in `Authorization`.
 */
internal class WebSocketTunnel private constructor(override val authority: String) : TransportSocket {
    private val opened = CompletableDeferred<Unit>()
    // Bounded: a slow reader holds OkHttp's reader thread, which pushes back on the daemon.
    private val incoming = Channel<ByteArray>(capacity = 64)
    @Volatile private var socket: WebSocket? = null
    private var pending = ByteArray(0)
    private var ended = false

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            opened.complete(Unit)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            incoming.trySendBlocking(bytes.toByteArray())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            // Binary only, both ways.
            webSocket.close(1003, null)
            incoming.close(AgentConnectionException(AgentConnectionException.Reason.InvalidResponse))
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            incoming.close()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            incoming.close()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (!opened.isCompleted) {
                val refused = response?.let {
                    val headers = it.headers.associate { (name, value) -> name.lowercase() to value }
                    UpgradeRefused(TransportResponse(it.code, headers, runCatching { it.peekBody(MAX_REFUSAL).bytes() }.getOrDefault(ByteArray(0))))
                }
                opened.completeExceptionally(refused ?: AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(t))
            }
            incoming.close(AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(t))
        }
    }

    override suspend fun read(maximumBytes: Int): ByteArray {
        if (pending.isEmpty()) {
            if (ended) return ByteArray(0)
            val next = try {
                incoming.receive()
            } catch (_: ClosedReceiveChannelException) {
                ended = true
                return ByteArray(0)
            }
            if (next.isEmpty()) {
                ended = true
                return next
            }
            pending = next
        }
        val take = minOf(maximumBytes, pending.size)
        return pending.copyOf(take).also { pending = pending.copyOfRange(take, pending.size) }
    }

    override suspend fun write(bytes: ByteArray) {
        val ws = socket ?: throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        var offset = 0
        while (offset < bytes.size) {
            // OkHttp queues without bound and closes past 16 MiB: wait for it to drain instead.
            while (ws.queueSize() > MAX_QUEUED) delay(5)
            val end = minOf(bytes.size, offset + MAX_MESSAGE)
            if (!ws.send(bytes.toByteString(offset, end - offset))) throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
            offset = end
        }
    }

    override fun close() {
        incoming.cancel()
        socket?.let { if (!it.close(1000, null)) it.cancel() }
    }

    companion object {
        const val PING_SECONDS = 20L
        /** The contract allows up to 1 MiB a message; smaller keeps the queue moving. */
        private const val MAX_MESSAGE = 64 * 1024
        private const val MAX_QUEUED = 1024 * 1024L
        private const val MAX_REFUSAL = 16 * 1024L

        /** For tunnels: no redirects, a ping every [PING_SECONDS]. */
        val client: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .followRedirects(false)
                .followSslRedirects(false)
                .connectTimeout(20, TimeUnit.SECONDS)
                .pingInterval(PING_SECONDS, TimeUnit.SECONDS)
                .build()
        }

        /**
         * Opens `wss://[authority][path]` with [credential] as its bearer;
         * returns once it is upgraded. A refusal throws [UpgradeRefused], a
         * network failure [AgentConnectionException] (Unavailable).
         */
        suspend fun open(authority: String, path: String, credential: String, http: OkHttpClient = client): TransportSocket {
            val tunnel = WebSocketTunnel(authority)
            val request = Request.Builder()
                .url("wss://$authority$path")
                .header("Authorization", "Bearer $credential")
                .build()
            val socket = http.newWebSocket(request, tunnel.listener)
            tunnel.socket = socket
            try {
                tunnel.opened.await()
            } catch (e: CancellationException) {
                socket.cancel()
                throw e
            }
            return tunnel
        }
    }
}
