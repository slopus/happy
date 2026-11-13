package com.slopus.happy.plugins

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Whether a connection has plugins, so home lists its Plugins row: what
 * the connection last said ([kept], so the row doesn't come and go on each
 * start), then health's `capabilities.plugins` on every connect ([noteHealth]).
 */
class PluginsAvailability(
    /**
     * FALLBACK for servers deployed before `capabilities.plugins`: asked
     * when health doesn't advertise it. Null where no fallback applies.
     * Delete it once every deployed server sends the flag.
     */
    private val probe: (suspend () -> Boolean?)?,
    kept: suspend () -> Boolean?,
    private val keep: suspend (Boolean) -> Unit,
    private val scope: CoroutineScope,
) {
    private val mutableAvailable = MutableStateFlow(false)
    val available: StateFlow<Boolean> = mutableAvailable.asStateFlow()
    @Volatile private var stored: Boolean? = null
    @Volatile private var answered = false

    init {
        scope.launch {
            val last = kept()
            stored = last
            if (!answered && last != null) mutableAvailable.value = last
        }
    }

    /** Health was read: [advertised] is its `capabilities.plugins`. */
    fun noteHealth(advertised: Boolean) {
        val probe = probe
        if (advertised || probe == null) return settle(advertised)
        scope.launch {
            val answer = try {
                probe()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
            answer?.let(::settle)
        }
    }

    private fun settle(answer: Boolean) {
        answered = true
        mutableAvailable.value = answer
        if (answer == stored) return
        stored = answer
        scope.launch { keep(answer) }
    }

    companion object {
        const val RESOURCE = "plugins-available"

        /** `GET /v0/plugins` answering at all: true, 404/501 false, anything else unknown (null). */
        suspend fun probe(client: AgentClient): Boolean? = try {
            client.send("GET", "/v0/plugins")
            true
        } catch (e: AgentApiException) {
            if (e.status == 404 || e.status == 501) false else null
        }
    }
}
