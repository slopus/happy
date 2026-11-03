package com.slopus.happy.browser

/**
 * The browser's loading bar (iOS's `BrowserProgress`, 34aa464e1).
 *
 * WebView's own progress can't drive it alone: through the agent proxy
 * every request first opens a tunnel to the computer, and WebView reports
 * 10 % for the whole tunnel setup, often seconds, then jumps to 100 % within
 * a frame. So the bar starts at once at [START], creeps on its own while
 * nothing is heard ([trickle]), takes WebView's estimate whenever it is
 * further, never goes back within a load, and fills before it fades.
 *
 * Immutable: the screen applies each change as things happen and draws
 * what it says.
 */
data class BrowserProgress(val phase: Phase = Phase.Hidden, val value: Float = 0f) {
    enum class Phase {
        /** Nothing is loading and the bar is gone. */
        Hidden,
        /** A load is under way. */
        Loading,
        /** The load is done: the bar fills, then fades. */
        Finishing,
    }

    /**
     * A load began: the session connecting, a navigation, a reload. One
     * already under way goes on from where it is, so a redirect or a
     * navigation that replaces another never moves the bar back.
     */
    fun begin(): BrowserProgress = if (phase == Phase.Loading) this else BrowserProgress(Phase.Loading, START)

    /** WebView's estimate, from 0 to 1, taken only when it is further. */
    fun estimate(fraction: Float): BrowserProgress =
        if (phase != Phase.Loading || !fraction.isFinite()) this else copy(value = maxOf(value, fraction.coerceAtMost(1f)))

    /** A moment ([TRICKLE_MILLIS]) passed with the load still going. */
    fun trickle(): BrowserProgress =
        if (phase != Phase.Loading || value >= TRICKLE_CEILING) this else copy(value = value + (TRICKLE_CEILING - value) * TRICKLE_STEP)

    /** The load completed: the bar fills, then fades. */
    fun finish(): BrowserProgress = if (phase != Phase.Loading) this else BrowserProgress(Phase.Finishing, 1f)

    /** The bar is gone: faded after [finish], or the load failed or stopped. */
    fun hide(): BrowserProgress = BrowserProgress()

    companion object {
        /** Where a load starts, before anything is known. */
        const val START = 0.1f
        /** How far the bar creeps on its own: the rest is the page's to fill. */
        const val TRICKLE_CEILING = 0.7f
        /** The share of the way to the ceiling each [trickle] covers, so it slows as it climbs. */
        const val TRICKLE_STEP = 0.06f
        /** How often the bar trickles while a load is under way. */
        const val TRICKLE_MILLIS = 300L
    }
}
