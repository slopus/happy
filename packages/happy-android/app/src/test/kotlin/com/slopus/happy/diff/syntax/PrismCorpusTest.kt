package com.slopus.happy.diff.syntax

import com.slopus.happy.diff.SpanKind
import com.slopus.happy.diff.SyntaxRun
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * happy-app engine/highlight.ts's highlightLines, run by Prism 1.30.0
 * itself over tools/prism/corpus (one file per grammar happy-app loads),
 * against the port: every line's runs, kind for kind and length for
 * length. Every pattern in the grammar table compiles.
 */
class PrismCorpusTest {
    private val kinds = SpanKind.entries.associateBy { it.wire }

    @Test
    fun everyPatternCompiles() {
        assertTrue(Prism.compileAll() > 1000)
        assertEquals(45, Prism.languages.size)
    }

    @Test
    fun matchesPrism() {
        val text = requireNotNull(javaClass.classLoader!!.getResource("diff/prism-reference.json")).readText()
        val entries = Json.parseToJsonElement(text).jsonArray
        assertTrue(entries.size >= 46)
        val failures = ArrayList<String>()
        for (entry in entries) {
            val e = entry.jsonObject
            val language = e.getValue("lang").jsonPrimitive.content
            val source = e.getValue("text").jsonPrimitive.content
            val expected = e.getValue("runs").jsonArray.map { line ->
                line.jsonArray.map { run ->
                    val r = run.jsonObject
                    SyntaxRun(kinds.getValue(r.getValue("k").jsonPrimitive.content), r.getValue("n").jsonPrimitive.int)
                }
            }
            val actual = PrismHighlighter.highlightLines(source, language)
            if (actual.none { line -> line.any { it.kind != SpanKind.Plain } }) failures.add("$language colours nothing")
            if (actual != expected) {
                val line = expected.indices.firstOrNull { expected.getOrNull(it) != actual.getOrNull(it) } ?: -1
                failures.add("$language (${e.getValue("file").jsonPrimitive.content}) line ${line + 1}: ${source.split('\n').getOrNull(line)}\n  expected ${expected.getOrNull(line)}\n  actual   ${actual.getOrNull(line)}")
            }
        }
        assertEquals(failures.joinToString("\n"), 0, failures.size)
    }
}
