package com.slopus.happy.connection

import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext

/**
 * Told how much of a request's body has been written (iOS: the transports'
 * chunked writes). Put in the request's coroutine context; a transport that
 * finds it writes the body [CHUNK] bytes at a time and reports after each
 * write, from the thread that wrote it. Without it the body goes in one write.
 */
class BodyProgress(val report: (body: ByteArray, sent: Int) -> Unit) : AbstractCoroutineContextElement(Key) {
    companion object Key : CoroutineContext.Key<BodyProgress> {
        const val CHUNK = 256 * 1024
    }

    /** [body] through [write], a chunk at a time, reporting each. */
    inline fun write(body: ByteArray, write: (ByteArray) -> Unit) {
        var at = 0
        while (at < body.size) {
            val end = minOf(body.size, at + CHUNK)
            write(if (at == 0 && end == body.size) body else body.copyOfRange(at, end))
            at = end
            report(body, at)
        }
    }
}
