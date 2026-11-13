package com.slopus.happy.genui

import androidx.compose.ui.graphics.Color
import com.slopus.happy.R
import com.slopus.happy.ui.genui.drawable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.io.File

class GenUiThemeTest {
    /** The spec's shared theme, as copied next to the generator. */
    private val theme = Json.parseToJsonElement(File("../tools/genui/theme.json").readText()).jsonObject

    /** `#RRGGBB` or `#RRGGBBAA`, alpha last. */
    private fun colour(value: JsonObject, side: String): Color {
        val hex = value.getValue(side).jsonPrimitive.content.removePrefix("#")
        val alpha = if (hex.length == 8) hex.substring(6, 8).toInt(16) else 255
        return Color(hex.substring(0, 2).toInt(16), hex.substring(2, 4).toInt(16), hex.substring(4, 6).toInt(16), alpha)
    }

    @Test
    fun generatedColoursMatchThemeJson() {
        for ((side, colours) in listOf("light" to GenUiColors.Light, "dark" to GenUiColors.Dark)) {
            // The semantic tones, then the raw colours, all as Tone.
            val tones = theme.getValue("tones").jsonObject + theme.getValue("colors").jsonObject
            assertEquals(tones.keys.toList(), Tone.entries.map { it.name.lowercase() })
            for ((name, value) in tones) {
                val tone = Tone.entries.single { it.name.equals(name, ignoreCase = true) }
                assertEquals("$side $name ink", colour(value.jsonObject.getValue("ink").jsonObject, side), colours.ink(tone))
                assertEquals("$side $name text", colour(value.jsonObject.getValue("text").jsonObject, side), colours.text(tone))
                assertEquals("$side $name fill", colour(value.jsonObject.getValue("fill").jsonObject, side), colours.fill(tone))
            }
            val chart = theme.getValue("chart").jsonObject
            assertEquals(chart.getValue("palette").jsonArray.map { colour(it.jsonObject, side) }, colours.palette)
            assertEquals(colour(chart.getValue("muted").jsonObject, side), colours.muted)
            assertEquals(colour(chart.getValue("grid").jsonObject, side), colours.grid)
            assertEquals(colour(chart.getValue("axisLabel").jsonObject, side), colours.axisLabel)
        }
    }

    @Test
    fun markersMatchThemeJson() {
        val markers = theme.getValue("markers").jsonObject
        assertEquals(StepStatus.entries.size, markers.size)
        for ((status, tone) in markers) {
            assertEquals(status, tone.jsonPrimitive.content, GenUiMarkers.getValue(StepStatus.entries.single { it.name.equals(status, ignoreCase = true) }).name.lowercase())
        }
    }

    @Test
    fun plotColourWrapsThePalette() {
        val c = GenUiColors.Light
        assertEquals(c.palette[0], c.plot(PlotColor(1)))
        assertEquals(c.palette[7], c.plot(PlotColor(8)))
        assertEquals(c.palette[0], c.plot(PlotColor(9)))
        assertEquals(c.muted, c.plot(PlotColor.Muted))
        assertEquals(c.ink(Tone.Brown), c.plot(PlotColor(null, Tone.Brown)))
    }

    @Test
    fun everyCatalogIconResolvesToItsDrawable() {
        val catalog = Json.parseToJsonElement(File("../tools/genui/catalog.json").readText()).jsonObject
        val names = (catalog.getValue("icons") as JsonArray).map { (it as JsonPrimitive).content }
        val shared = theme.getValue("icons").jsonObject.getValue("names").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(names.sorted(), shared.sorted())
        assertEquals(names.size, IconName.entries.size)
        for (name in names) {
            val icon = IconName.of(name)
            assertNotNull(name, icon)
            val resource = "genui_ic_" + name.replace('-', '_')
            assertEquals(name, R.drawable::class.java.getField(resource).getInt(null), icon!!.drawable)
        }
    }
}
