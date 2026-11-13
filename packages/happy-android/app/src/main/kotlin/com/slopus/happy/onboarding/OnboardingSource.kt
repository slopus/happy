package com.slopus.happy.onboarding

import com.slopus.happy.agent.AgentEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch

/**
 * A Happy Cloud server's onboarding for this person, as the flow over its
 * home follows it: read on every connect, on each event that may move a
 * gate ([CloudOnboarding.REFRESH_EVENTS]) and each time the connection is
 * [active] again (the app back in the foreground: a sign-in on another
 * phone sends nothing). A read that fails keeps what was read before.
 * Reads run one at a time; asks made meanwhile are one more read.
 */
class OnboardingSource(
    private val read: suspend () -> CloudOnboarding,
    events: SharedFlow<AgentEvent>,
    active: Flow<Boolean>,
    private val scope: CoroutineScope,
) {
    private val state = MutableStateFlow<CloudOnboarding?>(null)
    /** Null until read once. */
    val current: StateFlow<CloudOnboarding?> = state.asStateFlow()

    private val laterState = MutableStateFlow(false)
    /** Not Now: the flow stays away while nothing blocks the person, until the app starts again. */
    val later: StateFlow<Boolean> = laterState.asStateFlow()

    private val asks = Channel<Unit>(Channel.CONFLATED)

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            events.collect { if (it.type == AgentEvent.HELLO || it.type in CloudOnboarding.REFRESH_EVENTS) refresh() }
        }
        scope.launch { active.distinctUntilChanged().filter { it }.collect { refresh() } }
        scope.launch {
            for (ask in asks) {
                try {
                    state.value = read()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Offline or refused: the flow keeps what it showed.
                }
            }
        }
    }

    fun refresh() {
        asks.trySend(Unit)
    }

    /** Reads it now, for a screen that waits on the answer ("Check again"); throws when it can't. */
    suspend fun check(): CloudOnboarding = read().also { state.value = it }

    /** A route's answer that already says what onboarding is now (a skip). */
    fun took(onboarding: CloudOnboarding) {
        state.value = onboarding
    }

    fun putAway() {
        laterState.value = true
    }
}
