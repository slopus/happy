package com.slopus.happy.ui.components

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.intOrNull

object MermaidSpec {
    /** Before the page reports its height. */
    const val INITIAL_HEIGHT = 200

    /** Tall diagrams scroll inside a capped container instead of taking over the chat. */
    const val MAX_HEIGHT = 600
    val marginVertical = 8.dp
    val radius = 8.dp
    const val MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"
}

object MermaidTags {
    const val DIAGRAM = "markdown.mermaid"
}

/**
 * Whether diagrams render in a WebView. False where there is none to use:
 * Robolectric (which can't run the page) and devices without a WebView
 * provider; the caller's fallback (the code block) shows instead.
 */
val LocalMermaidWebView = staticCompositionLocalOf { mermaidWebViewAvailable() }

private fun mermaidWebViewAvailable(): Boolean =
    Build.FINGERPRINT != "robolectric" && runCatching { WebView.getCurrentWebViewPackage() != null }.getOrDefault(false)

/**
 * MermaidRenderer.tsx's native path: mermaid@11 from jsdelivr in a WebView
 * on the theme's surfaceHighest, the diagram centred and no wider than the
 * view. Spec: full width, 8 above and below; the box radius 8 on
 * surfaceHighest, 200 high until the page reports its height, then the
 * tallest height reported, capped at 600 (the page scrolls inside). A
 * syntax error shows inside the page, as "Diagram error: …" in red mono.
 */
@Composable
fun MermaidView(content: String, modifier: Modifier = Modifier, fallback: @Composable () -> Unit) {
    if (!LocalMermaidWebView.current) {
        fallback()
        return
    }
    val colors = HappyTheme.colors
    val background = colors.surfaceHighest
    val html = remember(content, colors.dark, background) { mermaidHtml(content, colors.dark, background) }
    var height by remember(html) { mutableIntStateOf(MermaidSpec.INITIAL_HEIGHT) }
    val onHeight by rememberUpdatedState<(Int) -> Unit>({ reported -> height = maxOf(height, reported) })
    Box(
        modifier = modifier
            .padding(vertical = MermaidSpec.marginVertical)
            .fillMaxWidth()
            .height(minOf(height, MermaidSpec.MAX_HEIGHT).dp)
            .clip(RoundedCornerShape(MermaidSpec.radius))
            .background(background)
            .testTag(MermaidTags.DIAGRAM),
    ) {
        AndroidView(
            factory = { context -> mermaidWebView(context, background) { onHeight(it) } },
            update = { view ->
                if (view.tag != html) {
                    view.tag = html
                    view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
                }
            },
            onRelease = WebView::destroy,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun mermaidWebView(context: Context, background: Color, onHeight: (Int) -> Unit) = WebView(context).apply {
    setBackgroundColor(background.toArgb())
    settings.javaScriptEnabled = true
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    // The page calls window.ReactNativeWebView.postMessage, as in happy-app.
    addJavascriptInterface(MermaidBridge(onHeight), "ReactNativeWebView")
}

/** The page's messages: `{type: "dimensions", height}` in CSS px (dp). Delivered on the main thread. */
class MermaidBridge(private val onHeight: (Int) -> Unit) {
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun postMessage(data: String) {
        val height = parseMermaidHeight(data) ?: return
        main.post { onHeight(height) }
    }
}

internal fun parseMermaidHeight(data: String): Int? {
    val message = runCatching { Json.parseToJsonElement(data) as? JsonObject }.getOrNull() ?: return null
    if ((message["type"] as? JsonPrimitive)?.content != "dimensions") return null
    return (message["height"] as? JsonPrimitive)?.intOrNull?.takeIf { it > 0 }
}

/**
 * MermaidRenderer.tsx's page. The diagram goes in as a JSON string, as
 * there; `<` is escaped too so a `</script>` in the diagram can't end the
 * script element.
 */
fun mermaidHtml(content: String, dark: Boolean, background: Color): String {
    val json = JsonPrimitive(content).toString().replace("<", "\\u003c")
    val css = "#%06X".format(background.toArgb() and 0xFFFFFF)
    return """
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script src="${MermaidSpec.MERMAID_URL}"></script>
            <style>
                body { margin: 0; padding: 16px; background-color: $css; }
                #mermaid-container { display: flex; justify-content: center; align-items: center; width: 100%; }
                #mermaid-container svg { max-width: 100%; height: auto; }
                .error { color: #ff6b6b; font-family: monospace; white-space: pre-wrap; }
            </style>
        </head>
        <body>
            <div id="mermaid-container"></div>
            <script>
                function reportHeight() {
                    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
                    if (window.ReactNativeWebView) {
                        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'dimensions', height: height }));
                    }
                }
                (async function() {
                    const content = $json;
                    const container = document.getElementById('mermaid-container');
                    try {
                        mermaid.initialize({ startOnLoad: false, theme: '${if (dark) "dark" else "default"}' });
                        const { svg } = await mermaid.render('mermaid-diagram', content);
                        container.innerHTML = svg;
                    } catch (error) {
                        container.innerHTML = '<div class="error">Diagram error: ' +
                            (error.message || String(error)).replace(/</g, '&lt;').replace(/>/g, '&gt;') +
                            '</div>';
                    }
                    requestAnimationFrame(() => { reportHeight(); setTimeout(reportHeight, 200); });
                })();
            </script>
        </body>
        </html>
    """.trimIndent()
}
