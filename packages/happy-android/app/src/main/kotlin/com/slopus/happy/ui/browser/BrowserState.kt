package com.slopus.happy.ui.browser

import android.net.Uri
import android.util.Log
import android.webkit.WebView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.slopus.happy.browser.BrowserLink
import com.slopus.happy.browser.BrowserProblem
import com.slopus.happy.browser.BrowserProgress
import com.slopus.happy.browser.BrowserRefusals

/** One entry of a page's history, as the back and forward menus list it. */
data class BrowserHistoryItem(val steps: Int, val title: String, val host: String?)

/**
 * What the browser shows and what its buttons do (iOS's
 * `BrowserViewController` state, 34aa464e1): the loading bar, the error
 * page's problem and the address that failed, history and the page's title.
 * [BrowserView] draws the page from it and feeds it WebView's callbacks;
 * [BrowserControls] are its buttons, in whichever bar holds them. Main
 * thread only.
 */
@Stable
class BrowserState internal constructor() {
    var progress by mutableStateOf(BrowserProgress())
        private set
    /** Why the error page shows, while it does. */
    var problem by mutableStateOf<BrowserProblem?>(null)
        private set
    /** The address that failed, which Try Again loads. */
    var failedUrl by mutableStateOf<String?>(null)
        private set
    var canGoBack by mutableStateOf(false)
        private set
    var canGoForward by mutableStateOf(false)
        private set
    /** A main-frame load is under way: reload is stop. */
    var loading by mutableStateOf(false)
        private set
    /** The page's own title, when it has one. */
    var pageTitle by mutableStateOf<String?>(null)
        private set
    /** Where the page is now. */
    var url by mutableStateOf<String?>(null)
        private set
    /** Pull to refresh's spinner. */
    var refreshing by mutableStateOf(false)
        internal set
    /** The page being shown, once it was prepared. */
    var page by mutableStateOf<BrowserPage?>(null)
        internal set
    /** A link to an app nothing opens, asked about over the page. */
    var cantOpen by mutableStateOf<BrowserProblem.Unsupported?>(null)
        internal set

    /** The page paints no background of its own and asks for no dark one: it was made on white ([BARE_PAGE]). */
    internal var bare by mutableStateOf(false)

    /** Bumped to make a new WebView, after the renderer stopped. */
    internal var generation by mutableIntStateOf(0)
        private set
    /** Bumped to open the page again when it never opened. */
    internal var attempt by mutableIntStateOf(0)
        private set
    internal var web: WebView? = null
        set(value) {
            field = value
            navigation()
        }
    internal var link: BrowserLink? = null
    internal var artifactLink: (String) -> String? = { null }
    /** The server's edge refuses tunnels (edge SSO): nothing would load, so reloading does nothing. */
    internal var blocked = false
    internal var refusals: BrowserRefusals? = null
    internal val start: String? get() = page?.url
    /** The main frame's address being loaded, for failures that don't say. */
    private var pending: String? = null
    /** The renderer stopped and the page was reloaded once for it; a second stop shows the error page. */
    private var reloadedAfterCrash = false
    /** The quiet reload's load is still to start: its start isn't another page's. */
    private var crashReloading = false

    /** Whether a page is on screen, which is what share and copy work on. */
    val hasPage: Boolean get() = page != null

    /** The page as it is now: where it went, or the address that failed. */
    val currentUrl: String? get() = (if (problem != null) failedUrl else null) ?: url ?: start

    /** System back goes back a page while the page has somewhere to go and no error shows; otherwise it closes the screen. */
    val takesBack: Boolean get() = problem == null && canGoBack

    // Actions.

    fun goBack() {
        clearFailure()
        web?.goBack()
        navigation()
    }

    fun goForward() {
        clearFailure()
        web?.goForward()
        navigation()
    }

    /** Goes to a history entry from the back or forward menu. */
    fun go(item: BrowserHistoryItem) {
        clearFailure()
        web?.goBackOrForward(item.steps)
        navigation()
    }

    /** Reload, or stop while loading; Try Again over the error page. */
    fun reloadOrStop() {
        if (blocked) return
        val view = web
        if (view == null || problem != null) return retry()
        if (loading) {
            view.stopLoading()
            loading = false
            refreshing = false
            progress = progress.hide()
            return
        }
        reload(view)
    }

    /** Pull to refresh: always loads again, never stops. */
    fun pulled() {
        if (blocked) {
            refreshing = false
            return
        }
        val view = web
        if (view == null || problem != null) return retry()
        reload(view)
    }

    /** Try Again: the address that failed, not the last one that worked. */
    fun retry() {
        if (blocked) return
        val failed = failedUrl
        clearFailure()
        reloadedAfterCrash = false
        val view = web
        if (view == null) {
            progress = progress.begin()
            attempt++
            return
        }
        load(failed ?: view.url ?: start ?: return, view)
    }

    /** The history that way, nearest first. */
    fun history(forward: Boolean): List<BrowserHistoryItem> {
        val list = web?.copyBackForwardList() ?: return emptyList()
        val current = list.currentIndex
        val indices = if (forward) (current + 1 until list.size) else (current - 1 downTo 0)
        return indices.map { index ->
            val item = list.getItemAtIndex(index)
            val host = hostOf(item.url)
            BrowserHistoryItem(index - current, item.title?.takeIf { it.isNotBlank() && it != item.url } ?: host ?: item.url, host)
        }
    }

    // What the screen and WebView report.

    internal fun begin() {
        progress = progress.begin()
    }

    internal fun trickle() {
        progress = progress.trickle()
    }

    /** The bar finished fading after a load. */
    internal fun faded() {
        if (progress.phase == BrowserProgress.Phase.Finishing) progress = progress.hide()
    }

    internal fun load(url: String, view: WebView) {
        // WebView says a load started only once its first answer is in, after the tunnel: it is under way from now.
        loading = true
        progress = progress.begin()
        pending = url
        view.loadUrl(url)
    }

    private fun reload(view: WebView) {
        if (view.url == null) return load(failedUrl ?: start ?: return, view)
        loading = true
        progress = progress.begin()
        view.reload()
    }

    internal fun estimate(fraction: Float) {
        progress = progress.estimate(fraction)
    }

    internal fun started(url: String?) {
        // WebView commits its own error document for the address that failed: that is no new load.
        if (problem != null && url == failedUrl) return
        // Another page than the quiet reload's: a stop there gets its own quiet reload. (WebView may finish one load twice, so not on finishing.)
        if (crashReloading) crashReloading = false else reloadedAfterCrash = false
        if (url != null) pending = url
        loading = true
        progress = progress.begin()
        navigation()
    }

    internal fun finished() {
        loading = false
        refreshing = false
        navigation()
        // A failure says so before WebView finishes: only a load that ended without one fills the bar.
        if (problem == null) {
            progress = progress.finish()
            failedUrl = null
        } else {
            progress = progress.hide()
        }
    }

    internal fun title(text: String?) {
        pageTitle = text?.takeIf { it.isNotBlank() && !it.startsWith("http") }
    }

    internal fun navigation() {
        val view = web
        canGoBack = view?.canGoBack() == true
        canGoForward = view?.canGoForward() == true
        if (view != null) {
            view.url?.let { url = it }
            title(view.title)
        }
    }

    /** A main-frame load failed; [code] and [description] are WebView's. */
    internal fun failed(code: Int, description: String, failing: String?) {
        Log.i(TAG, "Page load failed: $code ${description.substringAfter("net::", description)}")
        val address = failing ?: pending
        val refusal = address?.let { refusals?.last(it) }
        val problem = BrowserProblem.navigation(code, description, address, refusal, link)
        if (problem == null) {
            if (!loading) progress = progress.hide()
            return
        }
        fail(problem, address)
    }

    /** The main frame answered [status]; whether that is a page or the error page is [BrowserProblem.response]'s call. */
    internal fun answered(status: Int, proxyError: String?, hasBody: Boolean, reason: String?, address: String?) {
        val problem = BrowserProblem.response(status, proxyError, hasBody, link, reason) ?: return
        fail(problem, address ?: pending)
    }

    /** The renderer stopped: one quiet new WebView, then the error page if it stops again before a page finishes. */
    internal fun crashed() {
        val address = url ?: pending ?: start
        web = null
        if (reloadedAfterCrash) {
            generation++
            fail(BrowserProblem.Crashed, address)
            return
        }
        reloadedAfterCrash = true
        crashReloading = true
        progress = progress.begin()
        failedUrl = address
        generation++
    }

    /**
     * The phone lost its network while a load waited on it: the computer's
     * connection would only time out, so stop and say so now. The network's
     * return opens it again ([linkChanged]).
     */
    internal fun offline() {
        if (problem != null || progress.phase != BrowserProgress.Phase.Loading) return
        web?.stopLoading()
        fail(BrowserProblem.NoNetwork, pending ?: start)
    }

    /** The address a new WebView opens: the page that failed or was showing, else the first. */
    internal fun opening(): String? = failedUrl ?: start

    internal fun fail(problem: BrowserProblem, address: String?) {
        this.problem = problem
        failedUrl = address ?: failedUrl ?: start
        progress = progress.hide()
        loading = false
        refreshing = false
        navigation()
    }

    internal fun linkChanged(next: BrowserLink?) {
        val before = link
        link = next
        // The computer is back: what failed for want of it opens by itself.
        if (next == BrowserLink.Online && before != BrowserLink.Online &&
            (problem == BrowserProblem.ComputerUnreachable || problem == BrowserProblem.NoNetwork)
        ) {
            retry()
        }
    }

    private fun clearFailure() {
        problem = null
        refusals?.clear()
    }

    companion object {
        private const val TAG = "Browser"
        /** How long a load waits with no network before it gives up: a blip passes, a lost network doesn't. */
        internal const val OFFLINE_GRACE_MILLIS = 1_000L

        internal fun hostOf(url: String?): String? = url?.let { runCatching { Uri.parse(it).host }.getOrNull() }?.takeIf { it.isNotEmpty() }

        /** The host and any port, as the error page names a server: a dev server is told apart by its port. Nothing for a made-up origin. */
        internal fun address(url: String?): String? {
            val uri = url?.let { runCatching { Uri.parse(it) }.getOrNull() } ?: return null
            val host = uri.host?.takeIf { it.isNotEmpty() && !it.endsWith(".invalid") } ?: return null
            return if (uri.port != -1) "$host:${uri.port}" else host
        }
    }
}

@Composable
fun rememberBrowserState(): BrowserState = remember { BrowserState() }
