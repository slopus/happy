package com.slopus.happy.connection

/** App-owned open streams. These counts exclude TCP closing states held inside Tailcat. */
internal class OpenFlows {
    private val lock = Any()
    private val owners = mutableSetOf<Owner>()
    private var closed = false

    fun owner(): Owner = synchronized(lock) {
        if (closed) throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
        Owner().also { owners += it }
    }

    inner class Owner internal constructor() {
        private val streams = mutableSetOf<Flow>()
        private var retired = false
        val count: Int get() = synchronized(lock) { streams.size }

        /** Takes ownership of an already-opened stream, including if reset raced its opening. */
        fun opened(close: () -> Unit): Flow {
            val flow = synchronized(lock) {
                if (closed || retired) null else Flow(close).also { streams += it }
            }
            if (flow == null) {
                runCatching(close)
                throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
            }
            return flow
        }

        inner class Flow internal constructor(private val closeStream: () -> Unit) {
            private var ended = false
            fun close() {
                val shouldClose = synchronized(lock) {
                    if (ended) false else {
                        ended = true
                        streams.remove(this)
                        true
                    }
                }
                if (shouldClose) runCatching(closeStream)
            }
        }

        fun close() {
            val old = synchronized(lock) {
                retired = true
                owners.remove(this)
                streams.toList()
            }
            old.forEach { it.close() }
        }
    }

    fun close() {
        val old = synchronized(lock) { closed = true; owners.toList() }
        old.forEach { it.close() }
    }
}