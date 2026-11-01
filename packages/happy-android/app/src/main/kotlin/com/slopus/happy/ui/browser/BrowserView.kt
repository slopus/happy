package com.slopus.happy.ui.browser

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.HttpAuthHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import com.slopus.happy.ui.components.PageBackHandler as BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import com.slopus.happy.R
import com.slopus.happy.browser.Browser
import com.slopus.happy.browser.BrowserPolicy
import com.slopus.happy.browser.BrowserProxy
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.themedWebView
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import java.util.UUID
import java.util.concurrent.Executor

object BrowserTags {
    const val BROWSER = "browser"
    const val WEB = "browser.web"
    const val ROUTE = "browser.route"
    const val ERROR = "browser.error"
    const val BACK = "browser.back"
    const val FORWARD = "browser.forward"
    const val RELOAD = "browser.reload"
    const val SHARE = "browser.share"
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
 * The in-app browser (iOS's `BrowserViewController`): a page that reaches
 * everything through the computer, never the phone's network. A 2 dp
 * progress line, "via <computer>" under it, the page, and a toolbar with
 * back, forward, reload and share. A page that can't be reached says so in
 * place and Reload tries again; with no way to route it (a WebView without
 * proxy support, no connection) no page is made at all.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun BrowserView(
    prepare: suspend () -> BrowserPage,
    computer: String,
    modifier: Modifier = Modifier,
    onTitle: (String) -> Unit = {},
    /** A link the page opens to another origin, from an artifact's page; iOS pushes a browser of its own. */
    onOpenElsewhere: (String) -> Unit = {},
    /** The page's address, each time it changes. */
    onUrl: (String) -> Unit = {},
) {
    val colors = HappyTheme.colors
    val context = LocalContext.current
    val unreachable = stringResource(R.string.browser_unreachable, computer)
    val unreachablePage = stringResource(R.string.browser_unreachable_page, computer)
    val unsupported = stringResource(R.string.browser_unsupported)
    var attempt by remember { mutableIntStateOf(0) }
    var page by remember { mutableStateOf<BrowserPage?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var ready by remember { mutableStateOf(false) }
    var progress by remember { mutableFloatStateOf(0f) }
    var canGoBack by remember { mutableStateOf(false) }
    var canGoForward by remember { mutableStateOf(false) }
    var web by remember { mutableStateOf<WebView?>(null) }
    var pageSession by remember { mutableStateOf<BrowserProxy.Page?>(null) }
    val title by rememberUpdatedState(onTitle)
    val elsewhere by rememberUpdatedState(onOpenElsewhere)
    val urlChanged by rememberUpdatedState(onUrl)

    LaunchedEffect(attempt) {
        if (page != null) return@LaunchedEffect
        failure = null
        page = try {
            prepare()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            failure = unreachable
            null
        }
    }
    val shown = page
    LaunchedEffect(shown) {
        shown ?: return@LaunchedEffect
        // A profile of its own where WebView has them: its own cookies, storage and proxy credential.
        val opened = Browser.proxy.open(shown.scope, isolated = WebViewProfiles.supported)
        var acquired = false
        try {
            // Applied before the page loads: nothing may go direct, even once.
            acquired = WebViewProxyOverride.acquire(Browser.proxy.port)
            if (acquired) {
                pageSession = opened
                ready = true
            } else {
                failure = unsupported
            }
            awaitCancellation()
        } finally {
            ready = false
            pageSession = null
            opened.close()
            if (acquired) WebViewProxyOverride.release()
            if (shown.synthetic) {
                val origin = Uri.parse(shown.url).let { "${it.scheme}://${it.host}" }
                runCatching { WebStorage.getInstance().deleteOrigin(origin) }
            }
        }
    }

    val started = com.slopus.happy.ui.components.pageStarted()
    androidx.compose.runtime.DisposableEffect(web, started) {
        val view = web
        if (started) view?.onResume() else view?.onPause()
        onDispose { view?.onPause() }
    }

    BackHandler(enabled = canGoBack && started) { web?.goBack() }

    Column(modifier.fillMaxSize().background(colors.surface).testTag(BrowserTags.BROWSER)) {
        Box(Modifier.fillMaxWidth().height(2.dp)) {
            if (ready && progress < 1f) LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxSize(), color = colors.text, trackColor = colors.surface)
        }
        Text(
            stringResource(R.string.browser_via, computer),
            style = happyTextStyle(fontSize = 12, lineHeight = 16),
            color = colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().height(24.dp).padding(top = 4.dp).testTag(BrowserTags.ROUTE),
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            val session = pageSession
            if (ready && shown != null && session != null) {
                AndroidView(
                    factory = { ctx ->
                        // Before anything else touches it: the profile is fixed at first use.
                        themedWebView(ctx, colors.surface, colors.dark) { if (session.isolated) WebViewProfiles.assign(this) }.apply {
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.allowFileAccess = false
                            settings.allowContentAccess = false
                            settings.setSupportMultipleWindows(false)
                            webChromeClient = object : WebChromeClient() {
                                override fun onProgressChanged(view: WebView, newProgress: Int) {
                                    progress = newProgress / 100f
                                }

                                override fun onReceivedTitle(view: WebView, text: String?) {
                                    if (!text.isNullOrEmpty() && !text.startsWith("http")) title(text)
                                }
                            }
                            webViewClient = BrowserClient(
                                page = shown,
                                credentials = if (session.isolated) session.username to session.password else Browser.proxy.webUsername to Browser.proxy.webPassword,
                                onState = { view ->
                                    view.url?.let(urlChanged)
                                    canGoBack = view.canGoBack()
                                    canGoForward = view.canGoForward()
                                },
                                onFailure = { failure = unreachablePage },
                                onLoaded = { failure = null },
                                onElsewhere = { elsewhere(it) },
                                themed = colors.surface.toArgb(),
                            )
                            loadUrl(shown.url)
                            web = this
                        }
                    },
                    onRelease = { view ->
                        view.stopLoading()
                        val profile = WebViewProfiles.of(view)
                        view.destroy()
                        profile?.let(WebViewProfiles::delete)
                        if (web === view) web = null
                    },
                    modifier = Modifier.fillMaxSize().testTag(BrowserTags.WEB),
                )
            }
            failure?.let { text ->
                Text(
                    text,
                    style = happyTextStyle(fontSize = 15, lineHeight = 20),
                    color = colors.text,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxSize().background(colors.surface).padding(24.dp).testTag(BrowserTags.ERROR),
                )
            }
        }
        HorizontalDivider(thickness = 0.5.dp, color = colors.divider)
        Row(
            // On the content column, its outer glyphs on the keyline as the bar's are.
            Modifier.windowInsetsPadding(WindowInsets.navigationBars).contentMaxWidth(LocalWindowLayout.current).height(50.dp).padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = { web?.goBack() }, enabled = canGoBack, modifier = Modifier.testTag(BrowserTags.BACK)) {
                Icon(MaterialSymbols.ChevronLeft, stringResource(R.string.common_back))
            }
            IconButton(onClick = { web?.goForward() }, enabled = canGoForward, modifier = Modifier.testTag(BrowserTags.FORWARD)) {
                Icon(MaterialSymbols.ChevronRight, stringResource(R.string.browser_forward))
            }
            IconButton(
                onClick = {
                    failure = null
                    val view = web
                    if (view != null) view.reload() else if (page == null) attempt++
                },
                modifier = Modifier.testTag(BrowserTags.RELOAD),
            ) {
                Icon(MaterialSymbols.Refresh, stringResource(R.string.files_reload))
            }
            ShareButton(shown, web, context)
        }
    }
}

@Composable
private fun ShareButton(page: BrowserPage?, web: WebView?, context: Context) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, enabled = page != null, modifier = Modifier.testTag(BrowserTags.SHARE)) {
            Icon(MaterialSymbols.Share, stringResource(R.string.artifact_share))
        }
        DropdownMenu(expanded = open && com.slopus.happy.ui.components.LocalPageActive.current, onDismissRequest = { open = false }) {
            val shareUrl = if (page?.artifactId == null) web?.url ?: page?.url else page.url
            DropdownMenuItem(
                text = { Text(stringResource(R.string.browser_share_link)) },
                onClick = {
                    open = false
                    // A bundled artifact's origin exists only here: its tag is what can be shared.
                    val text = if (page?.synthetic == true) "<happy-artifact id=\"${page.artifactId}\"/>" else shareUrl ?: return@DropdownMenuItem
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
                    context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                },
            )
            if (page?.synthetic != true && shareUrl != null) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.browser_open_outside)) },
                    onClick = {
                        open = false
                        openOutside(context, shareUrl)
                    },
                )
            }
        }
    }
}

/** [url] as the bar shows it: `https://` and a lone trailing slash dropped; plain `http://` kept, so it shows. */
fun displayUrl(url: String): String = url.removePrefix("https://").let { if (it.count { c -> c == '/' } == 1 && it.endsWith("/")) it.dropLast(1) else it }

/** Hands [url] to whatever on the phone opens it (a `mailto:`, `tel:`, or the outside browser on request). */
internal fun openOutside(context: Context, url: String) {
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
        // Nothing on the phone opens it.
    } catch (_: SecurityException) {
    }
}

/**
 * The page's client: the proxy's challenge answered with the page's
 * [credentials] (its own in a profile of its own, else the WebViews' shared
 * one) and nothing else's; a scheme that isn't web handed to the
 * system on a tap; and, on an artifact's page, a tapped link to another
 * origin opened in a browser of its own, as iOS does.
 */
private class BrowserClient(
    private val page: BrowserPage,
    private val credentials: Pair<String, String>,
    private val onState: (WebView) -> Unit,
    private val onFailure: () -> Unit,
    private val onLoaded: () -> Unit,
    private val onElsewhere: (String) -> Unit,
    /** The theme's colour, under a page that paints its own background. */
    private val themed: Int,
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
        if (BrowserPolicy.route(url) == BrowserPolicy.Route.System) {
            if (request.hasGesture()) openOutside(view.context, url)
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

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) = onState(view)

    /** Once the page's first frame is up: what shows under it ([ground]). */
    override fun onPageCommitVisible(view: WebView, url: String?) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.VISUAL_STATE_CALLBACK)) {
            WebViewCompat.postVisualStateCallback(view, 0) { ground(view) }
        } else {
            ground(view)
        }
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) = onState(view)

    override fun onPageFinished(view: WebView, url: String?) {
        onState(view)
        onLoaded()
        ground(view)
    }

    /**
     * What shows under the page. Until it has drawn, the theme's colour
     * (themedWebView), never WebView's white. A page that paints its own
     * background, or takes a dark one from `color-scheme`, covers it either
     * way; one with neither was made on white, so it gets white, as in any
     * browser.
     */
    private fun ground(view: WebView) {
        view.evaluateJavascript(BARE_PAGE) { bare ->
            view.setBackgroundColor(if (bare == "true") android.graphics.Color.WHITE else themed)
        }
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) onFailure()
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
