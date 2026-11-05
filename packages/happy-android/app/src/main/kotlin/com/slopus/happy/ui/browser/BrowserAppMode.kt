package com.slopus.happy.ui.browser

import android.net.Uri
import android.view.View
import android.webkit.WebView
import androidx.compose.runtime.Stable
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.slopus.happy.artifacts.AppClose
import kotlin.math.roundToInt

/**
 * A page shown as an app (an artifact's `happy-page-mode: app`, task_206's
 * fullscreen-spec.md): the host's part inside the WebView. The page fills
 * its place and never scrolls, zooms, selects or bounces; its root carries
 * `data-happy-page-mode="app"` and `data-happy-app-close`; no host inset
 * (`--happy-host-page-inset: 0`, no padding on the root or body); it reads
 * the room it must keep clear as `--happy-app-inset-top|right|bottom|left`
 * and the close button's box as `--happy-app-close-x|y|width|height`, in
 * CSS pixels (a dp each, as WebView lays a page out here); and
 * `happyApp.close()` asks [onClose], from the page's own origin and main
 * frame alone. Set [layout] when the window changes; the page hears it.
 */
@Stable
class BrowserAppMode(private val close: AppClose, private val onClose: () -> Unit) {
    private var values: Values = Values(close.value, Sides(0f, 0f, 0f, 0f), null)
    private var web: WebView? = null
    private var origin: String? = null
    private var started: ScriptHandler? = null

    /** The room the page keeps clear, in dp; the close button's box, in dp, where there is one. */
    fun layout(insets: Sides, button: Box?) {
        val next = Values(close.value, insets, button)
        if (next == values) return
        values = next
        val web = web ?: return
        // The next document starts with them, and the one shown takes them now.
        registerStart(web)
        web.evaluateJavascript(script(values), null)
    }

    /** Makes [web], new and untouched, an app's WebView, before it loads [url]. */
    internal fun prepare(web: WebView, url: String) {
        this.web = web
        val origin = Uri.parse(url).let { "${it.scheme}://${it.authority}" }
        this.origin = origin
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
        // Only the page's own origin gets the bridge; a frame of another never sees it.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            runCatching {
                WebViewCompat.addWebMessageListener(web, BRIDGE, setOf(origin)) { _: WebView, message: WebMessageCompat, source: Uri, mainFrame: Boolean, _: JavaScriptReplyProxy ->
                    if (accepts(origin, source.toString(), mainFrame, message.data)) onClose()
                }
            }
        }
        registerStart(web)
    }

    /** Before the page's own styles and scripts, where WebView can; else once each document has started ([loaded]). */
    private fun registerStart(web: WebView) {
        val origin = origin ?: return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        started?.remove()
        started = runCatching { WebViewCompat.addDocumentStartJavaScript(web, script(values), setOf(origin)) }.getOrNull()
    }

    /** A document has started or finished: the script again, which sets up nothing twice. */
    internal fun loaded(web: WebView) = web.evaluateJavascript(script(values), null)

    internal fun released(web: WebView) {
        if (this.web !== web) return
        this.web = null
        started = null
    }

    /** Four sides, in dp. */
    data class Sides(val top: Float, val right: Float, val bottom: Float, val left: Float)

    /** A box in the page's viewport, in dp. */
    data class Box(val x: Float, val y: Float, val width: Float, val height: Float)

    internal data class Values(val close: String, val insets: Sides, val button: Box?)

    companion object {
        /** The object `addWebMessageListener` puts in the page's origin; `happyApp.close()` posts through it. */
        private const val BRIDGE = "happyAppHost"

        /** Whether a message from [source] closes the app shown at [origin]: its main frame alone, and only "close". */
        internal fun accepts(origin: String, source: String, mainFrame: Boolean, data: String?): Boolean =
            mainFrame && source.trimEnd('/') == origin && data == "close"

        private fun px(dp: Float): String = "${(dp * 100).roundToInt() / 100f}px"

        /**
         * The page's side, every time with the latest [values]: once per
         * document, the host's stylesheet first in it (the root and body
         * fill the page and never scroll or bounce, those two kept over the
         * page's own; text isn't selected but in fields; no tap flash), the
         * close box registered as lengths, and `happyApp`; then, each time,
         * the attributes and the properties.
         */
        internal fun script(values: Values): String {
            val (top, right, bottom, left) = values.insets
            val box = values.button ?: Box(0f, 0f, 0f, 0f)
            val properties = listOf(
                "--happy-host-page-inset" to "0px",
                "--happy-page-inset" to "0px",
                "--happy-app-inset-top" to px(top),
                "--happy-app-inset-right" to px(right),
                "--happy-app-inset-bottom" to px(bottom),
                "--happy-app-inset-left" to px(left),
                "--happy-app-close-x" to px(box.x),
                "--happy-app-close-y" to px(box.y),
                "--happy-app-close-width" to px(box.width),
                "--happy-app-close-height" to px(box.height),
            ).joinToString(" ") { (name, value) -> "$name: $value;" }
            return """(() => {
  let host = window.__happyApp;
  if (!host) {
    const sheet = document.createElement('style');
    sheet.setAttribute('data-happy-host', 'app');
    sheet.textContent = 'html, body { height: 100%; margin: 0; overflow: hidden !important; overscroll-behavior: none !important; }' +
      ' :where(html) { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }' +
      ' :where(input, textarea, [contenteditable], [contenteditable] *) { -webkit-user-select: text; user-select: text; }';
    const values = document.createElement('style');
    values.setAttribute('data-happy-host', 'app-values');
    for (const side of ['x', 'y', 'width', 'height']) {
      try { CSS.registerProperty({ name: '--happy-app-close-' + side, syntax: '<length>', inherits: true, initialValue: '0px' }); } catch (e) {}
    }
    const bridge = window.$BRIDGE;
    Object.defineProperty(window, 'happyApp', { value: Object.freeze({ close() { if (bridge) bridge.postMessage('close'); } }) });
    host = window.__happyApp = { sheet, values };
  }
  const apply = (root) => {
    root.setAttribute('data-happy-page-mode', 'app');
    root.setAttribute('data-happy-app-close', '${values.close}');
    host.values.textContent = ':root { $properties }';
    if (!host.sheet.isConnected) root.prepend(host.sheet, host.values);
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
}
