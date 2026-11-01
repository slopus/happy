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
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>): TransportResponse =
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
) : Transport {
    private val lock = Any()
    private val sockets = mutableSetOf<TlsSocket>()
    private var closed = false

    override suspend fun socket(): TransportSocket {
        val raw = Socket()
        val stream = TlsSocket(raw)
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
            }
            return stream
        } catch (error: Throwable) {
            stream.close()
            throw error
        }
    }

    override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>): TransportResponse {
        val head = TailcatHttp.requestHead(method, path, origin.port, credential, body, headers, origin.authority)
        try {
            return withTimeout(requestTimeoutMillis) {
                val stream = socket()
                try {
                    stream.write(head)
                    if (body != null) stream.write(body)
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
        val socket = socket() as TlsSocket
        try {
            socket.timeout(silenceMillis.coerceIn(1, Int.MAX_VALUE.toLong()).toInt())
            socket.write(head)
            return TransportStream.open(object : ByteSource {
                override suspend fun read(): ByteArray = socket.read()
                override fun close() = socket.close()
            })
        } catch (error: Throwable) { socket.close(); throw error }
    }

    override suspend fun reset() {
        val old = synchronized(lock) { sockets.toList().also { sockets.clear() } }
        old.forEach { it.close() }
    }

    override suspend fun close() {
        synchronized(lock) { closed = true }
        reset()
    }

    private inner class TlsSocket(private val raw: Socket) : TransportSocket {
        override val authority: String get() = origin.authority
        private var tls: SSLSocket? = null
        private var ended = false

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
                tls
            }
            try { raw.close() } catch (_: Exception) { }
            try { secure?.close() } catch (_: Exception) { }
            synchronized(lock) { sockets.remove(this) }
        }
    }
}