package com.slopus.happy.connection

import io.tailcat.ClientConfiguration
import io.tailcat.DERPMapCache
import io.tailcat.DERPMapCacheEntry
import io.tailcat.DERPMapProvider
import io.tailcat.NodePrivateKey
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import io.tailcat.TailcatClient
import io.tailcat.TailcatConnection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withTimeout

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
    /** Current app-owned flows and public path data, without connecting or making requests. */
    suspend fun diagnostics(): TransportDiagnostics? = null

    /**
     * One request as [category]: over that category's client, with its
     * deadline. A transport with one way to the agent ignores it.
     */
    suspend fun request(
        method: String,
        path: String,
        credential: String,
        body: ByteArray? = null,
        headers: Map<String, String> = emptyMap(),
        category: RequestCategory = RequestCategory.Query,
    ): TransportResponse

    /**
     * A GET whose answer keeps coming (Server-Sent Events), over the
     * [RequestCategory.Realtime] client: returns once the head is in; the
     * body is read piece by piece from the [TransportStream]. A read that
     * waits longer than [silenceMillis] fails, and lets go of that client:
     * an agent that restarted or slept never closes it.
     */
    suspend fun stream(
        path: String,
        credential: String,
        headers: Map<String, String> = emptyMap(),
        silenceMillis: Long = 40_000,
    ): TransportStream = throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)

    /**
     * A raw TCP stream to the agent's socket, nothing written on it yet:
     * what the in-app browser speaks HTTP and CONNECT over (iOS's
     * `browserConnection`), over a [RequestCategory.File] client.
     * Unavailable where the transport has none.
     */
    suspend fun socket(): TransportSocket = throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)

    /**
     * A tunnel over a WebSocket (edge SSO contract §4): `GET [path]`
     * upgraded with [credential], carrying what the route's `CONNECT` twin
     * would after its `200`. Null where the transport has no WebSockets
     * (Tailcat, which carries CONNECT). A refusal throws [UpgradeRefused].
     */
    suspend fun webSocketTunnel(path: String, credential: String): TransportSocket? = null

    /**
     * The agent is reached over public HTTPS, maybe through a load balancer
     * that refuses CONNECT; over Tailcat CONNECT always works.
     */
    suspend fun overHttps(): Boolean = false

    /** Lets go of [category]'s clients, so its next request makes new ones; the other categories' stay. */
    suspend fun reset(category: RequestCategory) {}

    /** [reset] of every category. */
    suspend fun reset() {
        RequestCategory.entries.forEach { reset(it) }
    }

    /**
     * Back from the background (iOS's `resumed`): every way to the agent
     * is checked at once, the relay and every direct path, and only what
     * doesn't answer is replaced; tunnels, requests under way and sessions stay.
     */
    suspend fun resumed() {}

    /** The phone's network changed: the same check, since a change needn't have broken anything. */
    suspend fun networkChanged() {}

    suspend fun close()
}

/** Backpressured bytes: each read and write finishes before the next is issued. */
interface TransportSocket {
    val authority: String get() = "server.tailcat"
    /** Up to [maximumBytes]; empty once the other side has finished. */
    suspend fun read(maximumBytes: Int = 65536): ByteArray
    suspend fun write(bytes: ByteArray)
    /** Ends the stream both ways; safe to call more than once, from any thread. */
    fun close()
}

/**
 * [Transport] over tailcat-kotlin: the agent's [TailcatClients] (one
 * client for the event stream, one for queries, up to eight for files and
 * the browser), and a fresh TCP stream to `server.tailcat:<port>` for every
 * HTTP/1.1 request (`Connection: close`), as tailcat-swift is used on iOS.
 * A query must be answered within [requestTimeoutMillis]; a file has
 * [fileTimeoutMillis] in all, though any one read or write still fails
 * after [requestTimeoutMillis] of silence. The address is a secret;
 * nothing here logs it.
 */
class TailcatTransport internal constructor(
    private val port: Int,
    private val requestTimeoutMillis: Long,
    private val fileTimeoutMillis: Long,
    connect: (RequestCategory, NodePrivateKey) -> TailcatClient,
) : Transport {
    constructor(
        address: String,
        port: Int,
        connectTimeoutMillis: Long = 20_000,
        requestTimeoutMillis: Long = 35_000,
        fileTimeoutMillis: Long = 15 * 60_000,
    ) : this(port, requestTimeoutMillis, fileTimeoutMillis, { _, key ->
        TailcatClient.connect(address, tailcatConfiguration(key, connectTimeoutMillis))
    })

    private val flows = OpenFlows()
    private val owners = java.util.concurrent.ConcurrentHashMap<TailcatClient, OpenFlows.Owner>()
    private val clients = TailcatClients(
        connect = { category, key ->
            val client = connect(category, key)
            try {
                owners[client] = flows.owner()
                client
            } catch (error: Throwable) {
                client.close()
                throw error
            }
        },
        disconnect = { client ->
            owners.remove(client)?.close()
            client.close()
        },
        // The relay pinged and replaced only if silent; direct paths probed.
        check = { it.wake() },
    )

    private class OpenFlow(private val stream: TailcatConnection, private val ownership: OpenFlows.Owner.Flow) {
        fun read(maximumBytes: Int) = stream.read(maximumBytes)
        fun read(maximumBytes: Int, timeoutMillis: Long) = stream.read(maximumBytes, timeoutMillis = timeoutMillis)
        fun write(bytes: ByteArray) = stream.write(bytes)
        fun write(bytes: ByteArray, timeoutMillis: Long) = stream.write(bytes, timeoutMillis = timeoutMillis)
        fun close() = ownership.close()

        /** Lets go of an answer no longer wanted: the flow is reset, so the computer stops sending. [close] would take the rest in and discard it. */
        fun abort() {
            try {
                stream.abort()
            } catch (_: Exception) {
                // Already gone.
            }
            ownership.close()
        }
    }

    private fun open(client: TailcatClient): OpenFlow {
        val owner = owners[client] ?: throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        val stream = client.openTCP(port)
        return OpenFlow(stream, owner.opened(stream::close))
    }

    override suspend fun diagnostics(): TransportDiagnostics {
        val tunnels = clients.connected().mapNotNull { (category, client) ->
            val owner = owners[client] ?: return@mapNotNull null
            val path = when (client.path) {
                is io.tailcat.ConnectionPath.Direct -> TransportDiagnostics.Path.Direct
                io.tailcat.ConnectionPath.Relay -> TransportDiagnostics.Path.Relayed
            }
            val address = client.serverAddress
            val relay = address.regions.firstOrNull { it.regionID == address.regionID }?.nodes
                ?.firstOrNull { !it.stunOnly }?.hostName
                ?.takeIf { it.length <= 253 && it.all { char -> char.isLetterOrDigit() || char in ".-:" } }
            TransportDiagnostics.Tunnel(category, path, relay, owner.count)
        }
        return TransportDiagnostics(TransportDiagnostics.Kind.Tailcat, tunnels.sumOf { it.openFlows }, tunnels)
    }

    override suspend fun request(
        method: String,
        path: String,
        credential: String,
        body: ByteArray?,
        headers: Map<String, String>,
        category: RequestCategory,
    ): TransportResponse {
        val head = TailcatHttp.requestHead(method, path, port, credential, body, headers)
        val progress = kotlinx.coroutines.currentCoroutineContext()[BodyProgress]
        val lease = clients.lease(category)
        val deadline = if (category == RequestCategory.File) fileTimeoutMillis else requestTimeoutMillis
        // In a dead relay even the flow's opening and the head's write hang.
        val watch = lease.watch()
        return try {
            withTimeout(deadline) {
                runInterruptible(Dispatchers.IO) {
                    val stream = open(lease.client)
                    var answered = false
                    try {
                        stream.write(head, timeoutMillis = requestTimeoutMillis)
                        if (body != null) {
                            if (progress == null) stream.write(body, timeoutMillis = requestTimeoutMillis)
                            else progress.write(body) { stream.write(it, timeoutMillis = requestTimeoutMillis) }
                        }
                        val parser = HttpResponseParser()
                        while (true) {
                            val bytes = stream.read(65536, timeoutMillis = requestTimeoutMillis)
                            if (bytes.isNotEmpty()) lease.heard()
                            parser.append(bytes, eof = bytes.isEmpty())?.let { answered = true; return@runInterruptible it }
                        }
                        @Suppress("UNREACHABLE_CODE") error("unreachable")
                    } finally {
                        // Cut off or given up on: the computer stops sending the rest.
                        if (answered) stream.close() else stream.abort()
                    }
                }
            }
        } catch (e: AgentConnectionException) {
            throw e
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            failed(lease, e)
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            // Nothing came back on the tunnel: the agent may have restarted and forgotten it.
            failed(lease, e)
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
        } finally {
            watch.cancel()
            lease.release()
        }
    }

    override suspend fun stream(path: String, credential: String, headers: Map<String, String>, silenceMillis: Long): TransportStream {
        val head = TailcatHttp.requestHead("GET", path, port, credential, null, headers + ("Accept" to "text/event-stream"))
        val lease = clients.lease(RequestCategory.Realtime)
        val opening = java.util.concurrent.atomic.AtomicReference<OpenFlow?>()
        // Until the head is in; then silent past its heartbeat, its client is checked.
        val watch = lease.watch()
        val silence = lease.watch(TailcatClients.STREAM_QUIET_MILLIS, repeating = true)
        val socket: OpenFlow = try {
            withTimeout(requestTimeoutMillis) {
                runInterruptible(Dispatchers.IO) {
                    val opened = open(lease.client)
                    opening.set(opened)
                    try {
                        opened.write(head, timeoutMillis = requestTimeoutMillis)
                        opened
                    } catch (error: Throwable) {
                        opened.abort()
                        throw error
                    }
                }
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            opening.getAndSet(null)?.abort()
            watch.cancel(); silence.cancel()
            lease.release()
            if (e !is kotlinx.coroutines.TimeoutCancellationException) throw e
            failed(lease, e)
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
        } catch (e: Exception) {
            opening.getAndSet(null)?.abort()
            watch.cancel(); silence.cancel()
            lease.release()
            failed(lease, e)
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
        }
        val reader = object : ByteSource {
            @Volatile private var ended = false

            override suspend fun read(): ByteArray = try {
                runInterruptible(Dispatchers.IO) { socket.read(65536, timeoutMillis = silenceMillis) }
                    .also { if (it.isEmpty()) { ended = true; close() } else lease.heard() }
            } catch (e: kotlinx.coroutines.CancellationException) {
                close()
                throw e
            } catch (e: Exception) {
                close()
                failed(lease, e)
                throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
            }

            override fun close() {
                watch.cancel(); silence.cancel()
                lease.release()
                // Let go of before its end: the computer stops sending.
                if (ended) socket.close() else socket.abort()
            }
        }
        return TransportStream.open(reader).also { watch.cancel() }
    }

    override suspend fun socket(): TransportSocket {
        val lease = clients.lease(RequestCategory.File)
        val opening = java.util.concurrent.atomic.AtomicReference<OpenFlow?>()
        val stream: OpenFlow = try {
            withTimeout(requestTimeoutMillis) { runInterruptible(Dispatchers.IO) { open(lease.client).also { opening.set(it) } } }
        } catch (e: kotlinx.coroutines.CancellationException) {
            opening.getAndSet(null)?.close()
            lease.release()
            if (e !is kotlinx.coroutines.TimeoutCancellationException) throw e
            failed(lease, e)
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
        } catch (e: Exception) {
            opening.getAndSet(null)?.close()
            lease.release()
            failed(lease, e)
            throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
        }
        return object : TransportSocket {
            // A cancelled read or write closes the stream, which wakes the blocked call.
            override suspend fun read(maximumBytes: Int): ByteArray = io { stream.read(maximumBytes) }.also { if (it.isEmpty()) close() else lease.heard() }

            override suspend fun write(bytes: ByteArray) {
                io { stream.write(bytes) }
            }

            private suspend fun <T> io(block: () -> T): T = try {
                runInterruptible(Dispatchers.IO) { block() }
            } catch (e: kotlinx.coroutines.CancellationException) {
                close()
                throw e
            } catch (e: Exception) {
                close()
                throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
            }

            override fun close() {
                lease.release()
                try {
                    stream.close()
                } catch (_: Exception) {
                    // Already gone.
                }
            }
        }
    }

    /**
     * After [failure] on [lease]'s client, lets go of that client alone. A
     * stack out of connections is busy, not gone: it is kept, and so is
     * every other request on it.
     */
    private suspend fun failed(lease: TailcatClients<TailcatClient>.Lease, failure: Exception) {
        val reason = (failure as? io.tailcat.stack.TailcatTransportException)?.reason
        if (reason != io.tailcat.stack.TailcatTransportException.Reason.RESOURCE_LIMIT) clients.reset(lease)
    }

    override suspend fun reset(category: RequestCategory) = clients.reset(category)

    /**
     * A client kept through the background (its process frozen) may or may
     * not still work: its relay connection, its direct paths, its WireGuard
     * session. Each is woken: the relay is pinged and replaced only if it
     * doesn't answer within two seconds, every direct path is probed and one
     * that stopped answering dropped, and an expired session rekeys.
     */
    override suspend fun resumed() = each { it.wake() }

    /**
     * tailcat-kotlin hears of no network change on its own (tailcat-swift
     * watches the path itself). The same check as [resumed].
     */
    override suspend fun networkChanged() = each { it.notifyNetworkChanged() }

    private suspend fun each(check: (TailcatClient) -> Unit) = kotlinx.coroutines.withContext(Dispatchers.IO) {
        clients.connected().forEach { (_, client) ->
            try {
                check(client)
            } catch (_: Exception) {
                // Closed meanwhile: its next request connects again.
            }
        }
    }

    override suspend fun close() = kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable + Dispatchers.IO) {
        flows.close()
        clients.close()
    }

    companion object {
        internal fun tailcatConfiguration(key: NodePrivateKey, connectTimeoutMillis: Long): ClientConfiguration =
            // Serve the first request over DERP while this client's direct path is probed.
            ClientConfiguration(privateKey = key, mapProvider = derpMap, connectTimeoutMillis = connectTimeoutMillis, relayFirst = true)

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

    /**
     * The Happy Agent protocol this build reads, said on every request and
     * stream. From 35 a daemon sends chat UI as it is, with the records of
     * its actions; below it, each document's fallback text and no records.
     */
    const val PROTOCOL = 35
    const val PROTOCOL_HEADER = "Happy-Protocol"

    /** The request line and headers; refuses anything that could split them. */
    fun requestHead(method: String, path: String, port: Int, credential: String, body: ByteArray?, headers: Map<String, String>, authority: String = "server.tailcat:$port"): ByteArray {
        fun unsafe(text: String) = text.contains('\r') || text.contains('\n')
        if (method !in methods || !path.startsWith("/") || path.contains(' ') || unsafe(path) || unsafe(credential) ||
            headers.any { (name, value) -> unsafe(name) || name.contains(':') || unsafe(value) }
        ) throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        val head = StringBuilder()
            .append("$method $path HTTP/1.1\r\n")
            .append("Host: $authority\r\n")
            .append("Authorization: Bearer $credential\r\n")
            .append("Connection: close\r\n")
            .append("$PROTOCOL_HEADER: $PROTOCOL\r\n")
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
