package com.slopus.happy.ui.browser

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.webkit.HttpAuthHandler
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.viewinterop.AndroidView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.webkit.ProfileStore
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.slopus.happy.R
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.browser.Browser
import com.slopus.happy.browser.BrowserLink
import com.slopus.happy.browser.BrowserPolicy
import com.slopus.happy.browser.BrowserProblem
import com.slopus.happy.browser.BrowserProgress
import com.slopus.happy.browser.BrowserProxy
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.PageBackHandler
import com.slopus.happy.ui.components.pageStarted
import com.slopus.happy.ui.components.themedWebView
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import java.util.UUID
import java.util.concurrent.Executor

object BrowserTags {
    const val BROWSER = "browser"
    const val WEB = "browser.web"
    const val PROGRESS = "browser.progress"
    const val ERROR = "browser.error"
    const val ERROR_TITLE = "browser.error.title"
    const val ERROR_MESSAGE = "browser.error.message"
    const val RETRY = "browser.retry"
    const val BACK = "browser.back"
    const val FORWARD = "browser.forward"
    const val RELOAD = "browser.reload"
    const val SHARE = "browser.share"
    const val HISTORY_ITEM = "browser.history.item"
}

/**
 * One page to show: [url], reached through [scope] (iOS's `BrowserPage`).
 * [artifactId] marks an artifact's page: its origin is synthetic, sharing
 * shares the artifact's tag, and a link to another origin opens a browser of its own.
 */
@Stable
class BrowserPage(val url: String, val scope: BrowserProxy.Scope, val artifactId: String? = null) {
    /** A bundled artifact's own origin, which exists only inside this app. */
    val synthetic: Boolean get() = artifactId != null && (runCatching { Uri.parse(url).host }.getOrNull()?.endsWith(".invalid") == true)

    companion object {
        /**
         * A bundled artifact's page on an origin of its own (iOS's
         * `BrowserPage.artifact`): `http://a<uuid>.happy-artifact.invalid/<entry>`,
         * which only the proxy answers, from the version's files and the artifact's API.
         */
        fun artifact(scopeFor: (BrowserPolicy.Authority) -> BrowserProxy.Scope, id: String, entry: String): BrowserPage {
            val host = "a" + UUID.randomUUID().toString().replace("-", "") + ".happy-artifact.invalid"
            val path = entry.split('/').joinToString("/") { Uri.encode(it) }
            val url = "http://$host/$path"
            val authority = BrowserPolicy.Authority.of(url) ?: error("synthetic origin")
            return BrowserPage(url, scopeFor(authority), id)
        }
    }
}

/**
 * A WebView profile per browser page (androidx.webkit `MULTI_PROFILE`): its
 * own cookies, storage, cache and network context, so its proxy credential
 * is its page's alone, as iOS gives each page a nonpersistent data store.
 * Deleted with the page's WebView; one that couldn't be (still in use, the
 * process killed) goes at the next [assign]. Without profiles, pages share
 * the default profile and the proxy's shared credential. Main thread only.
 */
internal object WebViewProfiles {
    private const val PREFIX = "browser-"
    private var swept = false

    val supported: Boolean get() = runCatching { WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) }.getOrDefault(false)

    /** Puts [view], new and untouched, in a profile of its own. */
    fun assign(view: WebView) {
        val store = ProfileStore.getInstance()
        if (!swept) {
            swept = true
            store.allProfileNames.filter { it.startsWith(PREFIX) }.forEach { name -> runCatching { store.deleteProfile(name) } }
        }
        val name = PREFIX + UUID.randomUUID().toString().replace("-", "")
        store.getOrCreateProfile(name)
        WebViewCompat.setProfile(view, name)
    }

    /** [view]'s own profile, if it has one. */
    fun of(view: WebView): String? = if (!supported) null else runCatching { WebViewCompat.getProfile(view).name }.getOrNull()?.takeIf { it.startsWith(PREFIX) }

    fun delete(name: String) {
        if (!runCatching { ProfileStore.getInstance().deleteProfile(name) }.getOrDefault(false)) swept = false
    }
}

/**
 * Points every WebView of the app at [BrowserProxy] while any page is open
 * (`ProxyController` is app-wide), with no exclusions, not even localhost:
 * the computer's localhost is the one a page means. Cleared when the last
 * page goes. Main thread only.
 */
internal object WebViewProxyOverride {
    private var users = 0
    private var port = -1
    private var applied: CompletableDeferred<Boolean>? = null
    private val direct = Executor { it.run() }

    val supported: Boolean get() = runCatching { WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE) }.getOrDefault(false)

    /** Applies the override for [port]; false when this WebView can't, and then nothing is to be released. */
    suspend fun acquire(port: Int): Boolean {
        if (!supported) return false
        users++
        try {
            val current = applied
            if (current != null && this.port == port) return current.await()
            val done = CompletableDeferred<Boolean>()
            applied = done
            this.port = port
            val builder = ProxyConfig.Builder().addProxyRule("${BrowserProxy.LOOPBACK.hostAddress}:$port")
            runCatching { builder.removeImplicitRules() }
            ProxyController.getInstance().setProxyOverride(builder.build(), direct) { done.complete(true) }
            return done.await()
        } catch (e: CancellationException) {
            release()
            throw e
        }
    }

    fun release() {
        users = (users - 1).coerceAtLeast(0)
        if (users > 0) return
        port = -1
        applied = null
        runCatching { ProxyController.getInstance().clearProxyOverride(direct) {} }
    }
}


/**
 * The in-app browser's page (iOS's `BrowserViewController`, 34aa464e1): a
 * page that reaches everything through the computer, never the phone's
 * network. It fills its place, the loading bar ([BrowserProgressBar]) on
 * its top edge, and pulling it down reloads. A page that doesn't open is
 * covered by the error page ([BrowserFailurePage]), whose Try Again loads
 * the address that failed; with no way to route it (no connection, a
 * WebView without proxy support) no page is made at all. Its buttons are
 * [BrowserControls] over the same [state], in whichever bar holds them.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun BrowserView(
    state: BrowserState,
    prepare: suspend () -> BrowserPage,
    computer: String,
    modifier: Modifier = Modifier,
    /** The agent connection's link, so a page that failed for want of it opens again when it is back. */
    agentStatus: AgentLinkStatus? = null,
    /** A page to open on a screen of its own: a link from an artifact's page to another origin, or a new window. */
    onOpenElsewhere: (String) -> Unit = {},
    /**
     * An artifact's share link (`https://link.happy.page/#1/<instanceId>/artifacts/<id>`,
     * [com.slopus.happy.agent.HappyShareLinks]), what sharing a bundled
     * artifact's page shares and copies; null where its server has no
     * instance id, and then neither is offered.
     */
    artifactLink: (artifactId: String) -> String? = { null },
    /**
     * The page runs as an app ([BrowserAppMode]): edge to edge, never
     * pulled to reload, and back is its host's, never the page's history.
     */
    app: BrowserAppMode? = null,
) {
    state.artifactLink = artifactLink
    val colors = HappyTheme.colors
    var pageSession by remember { mutableStateOf<BrowserProxy.Page?>(null) }
    var unsupported by remember { mutableStateOf(false) }
    val unsupportedText = stringResource(R.string.browser_unsupported)
    val elsewhere by rememberUpdatedState(onOpenElsewhere)
    val device = remember { BrowserDevice() }
    BrowserDeviceHost(device)
    val link = BrowserLink.of(agentStatus, rememberNetworkAvailable())
    LaunchedEffect(link) { state.linkChanged(link) }
    // A load that waits on a network the phone hasn't got would only time out a minute later.
    val waitsOnNoNetwork = link == BrowserLink.NoNetwork && state.progress.phase == BrowserProgress.Phase.Loading
    LaunchedEffect(waitsOnNoNetwork) {
        if (!waitsOnNoNetwork) return@LaunchedEffect
        delay(BrowserState.OFFLINE_GRACE_MILLIS)
        state.offline()
    }

    LaunchedEffect(state.attempt) {
        if (state.page != null) {
            if (unsupported) state.fail(BrowserProblem.Other(unsupportedText), null)
            return@LaunchedEffect
        }
        // The connect is part of the load: the bar starts now.
        state.begin()
        state.page = try {
            prepare()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            state.fail(BrowserProblem.opening(e, state.link), null)
            null
        }
    }
    val shown = state.page
    // A server whose edge refuses tunnels (edge SSO): no page can load through it; say why instead.
    val noTunnels = stringResource(R.string.browser_tunnels_blocked)
    LaunchedEffect(shown) {
        shown?.scope?.client?.tunnelsBlocked?.collect { blocked ->
            state.blocked = blocked
            if (blocked) state.fail(BrowserProblem.Other(noTunnels), null)
        }
    }
    LaunchedEffect(shown) {
        shown ?: return@LaunchedEffect
        // A profile of its own where WebView has them: its own cookies, storage and proxy credential.
        val opened = Browser.proxy.open(shown.scope, isolated = WebViewProfiles.supported)
        var acquired = false
        try {
            // Applied before the page loads: nothing may go direct, even once.
            acquired = WebViewProxyOverride.acquire(Browser.proxy.port)
            if (acquired) {
                state.refusals = opened.refusals
                pageSession = opened
            } else {
                unsupported = true
                state.fail(BrowserProblem.Other(unsupportedText), null)
            }
            awaitCancellation()
        } finally {
            pageSession = null
            state.refusals = null
            opened.close()
            if (acquired) WebViewProxyOverride.release()
            if (shown.synthetic) {
                val origin = Uri.parse(shown.url).let { "${it.scheme}://${it.host}" }
                runCatching { WebStorage.getInstance().deleteOrigin(origin) }
            }
        }
    }
    LaunchedEffect(state.progress.phase == BrowserProgress.Phase.Loading) {
        if (state.progress.phase != BrowserProgress.Phase.Loading) return@LaunchedEffect
        while (true) {
            delay(BrowserProgress.TRICKLE_MILLIS)
            state.trickle()
        }
    }

    val started = pageStarted()
    DisposableEffect(pageSession, state.generation, started) {
        val view = state.web
        if (started) view?.onResume() else view?.onPause()
        onDispose { view?.onPause() }
    }

    PageBackHandler(enabled = app == null && state.takesBack && started) { state.goBack() }

    // The WebView is see-through: WebView takes its background only once, so what is under the page is drawn here.
    Box(modifier.fillMaxSize().background(if (state.bare) Color.White else colors.surface).testTag(BrowserTags.BROWSER)) {
        val session = pageSession
        if (shown != null && session != null) {
            key(state.generation) {
                AndroidView(
                    factory = { ctx ->
                        // Before anything else touches it: the profile is fixed at first use.
                        val web = themedWebView(ctx, Color.Transparent, colors.dark) { if (session.isolated) WebViewProfiles.assign(this) }.apply {
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.allowFileAccess = false
                            settings.allowContentAccess = false
                            // New windows become screens of their own (onCreateWindow).
                            settings.setSupportMultipleWindows(true)
                            webChromeClient = BrowserChromeClient(state, device) { elsewhere(it) }
                            webViewClient = BrowserClient(
                                page = shown,
                                state = state,
                                credentials = if (session.isolated) session.username to session.password else Browser.proxy.webUsername to Browser.proxy.webPassword,
                                onElsewhere = { elsewhere(it) },
                                app = app,
                            )
                            app?.prepare(this, shown.url)
                        }
                        SwipeRefreshLayout(ctx).apply {
                            setColorSchemeColors(colors.text.toArgb())
                            setProgressBackgroundColorSchemeColor(colors.surfaceHigh.toArgb())
                            isEnabled = app == null
                            setOnRefreshListener {
                                state.refreshing = true
                                state.pulled()
                            }
                            // Matching its parent, never wrapping its content: WebView gives a page whose height wraps no viewport, so vh, svh and dvh are 0.
                            addView(web, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                            state.web = web
                            state.load(state.opening() ?: shown.url, web)
                        }
                    },
                    update = { layout -> if (layout.isRefreshing != state.refreshing) layout.isRefreshing = state.refreshing },
                    onRelease = { layout ->
                        val view = layout.getChildAt(1) as? WebView ?: layout.getChildAt(0) as? WebView
                        if (view != null) {
                            view.stopLoading()
                            val profile = WebViewProfiles.of(view)
                            if (state.web === view) state.web = null
                            app?.released(view)
                            view.destroy()
                            profile?.let(WebViewProfiles::delete)
                        }
                    },
                    modifier = Modifier.fillMaxSize().then(if (app == null) Modifier.windowInsetsPadding(WindowInsets.navigationBars) else Modifier).testTag(BrowserTags.WEB),
                )
            }
        }
        val problem = state.problem
        val failure = remember { arrayOf<BrowserProblem?>(null) }
        if (problem != null) failure[0] = problem
        AnimatedVisibility(
            visible = problem != null,
            enter = fadeIn(tween(BrowserSpec.FAILURE_FADE_MILLIS)),
            exit = ExitTransition.None,
        ) {
            failure[0]?.let {
                BrowserFailurePage(
                    problem = it,
                    computer = computer,
                    host = BrowserState.address(state.failedUrl),
                    onRetry = state::retry,
                    modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.navigationBars),
                )
            }
        }
        BrowserProgressBar(state.progress, onFaded = state::faded, modifier = Modifier.align(Alignment.TopStart))
        state.cantOpen?.let { refused ->
            val (title, message) = browserProblemWords(refused, computer, null)
            HappyAlert(Alert(title, message, listOf(AlertButton(stringResource(R.string.common_ok)))), onDismiss = { state.cantOpen = null })
        }
    }
}

/** Whether the phone has a network at all (iOS's `LinkState.waitingForNetwork`, inverted), following changes. */
@Composable
internal fun rememberNetworkAvailable(): Boolean {
    val context = LocalContext.current
    val manager = remember(context) { context.getSystemService(ConnectivityManager::class.java) }
    fun reaches(capabilities: NetworkCapabilities?) = capabilities != null &&
        capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    var available by remember(manager) {
        mutableStateOf(manager == null || runCatching { reaches(manager.getNetworkCapabilities(manager.activeNetwork)) }.getOrDefault(true))
    }
    DisposableEffect(manager) {
        // A network that is up but reaches nothing (the radio on, no data) is no network.
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                available = reaches(capabilities)
            }

            override fun onLost(network: Network) {
                available = false
            }
        }
        val registered = manager != null && runCatching { manager.registerDefaultNetworkCallback(callback, Handler(Looper.getMainLooper())) }.isSuccess
        onDispose { if (registered) runCatching { manager?.unregisterNetworkCallback(callback) } }
    }
    return available
}

/** [url] as the bar shows it: `https://` and a lone trailing slash dropped; plain `http://` kept, so it shows. */
fun displayUrl(url: String): String = url.removePrefix("https://").let { if (it.count { c -> c == '/' } == 1 && it.endsWith("/")) it.dropLast(1) else it }

/**
 * Hands [url] to whatever on the phone opens it (a `mailto:`, `tel:`, or
 * the outside browser on request); false when nothing does. A Happy Agent
 * URL ([HappyUrls]) never leaves the app: it is the app's own to open, or nothing's.
 */
internal fun openOutside(context: Context, url: String): Boolean = if (com.slopus.happy.agent.HappyUrls.owns(url)) true else try {
    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    true
} catch (_: ActivityNotFoundException) {
    false
} catch (_: SecurityException) {
    false
}

/**
 * The page's client: the proxy's challenge answered with the page's
 * [credentials] (its own in a profile of its own, else the WebViews' shared
 * one) and nothing else's; a scheme that isn't web handed to the system on
 * a tap; on an artifact's page, a tapped link to another origin opened in a
 * browser of its own, as iOS does; and every load's start, end and failure
 * told to [state]. A Happy URL tapped on an artifact's page opens in the app,
 * and a link.happy.page share link tapped on any page does too.
 */
private class BrowserClient(
    private val page: BrowserPage,
    private val state: BrowserState,
    private val credentials: Pair<String, String>,
    private val onElsewhere: (String) -> Unit,
    private val app: BrowserAppMode? = null,
) : WebViewClient() {
    private var answered = 0

    override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String?, realm: String?) {
        val loopback = host == "127.0.0.1" || host == "localhost" || host?.startsWith("127.0.0.1:") == true
        if (loopback && realm == "Happy" && answered < 8) {
            answered++
            handler.proceed(credentials.first, credentials.second)
        } else {
            handler.cancel()
        }
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        if (BrowserPolicy.isInPage(url)) return false
        // A share link tapped on any page opens in the app as the Happy URL it carries (desktop 5a4c075c).
        if (request.isForMainFrame && com.slopus.happy.agent.HappyShareLinks.parse(url) != null) {
            if (request.hasGesture()) onElsewhere(url)
            return true
        }
        // A Happy URL followed in an artifact's page opens in the app (desktop 1ff04853, c6e1caad);
        // a scripted navigation to one, or one on any other page, opens nothing.
        if (com.slopus.happy.agent.HappyUrls.owns(url)) {
            if (page.artifactId != null && request.hasGesture()) onElsewhere(url)
            return true
        }
        if (BrowserPolicy.route(url) == BrowserPolicy.Route.System) {
            val nothingShown = view.copyBackForwardList().size == 0
            if (request.isForMainFrame && (request.hasGesture() || nothingShown) && !openOutside(view.context, url)) {
                // A link to an app nothing opens: the error page when it was all there was to show, else asked over the page.
                val problem = BrowserProblem.Unsupported(request.url.scheme.orEmpty())
                if (nothingShown) state.fail(problem, url) else state.cantOpen = problem
            }
            return true
        }
        if (page.artifactId != null && request.isForMainFrame && request.hasGesture() &&
            BrowserPolicy.Authority.of(url) != BrowserPolicy.Authority.of(page.url)
        ) {
            onElsewhere(url)
            return true
        }
        return false
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) = state.started(url)

    /** Once the page's first frame is up: what shows under it ([ground]). */
    override fun onPageCommitVisible(view: WebView, url: String?) {
        app?.loaded(view)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.VISUAL_STATE_CALLBACK)) {
            WebViewCompat.postVisualStateCallback(view, 0) { ground(view) }
        } else {
            ground(view)
        }
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) = state.navigation()

    override fun onPageFinished(view: WebView, url: String?) {
        app?.loaded(view)
        state.finished()
        ground(view)
    }

    /**
     * What shows under the page ([BrowserState.bare]). Until it has drawn,
     * the theme's colour, never WebView's white. A page that paints its own
     * background, or takes a dark one from `color-scheme`, covers it either
     * way; one with neither was made on white, so it gets white, as in any
     * browser.
     */
    private fun ground(view: WebView) {
        view.evaluateJavascript(BARE_PAGE) { bare -> if (state.web === view) state.bare = bare == "true" }
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) state.failed(error.errorCode, error.description?.toString().orEmpty(), request.url.toString())
    }

    /**
     * An error status for the page itself. Its body can't be read here; as
     * Telegram's BotWebViewContainer (onReceivedHttpError) reads it, a
     * response with no type has nothing to show, and neither has one whose
     * length is 0.
     */
    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
        if (!request.isForMainFrame) return
        val headers = response.responseHeaders.orEmpty().mapKeys { it.key.lowercase() }
        val hasBody = !response.mimeType.isNullOrEmpty() && headers["content-length"]?.trim() != "0"
        state.answered(response.statusCode, headers["x-happy-proxy-error"], hasBody, response.reasonPhrase, request.url.toString())
    }

    /**
     * The renderer stopped. Telegram's BotWebViewContainer (onRenderProcessGone)
     * keeps the app alive by answering true; the dead WebView is replaced by
     * a new one, quietly once, as iOS reloads once.
     */
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        if (state.web === view) state.crashed()
        return true
    }
}

/**
 * The page's chrome client: progress and title to [state], and a window
 * the page opens from a tap ([onWindow]) as a browser screen of its own, as
 * iOS's `createWebViewWith` pushes one. WebView needs a WebView to put the
 * window in; as Telegram's BotWebViewContainer (onCreateWindow) does, a
 * throwaway one takes its first navigation's address and loads nothing.
 */
private class BrowserChromeClient(private val state: BrowserState, private val device: BrowserDevice, private val onWindow: (String) -> Unit) : WebChromeClient() {
    override fun onProgressChanged(view: WebView, newProgress: Int) = state.estimate(newProgress / 100f)

    override fun onReceivedTitle(view: WebView, title: String?) = state.title(title)

    override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams): Boolean =
        device.choose(filePathCallback, fileChooserParams)

    override fun onPermissionRequest(request: PermissionRequest) = device.permission(request)

    override fun onPermissionRequestCanceled(request: PermissionRequest) = device.canceled(request)

    override fun onShowCustomView(view: View, callback: CustomViewCallback) {
        device.fullscreen?.second?.onCustomViewHidden()
        device.fullscreen = view to callback
    }

    override fun onHideCustomView() {
        device.fullscreen = null
    }

    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
        if (!isUserGesture) return false
        val window = WebView(view.context)
        // A window must be in its opener's profile.
        WebViewProfiles.of(view)?.let { runCatching { WebViewCompat.setProfile(window, it) } }
        var done = false
        fun close() {
            if (done) return
            done = true
            window.post { window.destroy() }
        }
        window.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (BrowserPolicy.route(url) == BrowserPolicy.Route.Web) onWindow(url)
                close()
                return true
            }
        }
        // A window that never navigates (window.open() and a script) is dropped.
        view.postDelayed({ close() }, 10_000)
        (resultMsg.obj as WebView.WebViewTransport).webView = window
        resultMsg.sendToTarget()
        return true
    }
}

/**
 * True when the page paints no background of its own (the root and body
 * transparent) and asks for no dark one (`color-scheme`, as CSS or meta):
 * a page made on white.
 */
internal const val BARE_PAGE = """(function() {
  var root = document.documentElement, body = document.body;
  function clear(e) { var c = e ? getComputedStyle(e).backgroundColor : ''; return !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)'; }
  var meta = document.querySelector('meta[name="color-scheme"]');
  var scheme = getComputedStyle(root).colorScheme + ' ' + (meta ? meta.content : '');
  return clear(root) && clear(body) && scheme.indexOf('dark') < 0;
})()"""
