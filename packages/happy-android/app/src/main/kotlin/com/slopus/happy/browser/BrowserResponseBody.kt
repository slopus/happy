package com.slopus.happy.browser

/**
 * iOS's `BrowserResponseBody`: follows an answer's HTTP framing without
 * buffering or decoding its body. The exact wire bytes (chunks and trailers
 * included) still go to the page. A socket with unread answer bytes or an
 * unclear end is never pooled.
 */
internal class BrowserResponseBody(head: HttpHead, method: String) {
    private sealed interface State {
        class Length(val remaining: Long) : State
        object Size : State
        class Chunk(val remaining: Long) : State
        object Cr : State
        object Lf : State
        object Trailer : State
        object Done : State
        object Eof : State
    }

    private var state: State
    private val line = java.io.ByteArrayOutputStream()
    private var trailerBytes = 0
    /** An HTTP/1.1 answer that keeps its connection and says where it ends. */
    val permitsReuse: Boolean

    init {
        val status = head.line.split(' ')
        val code = status.getOrNull(1)?.toIntOrNull()
        if (status.size < 2 || status[0] !in setOf("HTTP/1.0", "HTTP/1.1") || code == null || code !in 200..599) malformed()
        val lengths = head.fields.filter { it.first.equals("content-length", true) }
        val transfers = head.fields.filter { it.first.equals("transfer-encoding", true) }
        if (lengths.size > 1 || transfers.size > 1 || (lengths.isNotEmpty() && transfers.isNotEmpty())) malformed()
        val close = head.fields.filter { it.first.equals("connection", true) }
            .flatMap { field -> field.second.lowercase().split(',').map { it.trim() } }.contains("close")
        val bodiless = method == "HEAD" || code == 204 || code == 304
        permitsReuse = status[0] == "HTTP/1.1" && !close && head.value("upgrade") == null &&
            (bodiless || lengths.isNotEmpty() || transfers.isNotEmpty())
        state = when {
            bodiless -> State.Done
            transfers.isNotEmpty() -> if (transfers[0].second.equals("chunked", true)) State.Size else malformed()
            lengths.isNotEmpty() -> {
                val text = lengths[0].second
                val count = text.takeIf { it.isNotEmpty() && it.all(Char::isDigit) }?.toLongOrNull() ?: malformed()
                if (count == 0L) State.Done else State.Length(count)
            }
            else -> State.Eof
        }
    }

    val finished: Boolean get() = state === State.Done

    /** Finished, and the connection may carry another request. */
    val reusable: Boolean get() = finished && permitsReuse

    /** The next bytes off the wire; past the end of the answer is malformed. */
    fun append(bytes: ByteArray) {
        var index = 0
        while (index < bytes.size) {
            when (val current = state) {
                State.Done -> malformed()
                State.Eof -> return
                is State.Length -> {
                    val count = minOf(current.remaining, (bytes.size - index).toLong())
                    index += count.toInt()
                    state = if (count == current.remaining) State.Done else State.Length(current.remaining - count)
                }
                is State.Chunk -> {
                    val count = minOf(current.remaining, (bytes.size - index).toLong())
                    index += count.toInt()
                    state = if (count == current.remaining) State.Cr else State.Chunk(current.remaining - count)
                }
                State.Cr -> {
                    if (bytes[index] != CR) malformed()
                    state = State.Lf
                    index++
                }
                State.Lf -> {
                    if (bytes[index] != LF) malformed()
                    state = State.Size
                    index++
                }
                State.Size, State.Trailer -> {
                    line.write(bytes[index].toInt())
                    index++
                    if (line.size() > 8192) throw BrowserException(BrowserException.Kind.TooLarge)
                    if (current === State.Trailer && ++trailerBytes > 32768) throw BrowserException(BrowserException.Kind.TooLarge)
                    val text = line.toByteArray()
                    if (text.size < 2 || text[text.size - 2] != CR || text[text.size - 1] != LF) continue
                    if (current === State.Trailer) {
                        if (text.size == 2) state = State.Done
                        // Checked with the head's strict field rules, never altered.
                        else HttpHead.parse("HTTP/1.1 200 OK\r\n".toByteArray() + text + byteArrayOf(CR, LF))
                    } else {
                        val token = String(text, 0, text.size - 2, Charsets.ISO_8859_1).substringBefore(';')
                        if (token.isEmpty() || !token.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) malformed()
                        val count = token.toLongOrNull(16) ?: malformed()
                        state = if (count == 0L) State.Trailer else State.Chunk(count)
                    }
                    line.reset()
                }
            }
        }
    }

    /** The upstream closed: the end of a close-delimited answer, else a truncated one. */
    fun end() {
        if (state === State.Eof) {
            state = State.Done
            return
        }
        if (!finished) malformed()
    }

    private fun malformed(): Nothing = throw BrowserException(BrowserException.Kind.Malformed)

    private companion object {
        const val CR = '\r'.code.toByte()
        const val LF = '\n'.code.toByte()
    }
}
