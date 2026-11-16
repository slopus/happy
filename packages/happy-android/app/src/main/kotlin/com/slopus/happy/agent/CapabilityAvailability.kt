package com.slopus.happy.agent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Whether a connection has something health advertises, so home lists its
 * row: what the connection last said ([kept], so the row doesn't come and
 * go on each start), then health's capability on every connect
 * ([noteHealth]). Plugins and Pipelines each keep one.
 */
class CapabilityAvailability(
    /**
     * FALLBACK for servers deployed before the capability: asked when
     * health doesn't advertise it. Null where no fallback applies.
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

    /** Health was read: [advertised] is its capability. */
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
}
