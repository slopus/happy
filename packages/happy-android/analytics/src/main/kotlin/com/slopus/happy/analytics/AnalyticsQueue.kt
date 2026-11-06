package com.slopus.happy.analytics

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One event as it will be posted: [properties] are final (common, its own, PostHog's), [at] is its timestamp. */
internal data class QueuedEvent(val event: String, val at: Long, val properties: JsonObject) {
    val insertId: String? get() = (properties["\$insert_id"] as? JsonPrimitive)?.content
}

/**
 * Events waiting to be sent, in memory only: what a process that dies
 * first held is lost. At most [MAX_EVENTS], the oldest dropped first, none
 * older than [MAX_AGE_MILLIS]. Not thread-safe: its owner calls it from one
 * lane.
 */
internal class AnalyticsQueue(private val clock: () -> Long) {
    private var events: List<QueuedEvent> = emptyList()

    /** What may still go, oldest first. */
    fun pending(): List<QueuedEvent> {
        val cutoff = clock() - MAX_AGE_MILLIS
        events = events.filter { it.at >= cutoff }
        return events
    }

    fun add(event: QueuedEvent) {
        events = (pending() + event).takeLast(MAX_EVENTS)
    }

    /** Those sent (or refused for good) leave, by `$insert_id`. */
    fun remove(sent: Collection<QueuedEvent>) {
        val ids = sent.mapNotNull { it.insertId }.toSet()
        events = events.filter { it.insertId !in ids }
    }

    /** [old], still waiting, becomes [new]: the same `$insert_id`, what it says changed. */
    fun replace(old: QueuedEvent, new: QueuedEvent) {
        events = events.map { if (it.insertId == old.insertId) new else it }
    }

    fun clear() {
        events = emptyList()
    }

    companion object {
        const val MAX_EVENTS = 500
        const val MAX_AGE_MILLIS = 7L * 24 * 60 * 60 * 1000
    }
}
