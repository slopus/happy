package com.slopus.happy.connection

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/** Raw bytes as they arrive on one TCP stream; an empty read is the end. */
interface ByteSource {
    suspend fun read(): ByteArray
    fun close()
}

/**
 * An HTTP/1.1 answer read as it comes (happy-agent's `/v0/events/stream`):
 * the status and headers, then the body piece by piece, de-chunked when it
 * is chunked. Framing is as strict as [HttpResponseParser]'s.
 */
class TransportStream private constructor(
    val status: Int,
    /** Lower-case names. */
    val headers: Map<String, String>,
    private val source: ByteSource,
    leftover: ByteArray,
) {
    private val chunked = headers["transfer-encoding"]?.equals("chunked", ignoreCase = true) == true
    private val decoder = if (chunked) ChunkedDecoder() else null
    private var pending = leftover
    private var ended = false

    /** The body's next bytes, or null once it has ended. */
    suspend fun read(): ByteArray? {
        while (true) {
            if (ended) return null
            val input = if (pending.isNotEmpty()) pending.also { pending = ByteArray(0) } else source.read()
            if (input.isEmpty()) {
                ended = true
                if (decoder != null && !decoder.finished) throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
                return null
            }
            if (decoder == null) return input
            val out = decoder.append(input)
            if (decoder.finished) ended = true
            if (out.isNotEmpty()) return out
        }
    }

    /** The whole (short) body, for an answer that isn't a stream. */
    suspend fun readAll(limit: Int = 65536): ByteArray {
        val out = ByteArrayOutputStream()
        while (true) {
            val bytes = read() ?: return out.toByteArray()
            if (out.size() + bytes.size > limit) throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
            out.write(bytes)
        }
    }

    /** Ends the request; the tunnel stays. Off the caller's thread: it tells the peer. */
    suspend fun close() = withContext(NonCancellable + Dispatchers.IO) { source.close() }

    companion object {
        /** Reads up to the end of the head. */
        suspend fun open(source: ByteSource): TransportStream {
            var data = ByteArray(0)
            try {
                while (true) {
                    val bytes = source.read()
                    data += bytes
                    val divider = indexOf(data, "\r\n\r\n".toByteArray())
                    if (divider >= 0) {
                        if (divider > 32768) invalid()
                        val (status, headers) = parseHead(String(data, 0, divider, Charsets.UTF_8))
                        return TransportStream(status, headers, source, data.copyOfRange(divider + 4, data.size))
                    }
                    if (bytes.isEmpty() || data.size > 32768) invalid()
                }
            } catch (e: Throwable) {
                withContext(NonCancellable + Dispatchers.IO) { source.close() }
                throw e
            }
        }

        private fun invalid(): Nothing = throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)

        private fun parseHead(text: String): Pair<Int, Map<String, String>> {
            val lines = text.split("\r\n")
            val parts = lines.first().split(' ')
            if (parts.size < 2 || parts[0] !in setOf("HTTP/1.1", "HTTP/1.0")) invalid()
            val status = parts[1].toIntOrNull()?.takeIf { it in 200..599 } ?: invalid()
            val headers = mutableMapOf<String, String>()
            for (line in lines.drop(1)) {
                val colon = line.indexOf(':').takeIf { it > 0 } ?: invalid()
                val name = line.substring(0, colon).lowercase()
                if (name in headers) invalid()
                headers[name] = line.substring(colon + 1).trim()
            }
            headers["transfer-encoding"]?.let { if (!it.equals("chunked", ignoreCase = true) || "content-length" in headers) invalid() }
            return status to headers
        }

        internal fun indexOf(data: ByteArray, needle: ByteArray, from: Int = 0): Int {
            outer@ for (i in from..data.size - needle.size) {
                for (j in needle.indices) if (data[i + j] != needle[j]) continue@outer
                return i
            }
            return -1
        }
    }
}

/** Incremental `Transfer-Encoding: chunked` decoding over any TCP boundaries. */
internal class ChunkedDecoder {
    private var buffer = ByteArray(0)
    /** Bytes left in the chunk being read, then its CRLF; -1 between chunks. */
    private var remaining = -1
    var finished = false
        private set

    fun append(bytes: ByteArray): ByteArray {
        buffer += bytes
        val out = ByteArrayOutputStream()
        while (!finished) {
            if (remaining < 0) {
                val end = TransportStream.indexOf(buffer, CRLF)
                if (end < 0) {
                    if (buffer.size >= 8192) invalid()
                    break
                }
                val size = String(buffer, 0, end, Charsets.UTF_8).substringBefore(';').trim().toIntOrNull(16)?.takeIf { it >= 0 } ?: invalid()
                buffer = buffer.copyOfRange(end + 2, buffer.size)
                if (size == 0) {
                    // Trailers, if any, aren't read: nothing follows on a closing connection.
                    finished = true
                    break
                }
                remaining = size
            } else {
                if (buffer.size < remaining + 2) {
                    // Hand out what there is; keep the CRLF check for when it comes.
                    if (buffer.size > 0 && remaining > 0) {
                        val take = minOf(remaining, buffer.size)
                        out.write(buffer, 0, take)
                        buffer = buffer.copyOfRange(take, buffer.size)
                        remaining -= take
                    }
                    if (buffer.size < remaining + 2) break
                }
                out.write(buffer, 0, remaining)
                if (buffer[remaining] != '\r'.code.toByte() || buffer[remaining + 1] != '\n'.code.toByte()) invalid()
                buffer = buffer.copyOfRange(remaining + 2, buffer.size)
                remaining = -1
            }
        }
        return out.toByteArray()
    }

    private fun invalid(): Nothing = throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)

    private companion object {
        val CRLF = "\r\n".toByteArray()
    }
}
