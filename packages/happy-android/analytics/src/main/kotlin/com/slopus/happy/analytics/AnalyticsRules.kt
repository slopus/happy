package com.slopus.happy.analytics

import com.slopus.happy.analytics.AnalyticsEvent.AgentConnectionLost

/**
 * `error_shown`'s throttle: one event per (area, code) every [windowMillis];
 * what happens again inside the window is dropped, not counted. In memory
 * only.
 */
internal class ErrorThrottle(private val windowMillis: Long = WINDOW_MILLIS) {
    private val sentAt = HashMap<Pair<ErrorArea, ErrorCode>, Long>()

    /** Whether an occurrence at [now] goes. */
    fun occur(area: ErrorArea, code: ErrorCode, now: Long): Boolean {
        val key = area to code
        val last = sentAt[key]
        if (last != null && now - last < windowMillis) return false
        sentAt[key] = now
        return true
    }

    companion object {
        const val WINDOW_MILLIS = 10 * 60_000L

        /** How close together two of one area's errors are one failure ([AnalyticsClient.errorShown]). */
        const val BURST_MILLIS = 10_000L
    }
}

/**
 * `chat_failure_shown`'s rule: a failure counts the first time its card is
 * seen, and only while it is at most [FRESH_MILLIS] old, so opening an old
 * conversation counts nothing. [seen] remembers the last [MAX_SEEN] message
 * ids, oldest out first, in memory only; the ids never leave the phone.
 */
internal class FailureExposures {
    private val ids = LinkedHashSet<String>()

    val seen: List<String> get() = ids.toList()

    /** True when the card of message [messageId], written at [createdAt], counts now. */
    fun shown(messageId: String, createdAt: Long, now: Long): Boolean {
        if (createdAt <= 0 || now - createdAt > FRESH_MILLIS || messageId in ids) return false
        ids += messageId
        while (ids.size > MAX_SEEN) ids.remove(ids.first())
        return true
    }

    companion object {
        const val FRESH_MILLIS = 5 * 60_000L
        const val MAX_SEEN = 500
    }
}

/**
 * `agent_connection_lost`: one event per incident, sent when it ends, and only
 * when the link was down [MIN_MILLIS] or more while the app was in front.
 * An incident ends when the link is back (recovered), the app goes behind
 * (backgrounded), or another account opens or none (gave up). Time without
 * any network isn't the agent's: an incident that meets it is dropped.
 */
class ConnectionIncidents(private val record: (AgentConnectionLost) -> Unit) {
    /** The open account's link: [down] null while it talks to its agent. [key] tells accounts apart. */
    data class Link(val key: String, val transport: LinkTransport, val down: ConnectionCode?)

    private class Incident(val key: String, val transport: LinkTransport, var code: ConnectionCode, val since: Long)

    private var incident: Incident? = null

    fun update(link: Link?, foreground: Boolean, network: Boolean, now: Long) {
        val open = incident
        if (open != null) {
            when {
                link == null || link.key != open.key -> end(ConnectionOutcome.GaveUp, now)
                !foreground -> end(ConnectionOutcome.Backgrounded, now)
                !network -> incident = null
                link.down == null -> end(ConnectionOutcome.Recovered, now)
                // The most telling reason seen wins over "unreachable".
                link.down != ConnectionCode.Unreachable -> open.code = link.down
            }
        }
        val down = link?.down
        if (incident == null && link != null && down != null && foreground && network) {
            incident = Incident(link.key, link.transport, down, now)
        }
    }

    private fun end(outcome: ConnectionOutcome, now: Long) {
        val open = incident ?: return
        incident = null
        val down = now - open.since
        if (down >= MIN_MILLIS) record(AgentConnectionLost(open.transport, open.code, outcome, DurationBucket.of(down)))
    }

    companion object {
        const val MIN_MILLIS = 10_000L
    }
}

/**
 * `app_opened`'s rule on a phone: a cold start, or coming back to the
 * front after [AWAY_MILLIS] or more behind.
 */
internal class AppOpens {
    private var started = false
    private var behindSince: Long? = null

    /** The app came to the front at [now]; the event's `is_cold_start`, or null when it doesn't count. */
    fun foreground(now: Long): Boolean? {
        if (!started) {
            started = true
            return true
        }
        val since = behindSince ?: return null
        behindSince = null
        return if (now - since >= AWAY_MILLIS) false else null
    }

    fun background(now: Long) {
        if (started) behindSince = now
    }

    /** This launch began with analytics off: it has no cold start to tell later. */
    fun skip() {
        started = true
    }

    /** Analytics went off: the time behind until now isn't counted toward a later open. */
    fun pause() {
        behindSince = null
    }

    companion object {
        const val AWAY_MILLIS = 30 * 60_000L
    }
}
