package com.slopus.happy.connection

import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext

/**
 * Where a request's time went, for HappyTiming (diagnostics/Timing.kt). Put
 * in the request's coroutine context; a Tailcat request fills it in. Times
 * are [com.slopus.happy.diagnostics.Timing.now]; the last exchange wins
 * when a stale kept connection is retried fresh.
 */
class ResponseTiming : AbstractCoroutineContextElement(Key) {
    companion object Key : CoroutineContext.Key<ResponseTiming>

    /** The request written: from here to [firstByte] is the computer's work and one round trip. */
    @Volatile var sent = 0L
    @Volatile var firstByte = 0L
    @Volatile var lastByte = 0L
    /** Bytes read, head and body. */
    @Volatile var bytes = 0L
    /** Over a kept connection, rather than one opened for it. */
    @Volatile var reused = false
    /** `direct` or `relay` as the request went out. */
    @Volatile var path: String? = null
    /** Flows open on the transport as the request went out, its own included. */
    @Volatile var openFlows = 0

    fun describe(): String =
        "bytes=$bytes path=$path reused=$reused flows=$openFlows wait=${firstByte - sent} transfer=${lastByte - firstByte}" +
            " kbps=${if (lastByte > firstByte) bytes * 8 / (lastByte - firstByte) else -1}"
}
