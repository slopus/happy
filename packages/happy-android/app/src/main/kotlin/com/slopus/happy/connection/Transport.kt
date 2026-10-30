package com.slopus.happy.connection

import io.tailcat.ClientConfiguration
import io.tailcat.DERPMapCache
import io.tailcat.DERPMapCacheEntry
import io.tailcat.DERPMapProvider
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import io.tailcat.TailcatClient
import io.tailcat.TailcatConnection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import kotlinx.coroutines.NonCancellable

/** One HTTP answer from a paired agent. Header names are lower case. */
class TransportResponse(val status: Int, val headers: Map<String, String> = emptyMap(), val body: ByteArray = ByteArray(0)) {
    val text: String get() = body.toString(Charsets.UTF_8)
}

/**
 * The Happy Agent API over one agent's private Tailcat socket
 * (happy-agent API.md, "The connector's socket"). Each request is
 * authenticated by its bearer credential: the pairing token, a handshake
 * id, or the device token.
 */
interface Transport {
    suspend fun request(
        method: String,
        path: String,
        credential: String,
        body: ByteArray? = null,
        headers: Map<String, String> = emptyMap(),
    ): TransportResponse

    /**
     * A GET whose answer keeps coming (Server-Sent Events): returns once the
     * head is in; the body is read piece by piece from the
     * [TransportStream]. A read that waits longer than [silenceMillis]
     * fails, and lets go of the tunnel: an agent that restarted or slept
     * never closes it.
     */
    suspend fun stream(
        path: String,
        credential: String,
        headers: Map<String, String> = emptyMap(),
        silenceMillis: Long = 40_000,
    ): TransportStream = throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)

    /** Lets go of the tunnel, so the next request makes a new one. */
    suspend fun reset() {}

    suspend fun close()
}

/**
 * [Transport] over tailcat-kotlin: one Tailcat client per
 * agent, and a fresh TCP stream to `server.tailcat:<port>` for every
 * HTTP/1.1 request (`Connection: close`), as tailcat-swift is used on iOS.
 * The address is a secret; nothing here logs it.
 */
class TailcatTransport(
    private val address: String,
    private val port: Int,
    private val connectTimeoutMillis: Long = 20_000,
    private val requestTimeoutMillis: Long = 35_000,
) : Transport {
    private val lock = Mutex()
    private var client: TailcatClient? = null
    private var closed = false

    private suspend fun connection(): TailcatClient = lock.withLock {
        if (closed) throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        client ?: runInterruptible(Dispatchers.IO) {
            try {
                TailcatClient.connect(address, ClientConfiguration(mapProvider = derpMap, connectTimeoutMillis = connectTimeoutMillis))
            } catch (e: Exception) {
                throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
            }
        }.also { client = it }
    }

    override suspend fun request(
        method: String,
        path: String,
        credential: String,
        body: ByteArray?,
        headers: Map<String, String>,
    ): TransportResponse {
        val head = TailcatHttp.requestHead(method, path, port, credential, body, headers)
        val tunnel = connection()
        return try {
            withTimeout(requestTimeoutMillis) {
                runInterruptible(Dispatchers.IO) {
                    val stream: TailcatConnection = tunnel.openTCP(port)
                    try {
                        stream.write(head, timeoutMillis = requestTimeoutMillis)
                        if (body != null) stream.write(body, timeoutMillis = requestTimeoutMillis)
                        val parser = HttpResponseParser()
                        while (true) {
                            val bytes = stream.read(65536, timeoutMillis = requestTimeoutMillis)
                            parser.append(bytes, eof = bytes.isEmpty())?.let { return@runInterruptible it }
                        }
                        @Suppress("UNREACHABLE_CODE") error("unreachable")
                    } finally {
                        stream.close()
                    }
                }
            }
        } catch (e: AgentConnectionException) {
            throw e
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            resetIfCurrent(tunnel)
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            // Nothing came back on the tunnel: the agent may have restarted and forgotten it.
            resetIfCurrent(tunnel)
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
        }
    }

    override suspend fun stream(path: String, credential: String, headers: Map<String, String>, silenceMillis: Long): TransportStream {
        val head = TailcatHttp.requestHead("GET", path, port, credential, null, headers + ("Accept" to "text/event-stream"))
        val tunnel = connection()
        val socket: TailcatConnection = try {
            withTimeout(requestTimeoutMillis) {
                runInterruptible(Dispatchers.IO) {
                    tunnel.openTCP(port).also { it.write(head, timeoutMillis = requestTimeoutMillis) }
                }
            }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            resetIfCurrent(tunnel)
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            resetIfCurrent(tunnel)
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
        }
        val reader = object : ByteSource {
            override suspend fun read(): ByteArray = try {
                runInterruptible(Dispatchers.IO) { socket.read(65536, timeoutMillis = silenceMillis) }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                resetIfCurrent(tunnel)
                throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
            }

            override fun close() {
                try {
                    socket.close()
                } catch (_: Exception) {
                    // Already gone.
                }
            }
        }
        return TransportStream.open(reader)
    }

    private suspend fun resetIfCurrent(used: TailcatClient) {
        val old = lock.withLock { client.takeIf { it === used }?.also { client = null } }
        old?.let { closeOffMain(it) }
    }

    override suspend fun reset() {
        lock.withLock { client.also { client = null } }?.let { closeOffMain(it) }
    }

    override suspend fun close() {
        lock.withLock { closed = true; client.also { client = null } }?.let { closeOffMain(it) }
    }

    /** Closing a client tells the relay, which is network I/O: never on the caller's (maybe main) thread. */
    private suspend fun closeOffMain(client: TailcatClient) = withContext(NonCancellable + Dispatchers.IO) {
        try {
            client.close()
        } catch (_: Exception) {
            // Already gone.
        }
    }

    companion object {
        /**
         * One provider for the app (tailcat-kotlin's default map,
         * tailcat.dev), so its hour-long cache is shared by every agent.
         * [persistDerpMap] keeps it on disk, so connecting works offline
         * after the first fetch.
         */
        @Volatile private var derpMap = DERPMapProvider()

        fun persistDerpMap(file: File) {
            derpMap = DERPMapProvider(cache = FileDerpMapCache(file))
        }
    }
}

/**
 * The DERP map as last fetched, kept in [file]. Not a secret: the public
 * relay list. A file that can't be read counts as none.
 */
class FileDerpMapCache(private val file: File) : DERPMapCache {
    @Serializable private class Entry(val json: String, val etag: String, val fetchedAtMillis: Long)

    @Synchronized
    override fun load(): DERPMapCacheEntry? = try {
        Json.decodeFromString(Entry.serializer(), file.readText()).let { DERPMapCacheEntry(it.json, it.etag, it.fetchedAtMillis) }
    } catch (_: Exception) {
        null
    }

    @Synchronized
    override fun store(entry: DERPMapCacheEntry) {
        try {
            file.parentFile?.mkdirs()
            val temp = File(file.path + ".tmp")
            temp.writeText(Json.encodeToString(Entry.serializer(), Entry(entry.json, entry.etag, entry.fetchedAtMillis)))
            if (!temp.renameTo(file)) temp.delete()
        } catch (_: Exception) {
            // The memory of this fetch is lost; the next connect fetches again.
        }
    }
}

/** HTTP/1.1 framing shared by every transport. */
object TailcatHttp {
    private val methods = setOf("GET", "POST", "PATCH", "PUT", "DELETE")

    /** The request line and headers; refuses anything that could split them. */
    fun requestHead(method: String, path: String, port: Int, credential: String, body: ByteArray?, headers: Map<String, String>): ByteArray {
        fun unsafe(text: String) = text.contains('\r') || text.contains('\n')
        if (method !in methods || !path.startsWith("/") || path.contains(' ') || unsafe(path) || unsafe(credential) ||
            headers.any { (name, value) -> unsafe(name) || name.contains(':') || unsafe(value) }
        ) throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        val head = StringBuilder()
            .append("$method $path HTTP/1.1\r\n")
            .append("Host: server.tailcat:$port\r\n")
            .append("Authorization: Bearer $credential\r\n")
            .append("Connection: close\r\n")
        if (headers.keys.none { it.equals("Accept", ignoreCase = true) }) head.append("Accept: application/json\r\n")
        head.append("Content-Length: ${body?.size ?: 0}\r\n")
        if (body != null && headers.keys.none { it.equals("Content-Type", ignoreCase = true) }) head.append("Content-Type: application/json\r\n")
        headers.forEach { (name, value) -> head.append("$name: $value\r\n") }
        return head.append("\r\n").toString().toByteArray(Charsets.UTF_8)
    }
}

/**
 * Incremental HTTP/1.1 response decoding with strict framing and bounded
 * sizes: any TCP boundaries; length, chunked and close-delimited bodies.
 */
class HttpResponseParser(private val limit: Int = 8 * 1024 * 1024) {
    private var data = ByteArray(0)

    private fun invalid(): Nothing = throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)

    /** The response once complete, else null; [eof] says the stream ended. */
    fun append(bytes: ByteArray, eof: Boolean): TransportResponse? {
        if (data.size + bytes.size > limit + 65536) invalid()
        data += bytes
        val divider = indexOf(data, CRLFCRLF, 0)
        if (divider < 0) {
            if (data.size > 32768 || eof) invalid()
            return null
        }
        if (divider > 32768) invalid()
        val lines = String(data, 0, divider, Charsets.UTF_8).split("\r\n")
        val statusParts = lines.first().split(' ')
        if (statusParts.size < 2 || statusParts[0] !in setOf("HTTP/1.1", "HTTP/1.0")) invalid()
        val status = statusParts[1].toIntOrNull()?.takeIf { it in 200..599 } ?: invalid()
        val headers = mutableMapOf<String, String>()
        for (line in lines.drop(1)) {
            val colon = line.indexOf(':').takeIf { it > 0 } ?: invalid()
            val name = line.substring(0, colon).lowercase()
            if (name in headers) invalid()
            headers[name] = line.substring(colon + 1).trim()
        }
        val body = data.copyOfRange(divider + 4, data.size)
        if (status == 204 || status == 304) return TransportResponse(status, headers)
        headers["transfer-encoding"]?.let { transfer ->
            if (!transfer.equals("chunked", ignoreCase = true) || "content-length" in headers) invalid()
            return chunked(status, headers, body, eof)
        }
        headers["content-length"]?.let { length ->
            val count = length.toIntOrNull()?.takeIf { it in 0..limit } ?: invalid()
            if (body.size >= count) return TransportResponse(status, headers, body.copyOf(count))
            if (eof) invalid()
            return null
        }
        if (body.size > limit) invalid()
        return if (eof) TransportResponse(status, headers, body) else null
    }

    private fun chunked(status: Int, headers: Map<String, String>, body: ByteArray, eof: Boolean): TransportResponse? {
        var cursor = 0
        val decoded = java.io.ByteArrayOutputStream()
        var chunks = 0
        while (true) {
            val lineEnd = indexOf(body, CRLF, cursor)
            if (lineEnd < 0) {
                if (body.size - cursor >= 8192 || eof) invalid()
                return null
            }
            if (lineEnd - cursor >= 8192) invalid()
            val sizeText = String(body, cursor, lineEnd - cursor, Charsets.UTF_8).substringBefore(';').trim()
            val count = sizeText.toIntOrNull(16)?.takeIf { it >= 0 && it <= limit - decoded.size() } ?: invalid()
            cursor = lineEnd + 2
            if (++chunks > 65536) invalid()
            if (count == 0) {
                if (body.size >= cursor + 2 && body[cursor] == '\r'.code.toByte() && body[cursor + 1] == '\n'.code.toByte()) {
                    return TransportResponse(status, headers, decoded.toByteArray())
                }
                val end = indexOf(body, CRLFCRLF, cursor)
                if (end >= 0 && end + 4 - cursor <= 32768) return TransportResponse(status, headers, decoded.toByteArray())
                if (body.size - cursor > 32768 || eof) invalid()
                return null
            }
            if (body.size < cursor + count + 2) {
                if (eof) invalid()
                return null
            }
            if (body[cursor + count] != '\r'.code.toByte() || body[cursor + count + 1] != '\n'.code.toByte()) invalid()
            decoded.write(body, cursor, count)
            cursor += count + 2
        }
    }

    private companion object {
        val CRLF = "\r\n".toByteArray()
        val CRLFCRLF = "\r\n\r\n".toByteArray()

        fun indexOf(data: ByteArray, needle: ByteArray, from: Int): Int {
            outer@ for (i in from..data.size - needle.size) {
                for (j in needle.indices) if (data[i + j] != needle[j]) continue@outer
                return i
            }
            return -1
        }
    }
}
