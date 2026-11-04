package com.slopus.happy.connection

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.net.InetSocketAddress
import java.net.Socket
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlin.coroutines.resumeWithException

fun agentTransport(address: String, port: Int, publicUrl: String?, tailcatAvailable: Boolean = true): Transport = when {
    publicUrl != null -> HttpsTransport(AgentOrigin.parse(publicUrl))
    tailcatAvailable -> TailcatTransport(address, port)
    else -> object : Transport {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse =
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        override suspend fun close() { }
    }
}

/**
 * HTTP/1.1 over platform-verified TLS, including SSE, WebSocket upgrades and
 * CONNECT. Raw framing deliberately never follows a redirect with credentials.
 */
class HttpsTransport internal constructor(
    private val origin: AgentOrigin,
    private val socketFactory: SSLSocketFactory = SSLSocketFactory.getDefault() as SSLSocketFactory,
    private val requestTimeoutMillis: Long = 35_000,
    private val fileTimeoutMillis: Long = 15 * 60_000,
    private val webSockets: okhttp3.OkHttpClient = WebSocketTunnel.client,
) : Transport {
    private val lock = Any()
    private val sockets = mutableSetOf<TlsSocket>()
    private val tunnels = mutableSetOf<TransportSocket>()
    private var closed = false

    override suspend fun socket(): TransportSocket = socket(RequestCategory.File)

    override suspend fun overHttps(): Boolean = true

    override suspend fun diagnostics(): TransportDiagnostics = synchronized(lock) {
        TransportDiagnostics(TransportDiagnostics.Kind.Https, sockets.count { it.connected } + tunnels.size, server = origin.authority)
    }

    override suspend fun webSocketTunnel(path: String, credential: String): TransportSocket {
        if (!path.startsWith("/") || path.any { it.code <= 32 || it.code >= 127 } || credential.any { it.code < 32 || it.code >= 127 }) {
            throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        }
        synchronized(lock) { if (closed) throw AgentConnectionException(AgentConnectionException.Reason.Unavailable) }
        val tunnel = WebSocketTunnel.open(origin.authority, path, credential, webSockets)
        val kept = synchronized(lock) { (!closed).also { if (it) tunnels.add(tunnel) } }
        if (!kept) {
            tunnel.close()
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        }
        // Forgotten when it closes, so a long-lived transport doesn't hold every tunnel it made.
        return object : TransportSocket by tunnel {
            private val ended = java.util.concurrent.atomic.AtomicBoolean()
            override suspend fun read(maximumBytes: Int): ByteArray = try {
                tunnel.read(maximumBytes).also { if (it.isEmpty()) close() }
            } catch (error: Throwable) { close(); throw error }
            override suspend fun write(bytes: ByteArray) {
                try { tunnel.write(bytes) } catch (error: Throwable) { close(); throw error }
            }
            override fun close() {
                if (!ended.compareAndSet(false, true)) return
                synchronized(lock) { tunnels.remove(tunnel) }
                tunnel.close()
            }
        }
    }

    private suspend fun socket(category: RequestCategory): TlsSocket {
        val raw = Socket()
        val stream = TlsSocket(raw, category)
        synchronized(lock) {
            if (closed) throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
            sockets.add(stream)
        }
        try {
            stream.io {
                raw.connect(InetSocketAddress(origin.host, origin.port), 20_000)
                val tls = socketFactory.createSocket(raw, origin.host, origin.port, true) as SSLSocket
                stream.use(tls)
                // Default trust roots plus HTTPS hostname verification. No custom
                // verifier, trust manager, or fallback to a plaintext socket.
                tls.sslParameters = tls.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
                tls.soTimeout = 35_000
                tls.startHandshake()
                tls.soTimeout = 0
                stream.connected()
            }
            return stream
        } catch (error: Throwable) {
            stream.close()
            throw error
        }
    }

    override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
        val head = TailcatHttp.requestHead(method, path, origin.port, credential, body, headers, origin.authority)
        try {
            return withTimeout(if (category == RequestCategory.File) fileTimeoutMillis else requestTimeoutMillis) {
                val stream = socket(category)
                try {
                    stream.write(head)
                    val progress = currentCoroutineContext()[BodyProgress]
                    if (body != null) {
                        if (progress == null) stream.write(body)
                        else progress.write(body) { stream.write(it) }
                    }
                    val parser = HttpResponseParser()
                    var response: TransportResponse? = null
                    while (response == null) {
                        val bytes = stream.read()
                        response = parser.append(bytes, eof = bytes.isEmpty())
                    }
                    response
                } finally { stream.close() }
            }
        } catch (error: TimeoutCancellationException) {
            // A transport deadline is a network failure; a cancelled caller
            // (including its own deadline) must remain cancellation.
            currentCoroutineContext().ensureActive()
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        }
    }

    override suspend fun stream(path: String, credential: String, headers: Map<String, String>, silenceMillis: Long): TransportStream {
        val head = TailcatHttp.requestHead("GET", path, origin.port, credential, null, headers + ("Accept" to "text/event-stream"), origin.authority)
        val socket = socket(RequestCategory.Realtime)
        try {
            socket.timeout(silenceMillis.coerceIn(1, Int.MAX_VALUE.toLong()).toInt())
            socket.write(head)
            return TransportStream.open(object : ByteSource {
                override suspend fun read(): ByteArray = socket.read()
                override fun close() = socket.close()
            })
        } catch (error: Throwable) { socket.close(); throw error }
    }

    override suspend fun reset(category: RequestCategory) {
        val old = synchronized(lock) { sockets.filter { it.category == category }.also { sockets.removeAll(it.toSet()) } }
        old.forEach { it.close() }
        // Tunnels are the browser's, as File sockets are.
        if (category == RequestCategory.File) synchronized(lock) { tunnels.toList().also { tunnels.clear() } }.forEach { it.close() }
    }

    override suspend fun reset() {
        val old = synchronized(lock) { sockets.toList().also { sockets.clear() } }
        old.forEach { it.close() }
        synchronized(lock) { tunnels.toList().also { tunnels.clear() } }.forEach { it.close() }
    }

    override suspend fun close() {
        synchronized(lock) { closed = true }
        reset()
    }

    private inner class TlsSocket(private val raw: Socket, val category: RequestCategory) : TransportSocket {
        override val authority: String get() = origin.authority
        private var tls: SSLSocket? = null
        private var ended = false
        @Volatile var connected = false
            private set

        @Synchronized fun connected() {
            if (ended) throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
            connected = true
        }

        @Synchronized fun use(value: SSLSocket) {
            if (ended) { value.close(); throw AgentConnectionException(AgentConnectionException.Reason.Unavailable) }
            tls = value
        }

        fun timeout(millis: Int) { tls?.soTimeout = millis }

        override suspend fun read(maximumBytes: Int): ByteArray = io {
            val bytes = ByteArray(maximumBytes)
            val size = requireNotNull(tls).inputStream.read(bytes)
            if (size < 0) ByteArray(0) else bytes.copyOf(size)
        }

        override suspend fun write(bytes: ByteArray) { io { requireNotNull(tls).outputStream.write(bytes) } }

        // Closing the socket wakes blocked TLS I/O immediately on cancellation;
        // interrupting a Java socket's thread alone does not do that.
        suspend fun <T> io(block: () -> T): T = suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { close() }
            Dispatchers.IO.dispatch(continuation.context, Runnable {
                if (!continuation.isActive) return@Runnable
                try { continuation.resumeWith(Result.success(block())) }
                catch (error: Exception) {
                    close()
                    continuation.resumeWithException(error)
                }
            })
        }

        override fun close() {
            val secure = synchronized(this) {
                if (ended) return
                ended = true
                connected = false
                tls
            }
            try { raw.close() } catch (_: Exception) { }
            try { secure?.close() } catch (_: Exception) { }
            synchronized(lock) { sockets.remove(this) }
        }
    }
}