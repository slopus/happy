package com.slopus.happy.conversation.ui

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
 * The shared `media` rule ([UiMediaLayout]) against the contract: the
 * schema's `mediaLayout` constants, and the client package's own frames
 * (the fixtures' `mediaLayout` vectors) for every case at every width, unit
 * for unit. The vectors at the desktop's row height are not a phone's to
 * check.
 */
class UiMediaLayoutTest {
    private fun frame(value: JsonElement): UiMediaLayout.Frame? = (value as? JsonObject)?.let {
        UiMediaLayout.Frame(it.number("x"), it.number("y"), it.number("width"), it.number("height"))
    }

    private fun JsonObject.number(name: String): Double = getValue(name).jsonPrimitive.double

    private val constants = UiContract.schema.getValue("mediaLayout").jsonObject.mapValues { it.value.jsonPrimitive.double }

    @Test fun `the rule's constants are the schema's`() {
        assertEquals(
            mapOf(
                "rowHeightPhone" to UiMediaLayout.ROW_HEIGHT,
                "gap" to UiMediaLayout.GAP,
                "labelGap" to UiMediaLayout.LABEL_GAP,
                "labelLine" to UiMediaLayout.LABEL_LINE,
                "maxRowScale" to UiMediaLayout.MAX_ROW_SCALE,
                "singleHeightScale" to UiMediaLayout.SINGLE_HEIGHT_SCALE,
                "minAspect" to UiMediaLayout.MIN_ASPECT,
                "maxAspect" to UiMediaLayout.MAX_ASPECT,
            ),
            constants - "rowHeightDesktop",
        )
    }

    @Test fun `every case lays out to the package's frames at every width`() {
        var checked = 0
        for (case in UiContract.vectors("mediaLayout")) {
            val name = case.getValue("name").jsonPrimitive.content
            val inputs = case.getValue("items").jsonArray.map { it.jsonObject }.map { item ->
                UiMediaLayout.Input(
                    item.getValue("kind").jsonPrimitive.content,
                    item["width"]?.jsonPrimitive?.doubleOrNull,
                    item["height"]?.jsonPrimitive?.doubleOrNull,
                    labelled = item["label"] != null,
                )
            }
            for (layout in case.getValue("layouts").jsonArray.map { it.jsonObject }) {
                if (layout.number("rowHeight") != constants.getValue("rowHeightPhone")) continue
                val width = layout.number("width")
                val expected = UiMediaLayout.Arrangement(
                    layout.getValue("frames").jsonArray.map { frame(it)!! },
                    layout.getValue("labels").jsonArray.map { if (it is JsonNull) null else frame(it) },
                    layout.number("height"),
                )
                assertEquals("$name at $width", expected, UiMediaLayout.layout(inputs, width))
                checked++
            }
        }
        assertEquals("every case at three widths", UiContract.vectors("mediaLayout").size * 3, checked)
    }
}
