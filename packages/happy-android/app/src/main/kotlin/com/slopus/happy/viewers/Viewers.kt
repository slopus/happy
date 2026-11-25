package com.slopus.happy.viewers

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.decode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.onTimeout
import kotlinx.coroutines.selects.select
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** What a person can be viewing (API.md, "Viewers"): a conversation or a Surface. */
@Serializable
enum class ViewerKind { @SerialName("agent") Agent, @SerialName("surface") Surface }

@Immutable
@Serializable
data class ViewerTarget(val type: ViewerKind, val id: String) {
    companion object {
        fun agent(id: String) = ViewerTarget(ViewerKind.Agent, id)
        fun surface(id: String) = ViewerTarget(ViewerKind.Surface, id)
    }
}

/** Another person on a target: [here] while one of their streams views it, [lastSeenAt] (epoch ms) when they last were. */
@Immutable
@Serializable
data class Viewer(val userId: String, val here: Boolean, val lastSeenAt: Long)

/** How present a [Viewer] is: on it now, on it within [RECENT_MILLIS], or ever. */
enum class ViewerTier {
    Here, Recent, Seen;

    companion object {
        const val RECENT_MILLIS = 10 * 60_000L
        private const val MINUTE = 60_000L

        fun of(viewer: Viewer, now: Long): ViewerTier = when {
            viewer.here -> Here
            now - viewer.lastSeenAt <= RECENT_MILLIS -> Recent
            else -> Seen
        }

        /** The whole minutes a Recent viewer has been gone, the badge's number: at least 1. */
        fun minutesAway(viewer: Viewer, now: Long): Int = ((now - viewer.lastSeenAt) / MINUTE).toInt().coerceAtLeast(1)

        /**
         * When the next Recent badge changes its minute or turns Seen, so the
         * header redraws then and not on a fixed tick; null while none will.
         */
        fun nextChange(viewers: List<Viewer>, now: Long): Long? = viewers.mapNotNull { viewer ->
            if (of(viewer, now) != Recent) return@mapNotNull null
            val nextMinute = viewer.lastSeenAt + ((now - viewer.lastSeenAt) / MINUTE + 1) * MINUTE
            val expires = viewer.lastSeenAt + RECENT_MILLIS + 1
            minOf(nextMinute.takeIf { it <= viewer.lastSeenAt + RECENT_MILLIS } ?: expires, expires)
        }.minOrNull()
    }
}

/** The heartbeat route, apart so tests and the debug fixtures can answer it. */
fun interface ViewersBackend {
    /** `PUT /v0/viewers/streams/:streamId`: each target's viewers; null when the computer doesn't serve viewers (404). */
    suspend fun put(streamId: String, targets: List<ViewerTarget>): Map<ViewerTarget, List<Viewer>>?
}

@Serializable private class ViewersBody(val targets: List<ViewerTarget>)

/**
 * Reads what the computer sends one entry at a time: a target type this
 * build doesn't know, or a malformed viewer, drops that entry alone.
 */
internal object ViewersWire {
    private fun target(element: JsonElement?): ViewerTarget? {
        val target = element as? JsonObject ?: return null
        val id = (target["id"] as? JsonPrimitive)?.contentOrNull ?: return null
        return when ((target["type"] as? JsonPrimitive)?.contentOrNull) {
            "agent" -> ViewerTarget.agent(id)
            "surface" -> ViewerTarget.surface(id)
            else -> null
        }
    }

    private fun viewer(element: JsonElement?): Viewer? = runCatching { AgentClient.json.decodeFromJsonElement(Viewer.serializer(), element!!) }.getOrNull()

    fun answer(body: JsonObject): Map<ViewerTarget, List<Viewer>> = (body["targets"] as? JsonArray).orEmpty().mapNotNull { element ->
        val entry = element as? JsonObject ?: return@mapNotNull null
        val target = target(entry["target"]) ?: return@mapNotNull null
        target to (entry["viewers"] as? JsonArray).orEmpty().mapNotNull(::viewer)
    }.toMap()

    fun frame(data: String): Pair<ViewerTarget, Viewer>? {
        val body = runCatching { AgentClient.json.parseToJsonElement(data) as? JsonObject }.getOrNull() ?: return null
        val target = target(body["target"]) ?: return null
        return target to (viewer(body["viewer"]) ?: return null)
    }
}

class AgentViewersBackend(private val client: AgentClient) : ViewersBackend {
    override suspend fun put(streamId: String, targets: List<ViewerTarget>): Map<ViewerTarget, List<Viewer>>? = try {
        val body = AgentClient.json.encodeToJsonElement(ViewersBody.serializer(), ViewersBody(targets))
        ViewersWire.answer(client.decode<JsonObject>("PUT", "/v0/viewers/streams/${AgentClient.escape(streamId)}", body))
    } catch (e: AgentApiException) {
        if (e.status == 404) null else throw e
    }
}

/** Whether the computer serves viewers; the header keeps its slot only once it does. */
enum class ViewersAvailability {
    Unknown,
    Served,
    /** Answered 404 (standalone or older): not asked again on this stream. */
    Refused,
}

/**
 * Who else is on what this phone shows (iOS's and desktop's viewers store),
 * over the account's one event stream. Screens [view] their target while
 * resumed. One owner coroutine takes every change in order (views, the
 * stream opening and closing, frames, answers), so nothing it shows can
 * come from a stream or a send that is already over.
 *
 * What is viewed (newest first, at most 8) is sent [settleMillis] after the
 * last change to it, again [heartbeatMillis] after each send while anything
 * is, and `[]` once nothing is and the stream may still hold something (a
 * send whose answer was lost counts). A target whose last screen leaves is
 * kept for [handoffMillis], so going from one screen of it to another (a
 * vault's folders) never says it was left. Each answer replaces the lists,
 * and `viewers.updated` frames land on top in arrival order, those that
 * overtook the answer included.
 */
class Viewers(
    private val scope: CoroutineScope,
    private val backend: ViewersBackend,
    private val heartbeatMillis: Long = HEARTBEAT_MILLIS,
    private val settleMillis: Long = SETTLE_MILLIS,
    private val handoffMillis: Long = HANDOFF_MILLIS,
    private val retryMillis: Long = RETRY_MILLIS,
    /** Monotonic milliseconds. */
    private val now: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private sealed interface Event {
        class View(val target: ViewerTarget) : Event
        class Unview(val target: ViewerTarget) : Event
        class Opened(val streamId: String?) : Event
        data object Closed : Event
        class Frame(val data: String) : Event
        class Answer(val send: Int, val result: Result<Map<ViewerTarget, List<Viewer>>?>) : Event
    }

    private val events = Channel<Event>(Channel.UNLIMITED)
    private val listsState = MutableStateFlow<Map<ViewerTarget, List<Viewer>>>(emptyMap())
    private val availabilityState = MutableStateFlow(ViewersAvailability.Unknown)

    /** Each viewed target's people, here first then newest; a target with no answer yet is absent. */
    val lists: StateFlow<Map<ViewerTarget, List<Viewer>>> = listsState.asStateFlow()
    val availability: StateFlow<ViewersAvailability> = availabilityState.asStateFlow()

    /** Holds [target] as viewed until cancelled. */
    suspend fun view(target: ViewerTarget): Nothing {
        events.trySend(Event.View(target))
        try {
            awaitCancellation()
        } finally {
            events.trySend(Event.Unview(target))
        }
    }

    /** The stream's `hello`. A new stream holds nothing yet, and may be asked again after a refusal; the same one said again changes nothing. */
    fun opened(streamId: String?) { events.trySend(Event.Opened(streamId)) }

    /** The stream ended: so did everything it viewed, here and on the computer. */
    fun closed() { events.trySend(Event.Closed) }

    /** A `viewers.updated` frame's data. */
    fun frame(data: String) { events.trySend(Event.Frame(data)) }

    fun stop() = owner.cancel()

    // Everything below belongs to the owner coroutine alone.
    private var streamId: String? = null
    private var served = ViewersAvailability.Unknown
    private val views = ArrayList<ViewerTarget>()
    /** Targets whose last screen left, until when they still count as viewed. */
    private val leaving = LinkedHashMap<ViewerTarget, Long>()
    /** The stream may hold targets: set when a non-empty send goes out, cleared by an answered `[]` or a new stream. */
    private var mayHold = false
    private var sending: Job? = null
    private var sendNumber = 0
    /** Frames that came while a send was out: newer than its answer, so they go back on top of it. */
    private val sinceSend = ArrayList<Pair<ViewerTarget, Viewer>>()
    /** What the last send asked for, answered or not. */
    private var sent: List<ViewerTarget>? = null
    /** When what is viewed has settled after a change. */
    private var changeAt: Long? = null
    /** When the lease is renewed: a heartbeat after the last send, or a retry after a failed one. */
    private var renewAt: Long? = null

    private fun wanted(): List<ViewerTarget> = (views.asReversed() + leaving.keys.reversed()).distinct().take(MAX_TARGETS)

    @OptIn(ExperimentalCoroutinesApi::class)
    private val owner = scope.launch {
        while (true) {
            val wake = listOfNotNull(changeAt, renewAt, leaving.values.minOrNull()).minOrNull()
            // A select, so an event is never lost to the timeout.
            val event: Event? = if (wake == null) events.receive() else select<Event?> {
                events.onReceive { it }
                onTimeout((wake - now()).coerceAtLeast(0)) { null }
            }
            val before = wanted().toSet()
            if (event == null) expire() else handle(event)
            val after = wanted().toSet()
            // Each change restarts the settle; a target left for good already waited out its handoff.
            if (after != before && streamId != null) {
                changeAt = if (event == null) now() else now() + settleMillis
            }
            val time = now()
            if (renewAt?.let { it <= time } == true) {
                send()
            } else if (changeAt?.let { it <= time } == true) {
                changeAt = null
                // Changed and changed back since the last send: the lease it renewed still stands.
                if (after != sent?.toSet()) send()
            }
        }
    }

    private fun handle(event: Event) {
        when (event) {
            is Event.View -> {
                views += event.target
                leaving.remove(event.target)
            }
            is Event.Unview -> {
                views.remove(event.target)
                if (event.target !in views) leaving[event.target] = now() + handoffMillis
            }
            is Event.Opened -> {
                if (event.streamId == streamId) return
                endStream()
                streamId = event.streamId
                if (served == ViewersAvailability.Refused) publishAvailability(ViewersAvailability.Unknown)
                if (streamId != null && wanted().isNotEmpty()) changeAt = now()
            }
            Event.Closed -> {
                endStream()
                streamId = null
            }
            is Event.Frame -> {
                val update = ViewersWire.frame(event.data) ?: return
                if (sending != null) sinceSend += update
                listsState.value = landed(listsState.value, update)
            }
            is Event.Answer -> answered(event)
        }
    }

    /** Targets left for good: no longer viewed, and their lists go with them. */
    private fun expire() {
        val time = now()
        val gone = leaving.filterValues { it <= time }.keys
        if (gone.isEmpty()) return
        gone.forEach(leaving::remove)
        listsState.value = listsState.value - gone
    }

    private fun endStream() {
        sending?.cancel()
        sending = null
        sendNumber++
        sent = null
        sinceSend.clear()
        changeAt = null
        renewAt = null
        mayHold = false
        listsState.value = emptyMap()
    }

    private fun send() {
        val stream = streamId
        val targets = wanted()
        changeAt = null
        if (stream == null || served == ViewersAvailability.Refused || (targets.isEmpty() && !mayHold)) {
            renewAt = null
            return
        }
        sending?.cancel()
        if (targets.isNotEmpty()) mayHold = true
        val number = ++sendNumber
        sent = targets
        sinceSend.clear()
        // Renewed from when it went, so a slow answer never lets the computer's lease lapse.
        renewAt = if (targets.isEmpty()) null else now() + heartbeatMillis
        sending = scope.launch {
            val result = try {
                Result.success(backend.put(stream, targets))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Result.failure(e)
            }
            events.send(Event.Answer(number, result))
        }
    }

    private fun answered(answer: Event.Answer) {
        if (answer.send != sendNumber) return
        sending = null
        val targets = sent ?: return
        answer.result.onSuccess { lists ->
            if (lists == null) {
                publishAvailability(ViewersAvailability.Refused)
                mayHold = false
                renewAt = null
                listsState.value = emptyMap()
                return
            }
            publishAvailability(ViewersAvailability.Served)
            if (targets.isEmpty()) mayHold = false
            val viewed = wanted().toSet()
            val answered = targets.filter { it in viewed }.associateWith { ordered(lists[it].orEmpty()) } +
                listsState.value.filterKeys { it in viewed && it !in targets }
            listsState.value = sinceSend.fold(answered, ::landed)
        }.onFailure {
            renewAt = minOf(renewAt ?: Long.MAX_VALUE, now() + retryMillis)
        }
    }

    /** [update] on its target's list, when that target has one. */
    private fun landed(lists: Map<ViewerTarget, List<Viewer>>, update: Pair<ViewerTarget, Viewer>): Map<ViewerTarget, List<Viewer>> {
        val (target, viewer) = update
        val list = lists[target] ?: return lists
        return lists + (target to ordered(list.filter { it.userId != viewer.userId } + viewer))
    }

    private fun publishAvailability(value: ViewersAvailability) {
        served = value
        availabilityState.value = value
    }

    companion object {
        const val FRAME = "viewers.updated"
        const val HEARTBEAT_MILLIS = 15_000L
        const val SETTLE_MILLIS = 300L
        /** Longer than a page's 450 ms push, so a screen handing its target to the next one keeps it. */
        const val HANDOFF_MILLIS = 600L
        const val RETRY_MILLIS = 3_000L
        const val MAX_TARGETS = 8
        const val MAX_VIEWERS = 50

        /** The route's order: here first, then the newest, at most [MAX_VIEWERS]. */
        fun ordered(viewers: List<Viewer>): List<Viewer> =
            viewers.sortedWith(compareByDescending<Viewer> { it.here }.thenByDescending { it.lastSeenAt }).take(MAX_VIEWERS)
    }
}
