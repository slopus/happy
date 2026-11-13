package com.slopus.happy.ui.genui

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import coil3.ImageLoader
import com.slopus.happy.genui.Element
import com.slopus.happy.genui.GenUi
import com.slopus.happy.genui.RenderDocument
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.components.LocalImageLoader
import com.slopus.happy.ui.node
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.awaitCancellation
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * The spec's measuring cases (happy-agent docs/genui/render/conformance/
 * measuring.json, copied by tools/genui/sync.sh), each measured with the
 * Compose renderer under the conditions it names: pictures pending, loaded
 * or failed, light or dark, an element pressed or chosen, another host's
 * enabled actions, a scrolled carousel. Only equal heights and switch
 * branches are checked; the numbers are Android's own.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GenUiMeasuringTest(private val index: Int, private val name: String) {
    @get:Rule val rule = createComposeRule()

    companion object {
        private val cases = Json.parseToJsonElement(File("src/test/resources/genui/conformance/measuring.json").readText()).jsonObject["cases"]!!.jsonArray

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{1}")
        fun cases(): List<Array<Any>> = cases.mapIndexed { i, c -> arrayOf(i, "${c.jsonObject.string("rule")} ${c.jsonObject.string("name")}") }

        private fun JsonObject.string(key: String) = (this[key] as? JsonPrimitive)?.content

        private val png: ByteArray by lazy {
            ByteArrayOutputStream().also { Bitmap.createBitmap(64, 48, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        }
    }

    private class Measure(val document: RenderDocument, val raw: String, val width: Int, val conditions: JsonObject)

    private fun document(value: kotlinx.serialization.json.JsonElement): Pair<RenderDocument, String> {
        val text = when (value) {
            is JsonPrimitive -> File("src/debug/assets/genui/fixtures/" + value.content.removePrefix("compiled/").removeSuffix(".render.json") + ".json").readText()
            else -> value.toString()
        }
        return GenUi.parse(text) to text
    }

    private fun host(images: String?, cluster: Boolean) = GenUiHost(
        supports = if (cluster) { _ -> false } else { action -> action !is com.slopus.happy.genui.Action.Unsupported },
        cached = { null },
        load = { _ ->
            when (images) {
                "pending" -> awaitCancellation()
                "failed" -> "not a picture".toByteArray()
                else -> png
            }
        },
        key = { "measure/$images/$it" },
    )

    /** The texts of [keys]' subtrees, to tell a switch's branches apart by what shows. */
    private fun texts(document: RenderDocument, keys: List<String>): List<String> = keys.flatMap { key ->
        when (val e = document.elements[key]) {
            is Element.Text -> listOf(e.spans.joinToString("") { it.text })
            is Element.Switch -> texts(document, e.compact + e.regular)
            null -> emptyList()
            else -> texts(document, e.children)
        }
    }

    @Test fun measures() {
        val case = cases[index].jsonObject
        val measures = case["measure"]!!.jsonArray.map { m ->
            val o = m.jsonObject
            val (doc, raw) = document(o["document"]!!)
            Measure(doc, raw, o["width"]!!.jsonPrimitive.doubleOrNull!!.toInt(), o)
        }
        assertTrue("M1: hosts offer at least 240", measures.all { it.width >= 240 })
        val pictures = ImageLoader.Builder(ApplicationProvider.getApplicationContext()).build()
        var shown by mutableIntStateOf(0)
        lateinit var view: android.view.View
        rule.setContent {
            view = androidx.compose.ui.platform.LocalView.current
            val m = measures[shown]
            key(shown) {
                val dark = m.conditions.string("theme") == "dark"
                val state = remember {
                    GenUiState().also { state ->
                        m.conditions.string("chosen")?.let { chosen ->
                            when (val e = m.document.elements[chosen]) {
                                is Element.Press -> e.group
                                is Element.Button -> e.group
                                else -> null
                            }?.let { state.choose(it, chosen) }
                        }
                    }
                }
                HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) {
                    CompositionLocalProvider(LocalImageLoader provides pictures) {
                        // Wider than the test phone at 560 and 800: the box takes its width whatever the window.
                        Box(Modifier.requiredWidth(m.width.dp)) {
                            GenUiView(m.document, host = host(m.conditions.string("images"), m.conditions.string("host") == "cluster"), state = state, inset = 0.dp)
                        }
                    }
                }
            }
        }
        val heights = measures.mapIndexed { i, m ->
            rule.runOnIdle { shown = i }
            repeat(5) { Thread.sleep(40); rule.waitForIdle() }
            m.conditions.string("pressed")?.let { pressed ->
                val text = texts(m.document, listOf(pressed)).first()
                rule.onNodeWithText(text, substring = true).performTouchInput { down(center) }
                rule.waitForIdle()
            }
            if (m.conditions.string("scrolled") == "end") {
                repeat(6) { rule.node(GenUiTags.SCROLL).performTouchInput { swipeLeft() } }
                rule.waitForIdle()
            }
            (m.conditions["switch"] as? JsonObject)?.forEach { (key, branch) ->
                val e = m.document.elements.getValue(key) as Element.Switch
                val (want, other) = if (branch.jsonPrimitive.content == "compact") e.compact to e.regular else e.regular to e.compact
                texts(m.document, want).forEach { rule.onNodeWithText(it).assertIsDisplayed() }
                // The branch not shown is never placed, so it is neither drawn nor read out.
                texts(m.document, other).forEach { text ->
                    val nodes = rule.onAllNodesWithText(text).fetchSemanticsNodes()
                    assertEquals("$text at ${m.width}", 0, nodes.count { it.layoutInfo.isPlaced })
                    // What TalkBack is given for them.
                    val provider = view.accessibilityNodeProvider
                    nodes.forEach { node ->
                        val info = provider.createAccessibilityNodeInfo(node.id)
                        assertTrue("$text read out at ${m.width}", info == null || !info.isVisibleToUser)
                    }
                }
            }
            val height = rule.node(GenUiTags.VIEW).fetchSemanticsNode().size.height
            if (m.conditions.string("pressed") != null) {
                rule.onNodeWithText(texts(m.document, listOf(m.conditions.string("pressed")!!)).first(), substring = true).performTouchInput { up() }
            }
            m.raw to height
        }
        println("$name: ${heights.map { it.second }}")
        when (case.string("expect")) {
            "same height" -> assertEquals("$name: ${heights.map { it.second }}", 1, heights.map { it.second }.distinct().size)
            "same height per document" -> heights.groupBy({ it.first }, { it.second }).values.forEach {
                assertEquals("$name: $it", 1, it.distinct().size)
            }
            "switch branches" -> Unit
            else -> throw AssertionError("unknown expectation ${case.string("expect")}")
        }
    }
}
