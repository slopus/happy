package com.slopus.happy.viewers

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.decode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

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
@Serializable private class TargetViewers(val target: ViewerTarget, val viewers: List<Viewer>)
@Serializable private class ViewersAnswer(val targets: List<TargetViewers>)
@Serializable private class ViewersFrame(val target: ViewerTarget, val viewer: Viewer)

class AgentViewersBackend(private val client: AgentClient) : ViewersBackend {
    override suspend fun put(streamId: String, targets: List<ViewerTarget>): Map<ViewerTarget, List<Viewer>>? = try {
        val body = AgentClient.json.encodeToJsonElement(ViewersBody.serializer(), ViewersBody(targets))
        client.decode<ViewersAnswer>("PUT", "/v0/viewers/streams/${AgentClient.escape(streamId)}", body)
            .targets.associate { it.target to it.viewers }
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
 * resumed; the store sends what is viewed, settled for [settleMillis], on
 * every change and every [heartbeatMillis] while anything is, then `[]`
 * once nothing is (background, lock, leaving). Each answer replaces the
 * lists, and `viewers.updated` frames land on top in arrival order; the
 * next answer heals any race.
 */
class Viewers(
    scope: CoroutineScope,
    private val backend: ViewersBackend,
    private val heartbeatMillis: Long = HEARTBEAT_MILLIS,
    private val settleMillis: Long = SETTLE_MILLIS,
) {
    /** What the loop works from: the open stream, the views (newest last, one per screen), and what that stream was last sent. */
    private data class Inputs(
        val streamId: String? = null,
        val views: List<ViewerTarget> = emptyList(),
        val availability: ViewersAvailability = ViewersAvailability.Unknown,
        val held: List<ViewerTarget> = emptyList(),
    ) {
        /** Newest first, so the screen on top always fits the route's 8. */
        val targets: List<ViewerTarget> get() = views.asReversed().distinct().take(MAX_TARGETS)
        val due: Boolean get() = streamId != null && availability != ViewersAvailability.Refused && (targets.isNotEmpty() || held.isNotEmpty())
    }

    private val inputs = MutableStateFlow(Inputs())
    private val listsState = MutableStateFlow<Map<ViewerTarget, List<Viewer>>>(emptyMap())
    private val availabilityState = MutableStateFlow(ViewersAvailability.Unknown)

    /** Each viewed target's people, here first then newest; a target with no answer yet is absent. */
    val lists: StateFlow<Map<ViewerTarget, List<Viewer>>> = listsState.asStateFlow()
    val availability: StateFlow<ViewersAvailability> = availabilityState.asStateFlow()

    /** Holds [target] as viewed until cancelled. */
    suspend fun view(target: ViewerTarget): Nothing {
        inputs.update { it.copy(views = it.views + target) }
        try {
            awaitCancellation()
        } finally {
            inputs.update { it.copy(views = it.views - target) }
        }
    }

    /** The stream's `hello`: a new stream holds nothing yet, and may ask again after a refusal. */
    fun opened(streamId: String?) {
        change {
            it.copy(
                streamId = streamId,
                availability = if (it.availability == ViewersAvailability.Refused) ViewersAvailability.Unknown else it.availability,
                held = emptyList(),
            )
        }
    }

    /** The stream ended: so did everything it viewed, here and on the computer. */
    fun closed() {
        change { it.copy(streamId = null, held = emptyList()) }
        listsState.value = emptyMap()
    }

    /** A `viewers.updated` frame's data, applied to a list it belongs to; any other is dropped. */
    fun frame(data: String) {
        val frame = runCatching { AgentClient.json.decodeFromString(ViewersFrame.serializer(), data) }.getOrNull() ?: return
        listsState.update { lists ->
            val list = lists[frame.target] ?: return@update lists
            lists + (frame.target to ordered(list.filter { it.userId != frame.viewer.userId } + frame.viewer))
        }
    }

    private inline fun change(block: (Inputs) -> Inputs) {
        inputs.update(block)
        availabilityState.value = inputs.value.availability
    }

    private val loop = scope.launch {
        while (true) {
            inputs.first { it.due }
            delay(settleMillis)
            val sending = inputs.value.takeIf { it.due } ?: continue
            val streamId = sending.streamId!!
            val targets = sending.targets
            val answer = try {
                Result.success(backend.put(streamId, targets))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Tried again with the next change or heartbeat.
                Result.failure(e)
            }
            answer.onSuccess { lists ->
                if (inputs.value.streamId != streamId) return@onSuccess
                if (lists == null) {
                    change { it.copy(availability = ViewersAvailability.Refused, held = emptyList()) }
                    listsState.value = emptyMap()
                } else {
                    change { it.copy(availability = ViewersAvailability.Served, held = targets) }
                    listsState.value = targets.associateWith { ordered(lists[it].orEmpty()) }
                }
            }
            val settled = inputs.value
            val idle = settled.targets.isEmpty() && settled.held.isEmpty()
            withTimeoutOrNull(if (idle) Long.MAX_VALUE else heartbeatMillis) {
                inputs.first { it.streamId != settled.streamId || it.targets != settled.targets || it.availability != settled.availability }
            }
        }
    }

    fun stop() = loop.cancel()

    companion object {
        const val FRAME = "viewers.updated"
        const val HEARTBEAT_MILLIS = 15_000L
        const val SETTLE_MILLIS = 300L
        const val MAX_TARGETS = 8
        const val MAX_VIEWERS = 50

        /** The route's order: here first, then the newest, at most [MAX_VIEWERS]. */
        fun ordered(viewers: List<Viewer>): List<Viewer> =
            viewers.sortedWith(compareByDescending<Viewer> { it.here }.thenByDescending { it.lastSeenAt }).take(MAX_VIEWERS)
    }
}
