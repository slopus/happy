package com.slopus.happy.browser

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.decode
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.onSubscription
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Whether the computer an agent's page runs on is there (iOS's
 * `BrowserCompute`). On Happy Cloud the agent's `compute` says so:
 * `type: "none"` is detached, `status: "offline"` gone, `status: "online"`
 * back.
 */
enum class BrowserCompute {
    Attached, Detached;

    companion object {
        /** From an agent's `compute` object; null when it says neither. */
        fun of(compute: JsonElement?): BrowserCompute? {
            val fields = compute.obj ?: return null
            if (fields["type"].str == "none") return Detached
            return when (fields["status"].str) {
                "offline" -> Detached
                "online" -> Attached
                else -> null
            }
        }

        /** A refused tunnel that means the compute is gone rather than the page: `409 no_compute`, or `503` `compute_offline`, `runner_unavailable` or `draining`. */
        fun gone(status: Int, code: String?): Boolean =
            (status == 409 && code == "no_compute") || (status == 503 && code in setOf("compute_offline", "runner_unavailable", "draining"))

        /** The same, from a refusal's JSON body (its `code`). */
        fun gone(status: Int, body: ByteArray): Boolean =
            gone(status, BrowserTunnel.code(body))

        /** Happy Cloud's close of an open tunnel when the agent's compute goes. */
        fun goneOnClose(close: Int, reason: String): Boolean = close == 1001 && (reason == "no_compute" || reason == "compute_offline")
    }
}

/**
 * An agent's compute as its `agent.updated` events tell it (iOS's
 * `BrowserAgentCompute`): read whole first, and again after every `hello`
 * (the stream may have lost some). Told only once the compute has said
 * online or offline: a computer's own agents report `type: "none"`, and
 * their pages never close for it.
 */
fun browserAgentCompute(client: AgentClient, events: SharedFlow<AgentEvent>, agentId: String): Flow<BrowserCompute> = channelFlow {
    var follows = false
    suspend fun tell(compute: JsonElement?) {
        val state = BrowserCompute.of(compute) ?: return
        if (compute.obj?.get("status") != null) follows = true
        if (follows) send(state)
    }
    suspend fun read() = tell(quietly { client.decode<JsonObject>("GET", "/v0/agents/${AgentClient.escape(agentId)}") }?.get("agent").obj?.get("compute"))
    val reads = Channel<Unit>(Channel.CONFLATED)
    launch {
        events
            .onSubscription { reads.trySend(Unit) }
            .collect { event ->
                when {
                    event.type == AgentEvent.HELLO -> reads.trySend(Unit)
                    event.type == "agent.updated" && event.data["agentId"].str == agentId ->
                        event.data["changes"].obj?.get("compute")?.let { tell(it) }
                }
            }
    }
    for (ask in reads) read()
}

/**
 * What a page does as its compute comes and goes: it closes once, saying
 * the compute is disconnected, and opens the same address again when the
 * compute is back. A tunnel refused for the compute being gone closes it
 * as the compute's own news does (`apply(Detached)`); only the compute's
 * return reopens it.
 */
class BrowserComputeGate {
    enum class Action { Close, Reopen }

    var closed = false
        private set

    fun apply(compute: BrowserCompute): Action? = when {
        compute == BrowserCompute.Detached && !closed -> Action.Close.also { closed = true }
        compute == BrowserCompute.Attached && closed -> Action.Reopen.also { closed = false }
        else -> null
    }
}
