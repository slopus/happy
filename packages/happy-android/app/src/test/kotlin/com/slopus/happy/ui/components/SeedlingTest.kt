package com.slopus.happy.ui.components

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/** The seedling against iOS's fixtures, written from desktop's `stemCellGeometry.ts`: the same seed is the same cell. */
class SeedlingTest {
    private val cases = Json.parseToJsonElement(javaClass.getResource("/seedling/geometry.json")!!.readText()).jsonArray.map { it as JsonObject }

    private fun points(value: JsonArray) = value.map { p -> p.jsonArray.let { it[0].jsonPrimitive.double to it[1].jsonPrimitive.double } }

    @Test
    fun shapesMatchDesktop() {
        assertEquals(true, cases.size > 10)
        for (case in cases) {
            val id = case["id"]!!.jsonPrimitive.content
            val shape = SeedlingGeometry.shape(id, case["drift"]!!.jsonPrimitive.double)
            for ((actual, expected) in listOf(shape.membrane to points(case["membrane"]!!.jsonArray), shape.core to points(case["core"]!!.jsonArray))) {
                assertEquals(id, expected.size, actual.size)
                actual.zip(expected).forEach { (p, e) ->
                    assertEquals(id, e.first, p.x, 1e-9)
                    assertEquals(id, e.second, p.y, 1e-9)
                }
            }
        }
    }

    @Test
    fun theSplineMatchesDesktopsPath() {
        fun f(v: Double) = String.format(java.util.Locale.ROOT, "%.2f", v)
        for (case in cases) {
            val expected = (case["path20"] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content ?: continue
            val id = case["id"]!!.jsonPrimitive.content
            val (start, segments) = SeedlingGeometry.smooth(SeedlingGeometry.shape(id).membrane, 20.0)
            val path = StringBuilder("M${f(start.x)} ${f(start.y)}")
            for (s in segments) path.append("C${f(s.control1.x)} ${f(s.control1.y)} ${f(s.control2.x)} ${f(s.control2.y)} ${f(s.end.x)} ${f(s.end.y)}")
            assertEquals(id, expected, "${path}Z")
        }
    }

    @Test
    fun hashFollowsJavaScript() {
        assertEquals(0xe40c292cu, SeedlingGeometry.hash("a"))
        assertEquals(0x811c9dc5u, SeedlingGeometry.hash(""))
    }
}
