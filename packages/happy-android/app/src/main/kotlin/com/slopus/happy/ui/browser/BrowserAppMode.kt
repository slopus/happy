package com.slopus.happy.ui.browser

import android.annotation.SuppressLint
import android.net.Uri
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.compose.runtime.Stable
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlin.math.roundToInt

/**
 * A page shown as an app (an artifact's `happy-page-mode: app`, task_206's
 * fullscreen-spec.md): the host's part inside the WebView. The page fills
 * its place and never scrolls, zooms, selects or bounces; its root carries
 * `data-happy-page-mode="app"`; no host inset (`--happy-host-page-inset: 0`,
 * no padding on the root or body); and it reads the room it must keep clear as
 * `--happy-app-inset-top|right|bottom|left` in CSS pixels (a dp each, as
 * WebView lays a page out here): the window's unsafe sides, and on top the
 * host's close button too. Set [insets] when they change; the page hears it.
 */
@Stable
class BrowserAppMode {
    /** The insets as the page reads them, JSON in CSS pixels. Read off the main thread by the bridge. */
    @Volatile private var json: String = insetsJson(0f, 0f, 0f, 0f)
    private var web: WebView? = null

    /** The room the page keeps clear, in dp. */
    fun insets(top: Float, right: Float, bottom: Float, left: Float) {
        val next = insetsJson(top, right, bottom, left)
        if (next == json) return
        json = next
        web?.evaluateJavascript(RELOAD_INSETS, null)
    }

    /** Makes [web], new and untouched, an app's WebView, before it loads [url]. */
    @SuppressLint("JavascriptInterface")
    internal fun prepare(web: WebView, url: String) {
        this.web = web
        web.settings.setSupportZoom(false)
        web.settings.builtInZoomControls = false
        web.settings.displayZoomControls = false
        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.isVerticalScrollBarEnabled = false
        web.isHorizontalScrollBarEnabled = false
        // No selection, callout or link preview on a long press: the page has its touches whole.
        web.isLongClickable = false
        web.isHapticFeedbackEnabled = false
        web.setOnLongClickListener { true }
        web.addJavascriptInterface(Bridge(), BRIDGE)
        // Before the page's own styles and scripts, where WebView can; else once each document has started.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            val origin = Uri.parse(url).let { "${it.scheme}://${it.authority}" }
            runCatching { WebViewCompat.addDocumentStartJavaScript(web, SCRIPT, setOf(origin)) }
        }
    }

    /** A document has started or finished: the script again, which does nothing twice. */
    internal fun loaded(web: WebView) = web.evaluateJavascript(SCRIPT, null)

    internal fun released(web: WebView) {
        if (this.web === web) this.web = null
    }

    /** What the page may ask the host: the insets, and nothing else. */
    private inner class Bridge {
        @JavascriptInterface
        fun insets(): String = json
    }

    companion object {
        private const val BRIDGE = "happyAppHost"
        private const val RELOAD_INSETS = "window.__happyAppInsets && window.__happyAppInsets()"

        internal fun insetsJson(top: Float, right: Float, bottom: Float, left: Float): String =
            """{"top":${px(top)},"right":${px(right)},"bottom":${px(bottom)},"left":${px(left)}}"""

        private fun px(dp: Float): Float = (dp * 100).roundToInt() / 100f

        /**
         * The host's stylesheet first in the document, so the page's own
         * rules of equal weight come after it: the root and body fill the
         * page and never scroll or bounce (those two kept over the page's
         * own), text isn't selected but in fields, no tap flash; then the
         * attribute and the insets. Once per document.
         */
        internal const val SCRIPT = """(() => {
  if (window.__happyAppInsets) { window.__happyAppInsets(); return; }
  const sheet = document.createElement('style');
  sheet.setAttribute('data-happy-host', 'app');
  sheet.textContent = 'html, body { height: 100%; margin: 0; overflow: hidden !important; overscroll-behavior: none !important; }' +
    ' :where(html) { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }' +
    ' :where(input, textarea, [contenteditable], [contenteditable] *) { -webkit-user-select: text; user-select: text; }';
  const insets = document.createElement('style');
  insets.setAttribute('data-happy-host', 'app-insets');
  const read = () => {
    try {
      const v = JSON.parse($BRIDGE.insets());
      insets.textContent = ':root { --happy-host-page-inset: 0px; --happy-page-inset: 0px; --happy-app-inset-top: ' + v.top + 'px; --happy-app-inset-right: ' + v.right + 'px; --happy-app-inset-bottom: ' + v.bottom + 'px; --happy-app-inset-left: ' + v.left + 'px; }';
    } catch (e) {}
  };
  window.__happyAppInsets = read;
  read();
  const apply = (root) => {
    root.setAttribute('data-happy-page-mode', 'app');
    root.prepend(sheet, insets);
  };
  if (document.documentElement) apply(document.documentElement);
  else new MutationObserver((_, watch) => {
    if (!document.documentElement) return;
    watch.disconnect();
    apply(document.documentElement);
  }).observe(document, { childList: true });
})()"""
    }
}
