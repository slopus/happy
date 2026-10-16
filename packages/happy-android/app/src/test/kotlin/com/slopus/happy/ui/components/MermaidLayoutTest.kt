package com.slopus.happy.ui.components

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.MarkdownTags
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper

/**
 * MermaidRenderer.tsx on native: a WebView loading mermaid@11, full width
 * with 8 above and below, radius 8 on surfaceHighest, 200 high until the
 * page posts `{type: "dimensions", height}`, then the tallest height
 * reported, capped at 600. Where there is no WebView (Robolectric) the
 * diagram stays a "mermaid" code block.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class MermaidLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val diagram = "graph TD\n  A-->B"

    @Test
    fun robolectricFallsBackToTheCodeBlock() {
        rule.setHappyContent { MarkdownView(parseMarkdown("```mermaid\n$diagram\n```"), Modifier.fillMaxWidth()) }
        rule.node(MarkdownTags.CODE_BLOCK).assertExists()
        rule.node(MermaidTags.DIAGRAM).assertDoesNotExist()
        rule.onNode(hasText("mermaid"), useUnmergedTree = true).assertExists()
    }

    @Test
    fun webViewStartsAt200AndGrowsToTheReportedHeight() {
        var root: View? = null
        rule.setHappyContent {
            root = LocalView.current
            CompositionLocalProvider(LocalMermaidWebView provides true) {
                MarkdownView(parseMarkdown("```mermaid\n$diagram\n```"), Modifier.fillMaxWidth())
            }
        }
        rule.node(MarkdownTags.CODE_BLOCK).assertDoesNotExist()
        assertBox("diagram", rule.node(MermaidTags.DIAGRAM).bounds, 0.dp, 8.dp, 411.dp, 200.dp)

        val web = findWebView(root!!.rootView)
        assertNotNull("a WebView", web)
        val shadow = shadowOf(web!!)
        val page = shadow.lastLoadDataWithBaseURL.data
        assertTrue(page.contains(MermaidSpec.MERMAID_URL))
        assertTrue(page.contains("\"graph TD\\n  A-->B\""))
        val bridge = shadow.getJavascriptInterface("ReactNativeWebView") as MermaidBridge

        bridge.postMessage("""{"type":"dimensions","height":320}""")
        settle()
        assertBox("reported", rule.node(MermaidTags.DIAGRAM).bounds, 0.dp, 8.dp, 411.dp, 320.dp)

        // A later, smaller report doesn't shrink it.
        bridge.postMessage("""{"type":"dimensions","height":250}""")
        settle()
        assertBox("kept", rule.node(MermaidTags.DIAGRAM).bounds, 0.dp, 8.dp, 411.dp, 320.dp)

        bridge.postMessage("""{"type":"dimensions","height":2000}""")
        settle()
        assertBox("capped", rule.node(MermaidTags.DIAGRAM).bounds, 0.dp, 8.dp, 411.dp, 600.dp)
    }

    @Test
    fun heightMessages() {
        assertEquals(412, parseMermaidHeight("""{"type":"dimensions","height":412}"""))
        assertNull(parseMermaidHeight("""{"type":"dimensions","height":0}"""))
        assertNull(parseMermaidHeight("""{"type":"error","height":10}"""))
        assertNull(parseMermaidHeight("""{"type":"dimensions"}"""))
        assertNull(parseMermaidHeight("not json"))
        assertNull(parseMermaidHeight("[1]"))
    }

    @Test
    fun pageEmbedsTheDiagramSafely() {
        val page = mermaidHtml("graph TD\n  A[\"</script><b>\"]-->B", dark = true, background = Color(0xFF282828))
        assertFalse("no raw </script> from the diagram", page.contains("</script><b>"))
        assertTrue(page.contains("const content = \"graph TD\\n  A[\\\"\\u003c/script>\\u003cb>\\\"]-->B\";"))
        assertTrue(page.contains("theme: 'dark'"))
        assertTrue(page.contains("background-color: #282828;"))
        assertTrue(page.contains("window.ReactNativeWebView.postMessage"))

        val light = mermaidHtml("graph LR", dark = false, background = Color(0xFFF0F0F0))
        assertTrue(light.contains("theme: 'default'"))
        assertTrue(light.contains("background-color: #F0F0F0;"))
    }

    private fun settle() {
        ShadowLooper.idleMainLooper()
        rule.waitForIdle()
    }

    private fun findWebView(view: View): WebView? = when (view) {
        is WebView -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
        else -> null
    }
}
