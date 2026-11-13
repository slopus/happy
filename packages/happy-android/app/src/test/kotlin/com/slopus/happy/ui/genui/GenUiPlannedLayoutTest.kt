package com.slopus.happy.ui.genui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Density
import androidx.compose.ui.platform.LocalDensity
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.genui.GenUi
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Every bundled fixture's planned height at phone and wider widths and at
 * two text sizes, checked against the record in
 * `src/test/resources/genui/planned.txt` (a renderer change that moves one
 * shows as a diff to read; delete the record to write it again). Where
 * each word sits goes to `build/genui-planned-words.txt`, to diff by hand.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GenUiPlannedLayoutTest {
    @get:Rule val rule = createComposeRule()

    private val fixtures = File("src/debug/assets/genui/fixtures").listFiles { f -> f.extension == "json" }.orEmpty().sortedBy { it.name }
        .map { it.nameWithoutExtension to GenUi.parse(it.readText()) }
    private val widths = listOf(320, 360, 390, 411, 600, 800)
    private val scales = listOf(1f, 1.3f)

    @Test fun everyFixtureKeepsItsPlannedLayout() {
        var shown by mutableIntStateOf(0)
        val cases = fixtures.indices.flatMap { f -> widths.flatMap { w -> scales.map { s -> Triple(f, w, s) } } }
        rule.setHappyContent {
            val (f, w, s) = cases[shown]
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, s)) {
                Box(Modifier.requiredWidth(w.dp).wrapContentHeight()) { GenUiView(fixtures[f].second) }
            }
        }
        val heights = StringBuilder()
        val words = StringBuilder()
        for ((i, case) in cases.withIndex()) {
            rule.runOnIdle { shown = i }
            rule.waitForIdle()
            val (f, w, s) = case
            val name = "${fixtures[f].first} width $w scale $s"
            words.append("# $name\n")
            var height = -1f
            fun walk(node: SemanticsNode) {
                if (node.config.getOrNull(SemanticsProperties.TestTag) == GenUiTags.VIEW) height = node.size.height.toFloat()
                node.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }?.let { text ->
                    val b = node.boundsInRoot
                    words.append(String.format(java.util.Locale.US, "  %5.0f %5.0f %5.0f %5.0f %s\n", b.left, b.top, b.width, b.height, text.replace("\u200B", "").take(40)))
                }
                node.children.forEach(::walk)
            }
            walk(rule.onRoot(useUnmergedTree = true).fetchSemanticsNode())
            heights.append("$name: ${height.toInt()}\n")
        }
        File("build/genui-planned-words.txt").writeText(words.toString())
        File("build/genui-planned.txt").writeText(heights.toString())
        val record = File("src/test/resources/genui/planned.txt")
        if (!record.exists()) record.writeText(heights.toString())
        assertEquals("a fixture's planned height moved: diff build/genui-planned.txt against ${record.path}", record.readText(), heights.toString())
    }
}
