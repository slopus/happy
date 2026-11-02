package com.slopus.happy.connection

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job

/**
 * Where an account's link to its server or computer stands, as its headers
 * say it (iOS's `LinkState`, 7aee3a9b8). Each account kind works it out from
 * its own sources; home's title and every chat's header read the same one.
 */
enum class LinkState {
    /** Connected and caught up. */
    Online,

    /** Connected, catching up ("Updating…"). */
    Syncing,

    /** Reaching the server or computer ("Connecting…"). */
    Connecting,

    /** Not reaching it, for a reason a screen says on its own (a computer that did not answer, a revoked pairing). */
    Offline,

    /** No network at all ("Waiting for network…"). */
    WaitingForNetwork,
}

/**
 * What a header shows of a [LinkState] that keeps changing, as Telegram's
 * title does (iOS's `LinkStateDebounce`): a short wobble never shows.
 * "Connecting…" or "Updating…" shows only once the link has been away
 * [SHOW_AFTER_MS] without coming back, and whatever shows stays at least
 * [HOLD_FOR_MS]. Online again gives the title back once it has stood
 * [LIVE_FOR_MS], so a status hands straight to the next without the title
 * flashing between them. "Waiting for network…" is news: it shows at once,
 * over any hold.
 *
 * Pure, with time passed in: each call says when to [settle] next, if a
 * change is still to come. [shownLinkState] runs it on a flow.
 */
class LinkStateDebounce(shown: LinkState = LinkState.Online, wanted: LinkState, now: Long) {
    /** What the header shows now. */
    var shown: LinkState = shown
        private set

    /** What the link is, as last told. */
    var wanted: LinkState = wanted
        private set

    private var awaySince = now
    private var liveSince = now
    private var shownSince = now

    /** The link is now [state]. Returns when to [settle], if a change is due later. */
    fun want(state: LinkState, now: Long): Long? {
        if (wanted == LinkState.Online && state != LinkState.Online) awaySince = now
        if (wanted != LinkState.Online && state == LinkState.Online) liveSince = now
        wanted = state
        return settle(now)
    }

    /** Shows what is due by [now]. Returns when to call again, if a change is still to come. */
    fun settle(now: Long): Long? {
        val (next, due) = target(now)
        if (next != shown) {
            shown = next
            shownSince = now
            // A change shown starts its own hold.
            return target(now).second
        }
        return due
    }

    private fun target(now: Long): Pair<LinkState, Long?> {
        if (wanted == shown) return shown to null
        if (wanted == LinkState.WaitingForNetwork) return wanted to null
        val held = shownSince + HOLD_FOR_MS
        if (shown != LinkState.Online && now < held) return shown to held
        if (wanted == LinkState.Online) {
            val stood = liveSince + LIVE_FOR_MS
            return if (now < stood) shown to stood else wanted to null
        }
        if (shown != LinkState.Online) return wanted to null
        val due = awaySince + SHOW_AFTER_MS
        return if (now < due) shown to due else wanted to null
    }

    companion object {
        const val SHOW_AFTER_MS = 800L
        const val HOLD_FOR_MS = 600L
        const val LIVE_FOR_MS = 300L
    }
}

/**
 * What a header shows of this flow of link states, debounced by
 * [LinkStateDebounce]. Starts showing online: a launch shows the title, and
 * a slow first connection says so after [LinkStateDebounce.SHOW_AFTER_MS].
 */
fun Flow<LinkState>.shownLinkState(now: () -> Long = System::currentTimeMillis): Flow<LinkState> = channelFlow {
    var debounce: LinkStateDebounce? = null
    var timer: Job? = null
    fun schedule(due: Long?) {
        timer?.cancel()
        timer = due?.let { at ->
            launch {
                delay((at - now()).coerceAtLeast(0))
                val shown = debounce ?: return@launch
                schedule(shown.settle(now()))
                send(shown.shown)
            }
        }
    }
    collect { state ->
        val current = debounce
        if (current == null) {
            val created = LinkStateDebounce(wanted = state, now = now())
            debounce = created
            schedule(created.settle(now()))
            send(created.shown)
        } else {
            schedule(current.want(state, now()))
            send(current.shown)
        }
    }
}.distinctUntilChanged()
