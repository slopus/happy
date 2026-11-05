package com.slopus.happy.ui.artifacts

import android.annotation.SuppressLint
import android.net.Uri
import android.view.View
import android.webkit.HttpAuthHandler
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.slopus.happy.R
import com.slopus.happy.browser.BrowserPolicy
import com.slopus.happy.browser.BrowserProxy
import com.slopus.happy.browser.browserWorkspace
import com.slopus.happy.agent.HappyUrls
import com.slopus.happy.references.References
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactPageMode
import com.slopus.happy.ui.browser.BrowserPage
import com.slopus.happy.ui.browser.WebViewProfiles
import com.slopus.happy.ui.browser.WebViewProxyOverride
import com.slopus.happy.ui.components.themedWebView
import com.slopus.happy.ui.theme.HappyColors
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.browser.Browser
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlin.math.abs
import kotlin.math.ceil

object ArtifactInlinePageTags {
    const val PAGE = "artifact.inline"
    const val WEB = "artifact.inline.web"
    /** The page's state description once it has loaded, as iOS's `artifact-inline` value. */
    const val LOADED = "loaded"
    const val UNAVAILABLE = "unavailable"
}

/**
 * A conversation's inline pages (iOS's `PageHosting`): each one's page,
 * its files read through the paired computer, the heights they measured,
 * kept for as long as the conversation so a row scrolled away and back
 * comes back at its height, and where a link a page follows goes.
 */
@Stable
class InlinePages(
    /** [artifactId]'s [page] on an origin of its own ([BrowserPage.artifact]). */
    val prepare: suspend (artifactId: String, page: References.Page) -> BrowserPage,
    /** A link tapped in a page to anywhere but its own files: a Happy URL opens in the app, anything else a browser of its own. */
    val onOpen: (String) -> Unit,
    /** Whether [artifactId]'s [page] asks to run as an app ([ArtifactPageMode]). */
    val mode: suspend (artifactId: String, page: References.Page) -> Boolean = { _, _ -> false },
) {
    private val heights = mutableStateMapOf<String, Float>()
    private val apps = mutableStateMapOf<String, Boolean>()

    /**
     * Whether [artifactId]'s [page] runs as an app, once read: then it is
     * never run inline, and its card says App and opens it.
     */
    fun isApp(artifactId: String, page: References.Page): Boolean = apps[key(artifactId, page)] == true

    /** Reads whether [page] runs as an app, once per version and entry; true when it does. */
    suspend fun readMode(artifactId: String, page: References.Page): Boolean {
        val key = key(artifactId, page)
        apps[key]?.let { return it }
        return mode(artifactId, page).also { apps[key] = it }
    }

    private fun key(artifactId: String, page: References.Page) = "$artifactId/${page.version}/${page.entry}"

    /** [artifactId]'s page's height: as it measured itself, [DEFAULT_HEIGHT] until it has. */
    fun height(artifactId: String): Dp = heights[artifactId]?.dp ?: DEFAULT_HEIGHT

    /** [artifactId]'s page measured its content [height] tall, in CSS pixels, a dp each; a change under one is none. */
    fun measured(artifactId: String, height: Float) {
        val rounded = ceil(height).coerceIn(1f, MAX_HEIGHT)
        val before = heights[artifactId] ?: DEFAULT_HEIGHT.value
        if (abs(before - rounded) >= 1f) heights[artifactId] = rounded
    }

    companion object {
        /** iOS `ChatPlanner.pageHeight`: a page that hasn't measured itself yet. */
        val DEFAULT_HEIGHT = 120.dp
        private const val MAX_HEIGHT = 4000f

        /** Pages of artifacts read through [client]'s computer. */
        fun of(client: com.slopus.happy.agent.AgentClient, onOpen: (String) -> Unit) = InlinePages(
            mode = { id, page -> ArtifactPageMode.of(ArtifactClient(client), id, page.version, page.entry) },
            prepare = { id, page ->
                BrowserPage.artifact(
                    { authority -> BrowserProxy.Scope.Artifact(client, id, page.version, authority) { client.browserWorkspace(artifactId = id) } },
                    id,
                    page.entry,
                )
            },
            onOpen = onOpen,
        )
    }
}

/**
 * An HTML artifact shown inline under its card, as desktop shows one whose
 * latest version asks for `inline_expanded` (iOS's `InlinePageView`): the
 * live page, its files read through the paired computer, see-through on the
 * conversation's own surface in its colour scheme with the host's
 * `--happy-host-*` properties set, or on the artifact's own [References.Page.background].
 * It never scrolls inside: it measures its content and grows to fit, 120
 * until it has. A new version, entry or artifact loads again in the same
 * WebView, which lives as long as the row; nothing else loads anything.
 * A page that asks to run as an app is never loaded here: once its head is
 * read ([InlinePages.readMode]) the row drops it and its card opens it.
 */
@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
@Composable
fun ArtifactInlinePage(artifactId: String, title: String, page: References.Page, pages: InlinePages, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val label = title.ifEmpty { stringResource(R.string.artifact_untitled) }
    var prepared by remember(artifactId, page.version, page.entry) { mutableStateOf<BrowserPage?>(null) }
    var state by remember(artifactId, page.version, page.entry) { mutableStateOf<String?>(null) }
    var web by remember { mutableStateOf<WebView?>(null) }
    val open by rememberUpdatedState(pages.onOpen)
    val loaded by rememberUpdatedState { state = ArtifactInlinePageTags.LOADED }
    LaunchedEffect(artifactId, page.version, page.entry) {
        prepared = try {
            // An app runs full screen, never in a chat row: the row takes this page away.
            if (pages.readMode(artifactId, page)) return@LaunchedEffect
            pages.prepare(artifactId, page)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            state = ArtifactInlinePageTags.UNAVAILABLE
            null
        }
    }
    LaunchedEffect(prepared, web) {
        val shown = prepared ?: return@LaunchedEffect
        val view = web ?: return@LaunchedEffect
        val opened = Browser.proxy.open(shown.scope, isolated = WebViewProfiles.supported)
        var acquired = false
        try {
            // Applied before the page loads: nothing may go direct, even once.
            acquired = WebViewProxyOverride.acquire(Browser.proxy.port)
            if (acquired) {
                (view.webViewClient as? InlinePageClient)?.show(
                    shown,
                    if (opened.isolated) opened.username to opened.password else Browser.proxy.webUsername to Browser.proxy.webPassword,
                )
                // The host's properties before the page's own styles read them, where WebView can.
                if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                    runCatching { WebViewCompat.addDocumentStartJavaScript(view, hostScript(colors), setOf(origin(shown.url))) }
                }
                view.loadUrl(shown.url)
            } else {
                state = ArtifactInlinePageTags.UNAVAILABLE
            }
            awaitCancellation()
        } finally {
            opened.close()
            if (acquired) WebViewProxyOverride.release()
            val origin = Uri.parse(shown.url).let { "${it.scheme}://${it.host}" }
            runCatching { WebStorage.getInstance().deleteOrigin(origin) }
        }
    }
    val background = page.background?.let(::cssColor) ?: Color.Transparent
    Box(
        modifier
            .fillMaxWidth()
            .height(pages.height(artifactId))
            .background(background)
            .semantics {
                contentDescription = label
                state?.let { stateDescription = it }
            }
            .testTag(ArtifactInlinePageTags.PAGE),
    ) {
        // Always there, so a new version never takes a view out from under the list's layout.
        AndroidView(
            factory = { ctx ->
                // Before anything else touches it: the profile is fixed at first use.
                themedWebView(ctx, Color.Transparent, colors.dark) { if (WebViewProfiles.supported) WebViewProfiles.assign(this) }.apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.allowFileAccess = false
                    settings.allowContentAccess = false
                    isVerticalScrollBarEnabled = false
                    isHorizontalScrollBarEnabled = false
                    overScrollMode = View.OVER_SCROLL_NEVER
                    addJavascriptInterface(Heights { height -> post { pages.measured(artifactId, height) } }, HEIGHT_BRIDGE)
                    webViewClient = InlinePageClient(colors, onLoaded = { loaded() }, onOpen = { open(it) })
                    web = this
                }
            },
            update = { view ->
                // The scheme as the conversation has it now, for the page loaded and the next.
                val client = view.webViewClient as? InlinePageClient
                if (client != null && client.colors != colors) {
                    client.colors = colors
                    view.evaluateJavascript(hostScript(colors), null)
                }
            },
            onRelease = { view ->
                view.stopLoading()
                val profile = WebViewProfiles.of(view)
                view.destroy()
                profile?.let(WebViewProfiles::delete)
            },
            modifier = Modifier.fillMaxSize().testTag(ArtifactInlinePageTags.WEB),
        )
    }
}

/** The height messages: plain numbers, nothing else a page can call. */
private class Heights(private val measured: (Float) -> Unit) {
    @JavascriptInterface
    fun height(value: Double) {
        if (value.isFinite() && value > 0) measured(value.toFloat())
    }
}

/**
 * The page's client: the proxy's challenge answered with the page's
 * credentials and nothing else's; the page's own files and nothing else
 * loaded, a tapped link anywhere else handed to [onOpen]; once a document
 * has loaded, the host's properties set again and its height measured.
 */
private class InlinePageClient(
    /** The conversation's colours as they are now. */
    var colors: HappyColors,
    private val onLoaded: () -> Unit,
    private val onOpen: (String) -> Unit,
) : WebViewClient() {
    private var page: BrowserPage? = null
    private var credentials: Pair<String, String>? = null
    private var answered = 0

    /** [page] is the one loaded next, its proxy answered with [credentials]. */
    fun show(page: BrowserPage, credentials: Pair<String, String>) {
        this.page = page
        this.credentials = credentials
        answered = 0
    }

    override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String?, realm: String?) {
        val loopback = host == "127.0.0.1" || host == "localhost" || host?.startsWith("127.0.0.1:") == true
        val credentials = credentials
        if (loopback && realm == "Happy" && credentials != null && answered < 8) {
            answered++
            handler.proceed(credentials.first, credentials.second)
        } else {
            handler.cancel()
        }
    }

    /** The page stays on its own files: nothing it does leaves for the network. */
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        if (BrowserPolicy.isInPage(url)) return false
        val own = page?.url ?: return true
        if (BrowserPolicy.Authority.of(url) == BrowserPolicy.Authority.of(own) && !HappyUrls.owns(url)) return false
        if (request.isForMainFrame && request.hasGesture()) onOpen(url)
        return true
    }

    override fun onPageFinished(view: WebView, url: String?) {
        if (page == null || url == "about:blank") return
        view.evaluateJavascript(hostScript(colors), null)
        view.evaluateJavascript(MEASURE_SCRIPT, null)
        onLoaded()
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean = true
}

private const val HEIGHT_BRIDGE = "happyPageHeight"

/** [url]'s origin, for a script WebView runs in it alone. */
private fun origin(url: String): String = Uri.parse(url).let { "${it.scheme}://${it.authority}" }

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` ([References.page] checked it) as a colour. */
internal fun cssColor(hex: String): Color? {
    val digits = hex.removePrefix("#")
    val full = when (digits.length) {
        3, 4 -> digits.map { "$it$it" }.joinToString("")
        6, 8 -> digits
        else -> return null
    }
    val value = full.toLongOrNull(16) ?: return null
    return if (full.length == 6) Color(0xFF000000 or value) else Color(((value and 0xFF) shl 24) or (value shr 8))
}

/**
 * The host's properties in the conversation's colours and scheme (desktop's
 * `style.css`), and no inset: the row sets the page's margins.
 */
internal fun hostScript(colors: HappyColors): String {
    fun css(color: Color): String {
        val argb = color.toArgb()
        val alpha = Math.round(((argb ushr 24) and 0xFF) / 255.0 * 100) / 100.0
        return "rgba(${(argb shr 16) and 0xFF}, ${(argb shr 8) and 0xFF}, ${argb and 0xFF}, $alpha)"
    }
    val scheme = if (colors.dark) "dark" else "light"
    val properties = listOf(
        "color-scheme" to scheme,
        "text" to css(colors.text),
        "muted" to css(colors.textSecondary),
        "faint" to css(colors.textSecondary.copy(alpha = colors.textSecondary.alpha * 0.7f)),
        "border" to css(colors.divider),
        "surface" to "transparent",
        "font" to "Roboto, system-ui, sans-serif",
        "mono" to "ui-monospace, 'Roboto Mono', monospace",
        "font-size" to "16px",
        "page-inset" to "0",
    )
    val sets = properties.joinToString("") { (name, value) -> "s.setProperty('--happy-host-$name', \"$value\");" }
    return "(() => { const s = document.documentElement.style; $sets s.colorScheme = '$scheme'; })();"
}

/**
 * Reports the content's height whenever it changes (iOS's `measureScript`):
 * the bottom of the body's last box and the body's own padding and margin,
 * which holds whether or not the page sizes its root to the frame. Once per document.
 */
private const val MEASURE_SCRIPT = """(() => {
  if (window.__happyMeasure) { window.__happyMeasure(); return; }
  let last = 0;
  const height = () => {
    const body = document.body;
    if (!body) return 0;
    let bottom = 0;
    for (const child of body.children) {
      const rect = child.getBoundingClientRect();
      if (rect.width || rect.height) bottom = Math.max(bottom, rect.bottom + window.scrollY);
    }
    const style = getComputedStyle(body);
    return Math.ceil(bottom + parseFloat(style.paddingBottom || 0) + parseFloat(style.marginBottom || 0));
  };
  const report = () => {
    const h = height();
    if (h > 0 && h !== last) { last = h; $HEIGHT_BRIDGE.height(h); }
  };
  window.__happyMeasure = report;
  const observer = new ResizeObserver(report);
  observer.observe(document.documentElement);
  if (document.body) {
    observer.observe(document.body);
    for (const child of document.body.children) observer.observe(child);
    new MutationObserver(() => { for (const child of document.body.children) observer.observe(child); report(); })
      .observe(document.body, { childList: true });
  }
  if (document.fonts) document.fonts.ready.then(report);
  report();
})()"""
