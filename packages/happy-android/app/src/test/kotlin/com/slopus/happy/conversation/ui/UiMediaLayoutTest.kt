package com.slopus.happy.conversation.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The shared `media` rule ([UiMediaLayout]) against the client package's
 * frame table, `mediaLayout` in `ui/actions.fixtures.json` (see
 * [UiActionsTest]): every case at every width and row height, unit for unit.
 */
class UiMediaLayoutTest {
    private val cases = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/ui/actions.fixtures.json")).readText())
        .jsonObject["mediaLayout"]!!.jsonArray.map { it.jsonObject }

    private fun frame(value: JsonElement): UiMediaLayout.Frame? = (value as? JsonObject)?.let {
        UiMediaLayout.Frame(it["x"]!!.jsonPrimitive.double, it["y"]!!.jsonPrimitive.double, it["width"]!!.jsonPrimitive.double, it["height"]!!.jsonPrimitive.double)
    }

    @Test fun `every case lays out to the table's frames at every width, phones' 160 rows included`() {
        var checked = 0
        for (case in cases) {
            val name = case["name"]!!.jsonPrimitive.content
            val inputs = case["items"]!!.jsonArray.map { it.jsonObject }.map { item ->
                UiMediaLayout.Input(
                    item["kind"]!!.jsonPrimitive.content,
                    item["width"]?.jsonPrimitive?.doubleOrNull,
                    item["height"]?.jsonPrimitive?.doubleOrNull,
                    labelled = item["label"] != null,
                )
            }
            for (layout in case["layouts"]!!.jsonArray.map { it.jsonObject }) {
                val width = layout["width"]!!.jsonPrimitive.double
                val rowHeight = layout["rowHeight"]!!.jsonPrimitive.double
                val expected = UiMediaLayout.Arrangement(
                    layout["frames"]!!.jsonArray.map { frame(it)!! },
                    layout["labels"]!!.jsonArray.map { if (it is JsonNull) null else frame(it) },
                    layout["height"]!!.jsonPrimitive.double,
                )
                assertEquals("$name at $width, H $rowHeight", expected, UiMediaLayout.layout(inputs, width, rowHeight))
                checked++
            }
        }
        assertEquals("the table's every layout", cases.sumOf { it["layouts"]!!.jsonArray.size }, checked)
    }

    @Test fun `extreme shapes are clamped for layout, and an unsized recording is 16 by 9`() {
        assertEquals(3.0, UiMediaLayout.aspect(UiMediaLayout.Input("image", 9000.0, 100.0, false)), 0.0)
        assertEquals(0.4, UiMediaLayout.aspect(UiMediaLayout.Input("image", 100.0, 9000.0, false)), 0.0)
        assertEquals(16.0 / 9.0, UiMediaLayout.aspect(UiMediaLayout.Input("video", null, null, false)), 0.0)
        assertEquals(4.0 / 3.0, UiMediaLayout.aspect(UiMediaLayout.Input("document", null, null, false)), 0.0)
    }
}
