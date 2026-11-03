package com.slopus.happy.agent

import com.slopus.happy.conversation.AccountUsage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.onSubscription
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * The computer's accounts' plan usage (iOS `ModelState.followUsage`,
 * 083c30df4), so a composer's model chip can warn as its account runs low.
 * Followed while a composer shows: read once, then again whenever the
 * computer says an account's usage or the configuration changed
 * (`provider.usage.*`, `config.updated`) and on every reconnect. As
 * desktop's usage source, it keeps following for [LINGER_MS] after the last
 * follower goes, so opening chat after chat doesn't read every account again.
 */
class AgentUsageSource internal constructor(
    private val read: suspend () -> JsonObject,
    private val events: SharedFlow<AgentEvent>,
    private val scope: CoroutineScope,
    /** `POST /v0/usage/refresh`: the computer asks these accounts' services again. */
    private val askAgain: suspend (List<String>) -> Unit = {},
) {
    private val usageFlow = MutableStateFlow<Map<String, AccountUsage>>(emptyMap())
    val usage: StateFlow<Map<String, AccountUsage>> = usageFlow.asStateFlow()

    private val lock = Any()
    private var followers = 0
    private var following: Job? = null
    private var lingering: Job? = null
    private var refreshing: Job? = null

    /** Follows the readings until the returned handle is closed. */
    fun follow(): AutoCloseable {
        synchronized(lock) {
            followers += 1
            lingering?.cancel()
            lingering = null
            if (following == null) following = scope.launch { followEvents() }
        }
        var closed = false
        return AutoCloseable {
            synchronized(lock) {
                if (closed) return@AutoCloseable
                closed = true
                followers -= 1
                if (followers > 0) return@AutoCloseable
                lingering = scope.launch {
                    delay(LINGER_MS)
                    synchronized(lock) {
                        if (followers == 0) {
                            following?.cancel()
                            following = null
                            lingering = null
                        }
                    }
                }
            }
        }
    }

    /**
     * The readings now, then fresher ones for [accounts] once the computer
     * has asked their services, as desktop asks as its model menu opens:
     * read, ask, and read again three times two seconds apart.
     */
    fun refresh(accounts: List<String>) {
        synchronized(lock) {
            refreshing?.cancel()
            refreshing = scope.launch {
                readUsage()
                try {
                    askAgain(accounts)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                }
                repeat(REFRESH_READS) {
                    delay(REFRESH_SPACING_MS)
                    readUsage()
                }
            }
        }
    }

    /** Reads once and then on each change; asks while a read is out make one read after it. */
    private suspend fun followEvents() = coroutineScope {
        val asks = Channel<Unit>(Channel.CONFLATED)
        launch { for (ask in asks) readUsage() }
        events
            .onSubscription { asks.trySend(Unit) }
            .filter { it.type.startsWith("provider.usage.") || it.type == "config.updated" || it.type == AgentEvent.HELLO }
            .collect { asks.trySend(Unit) }
    }

    private suspend fun readUsage() {
        val response = try {
            read()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return
        }
        usageFlow.value = AccountUsage.project(response)
    }

    companion object {
        /** How long following outlives its last follower (desktop's `SOURCE_LINGER_MS`). */
        const val LINGER_MS = 30_000L
        const val REFRESH_READS = 3
        const val REFRESH_SPACING_MS = 2_000L
    }
}
