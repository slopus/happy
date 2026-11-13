package com.slopus.happy.genui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class GenUiTest {
    /** The render examples, bundled as the gym's fixtures. */
    private val fixtures = File("src/debug/assets/genui/fixtures").listFiles { f -> f.extension == "json" }.orEmpty().sortedBy { it.name }

    private fun doc(elements: String, root: String = "root", fallback: String? = "Plain text") =
        GenUi.parse("""{"genuiRender":1,"root":"$root",${fallback?.let { "\"fallback\":\"$it\"," } ?: ""}"elements":{$elements}}""")

    private val text = """{"type":"text","props":{"spans":[{"text":"Hi"}]}}"""

    @Test
    fun everyCompiledExampleParsesAndDraws() {
        // The compiled examples (14 now) and the hand-written icons-and-colours document.
        assertTrue(fixtures.size >= 15)
        assertTrue(fixtures.any { it.name == "icons-and-colours.json" })
        for (file in fixtures) {
            val raw = file.readText()
            val document = GenUi.parse(raw)
            assertTrue("${file.name} drawable", document.drawable)
            assertTrue("${file.name} has a fallback", !document.fallback.isNullOrBlank())
            // Every element of the example is a primitive we know, with what it requires.
            val keys = kotlinx.serialization.json.Json.parseToJsonElement(raw).let { (it as kotlinx.serialization.json.JsonObject)["elements"] as kotlinx.serialization.json.JsonObject }.keys
            assertEquals("${file.name}: every element kept", keys, document.elements.keys)
            // Every element is reachable from the root exactly once.
            val reached = HashSet<String>()
            fun walk(key: String) {
                assertTrue("${file.name}: $key reached once", reached.add(key))
                when (val e = document.elements.getValue(key)) {
                    is Element.Switch -> (e.compact + e.regular).forEach(::walk)
                    else -> e.children.forEach(::walk)
                }
            }
            walk(document.root!!)
            assertEquals("${file.name}: all reachable", keys, reached)
        }
    }

    @Test
    fun compiledExamplesKeepTheirData() {
        val gallery = GenUi.parse(fixtures.first { it.name.startsWith("05") }.readText())
        assertEquals(7, gallery.viewers.getValue("gallery").size)
        val tile = gallery.elements.getValue("gallery.4") as Element.Image
        assertEquals("+2", tile.overlay)
        assertEquals(ViewerRef("gallery", 4), tile.viewer)
        assertEquals(ImageRole.Tile, tile.role)

        val line = GenUi.parse(fixtures.first { it.name.startsWith("02") }.readText())
        val plot = line.elements.values.filterIsInstance<Element.Plot>().single()
        assertEquals(PlotKind.Line, plot.kind)
        assertEquals(listOf("$0", "$100k", "$200k", "$300k"), plot.y!!.ticks.map { it.label })
        assertEquals(PlotColor(1), plot.series[0].color)
        assertEquals("$120k", plot.series[0].labels[0])

        val bar = GenUi.parse(fixtures.first { it.name.startsWith("03") }.readText())
        assertEquals(PlotColor.Muted, bar.elements.values.filterIsInstance<Element.Plot>().single().series[0].color)

        val table = GenUi.parse(fixtures.first { it.name.startsWith("08") }.readText())
        assertTrue(table.elements.values.any { it is Element.Text && it.role == TextRole.Rowhead })
        assertTrue(table.elements.values.any { it is Element.Box && it.role == BoxRole.Record })
        assertTrue(table.elements.values.any { it is Element.Text && it.fixed })

        val list = GenUi.parse(fixtures.first { it.name.startsWith("07") }.readText())
        val rows = list.elements.getValue("list") as Element.Box
        assertEquals(Leading.Icon, rows.leading)
        assertTrue(list.elements.values.any { it is Element.Press && it.role == PressRole.Item })

        val stats = GenUi.parse(fixtures.first { it.name.startsWith("01") }.readText())
        val row = stats.elements.getValue("row") as Element.Box
        assertTrue(row.equal && !row.wrap)
        val grid = table.elements.getValue("table.regular") as Element.Grid
        assertEquals(GridColumn(fill = false, end = true), grid.columns[1])
        assertTrue(grid.header && grid.divide)
    }

    @Test
    fun unknownPrimitiveDropsItsSubtree() {
        val d = doc(
            """"root":{"type":"box","children":["a","weird"]},"a":$text,
               "weird":{"type":"hologram","children":["b"]},"b":$text""",
        )
        assertTrue(d.drawable)
        assertEquals(listOf("a"), d.elements.getValue("root").children)
        assertNull(d.elements["weird"])
        // b is not under anything drawn; it is never reached from the root.
        assertFalse(d.elements.getValue("root").children.contains("b"))
    }

    @Test
    fun unknownPropsAndEnumValuesTakeDefaults() {
        val d = doc(
            """"root":{"type":"box","props":{"role":"hexagon","gap":"huge","direction":"diagonal","sparkle":true},"children":["t","i","p"]},
               "t":{"type":"text","props":{"spans":[{"text":"x","blink":true}],"role":"shout","tone":"rainbow","overflow":"explode"}},
               "i":{"type":"icon","props":{"name":"check","role":"giant","tone":"plaid"}},
               "p":{"type":"pill","props":{"text":"ok","icon":"unicorn"}}""",
        )
        val box = d.elements.getValue("root") as Element.Box
        assertEquals(BoxRole.Plain, box.role)
        assertEquals(Gap.None, box.gap)
        assertEquals(Direction.Column, box.direction)
        val t = d.elements.getValue("t") as Element.Text
        assertEquals(TextRole.Body, t.role)
        // A tone the theme doesn't have renders as neutral.
        assertEquals(Tone.Neutral, t.tone)
        assertEquals(Overflow.Wrap, t.overflow)
        val i = d.elements.getValue("i") as Element.Icon
        assertEquals(IconRole.Leading, i.role)
        assertEquals(Tone.Neutral, i.tone)
        assertNull((d.elements.getValue("p") as Element.Pill).icon)
    }

    @Test
    fun rawColoursAreTonesAndPlotColours() {
        val d = doc(
            """"root":{"type":"box","children":["p","t","plot"]},
               "p":{"type":"pill","props":{"text":"x","tone":"brown"}},
               "t":$text,
               "plot":{"type":"plot","props":{"kind":"bar","x":["a"],"y":{"min":0,"max":1,"ticks":[]},"summary":"s",
                 "series":[{"name":"a","values":[1],"color":"brown"},{"name":"b","values":[1],"color":"muted"},{"name":"c","values":[1],"color":"plaid"},{"name":"d","values":[1],"color":3}]}}""",
        )
        assertEquals(Tone.Brown, (d.elements.getValue("p") as Element.Pill).tone)
        assertNull((d.elements.getValue("t") as Element.Text).tone)
        val colors = (d.elements.getValue("plot") as Element.Plot).series.map { it.color }
        assertEquals(listOf(PlotColor(null, Tone.Brown), PlotColor.Muted, PlotColor.Muted, PlotColor(3)), colors)
    }

    @Test
    fun missingRequiredPropDropsTheElement() {
        val d = doc(
            """"root":{"type":"box","children":["noSpans","noAction","noFile","unknownIcon","oneSpark","noValue","ok"]},
               "noSpans":{"type":"text","props":{"role":"title"}},
               "noAction":{"type":"button","props":{"label":"Go","variant":"primary"}},
               "noFile":{"type":"image","props":{"width":10,"height":10,"thumbhash":"x","alt":"a","shape":"square"}},
               "unknownIcon":{"type":"icon","props":{"name":"unicorn"}},
               "oneSpark":{"type":"spark","props":{"values":[1]}},
               "noValue":{"type":"bar","props":{}},
               "ok":$text""",
        )
        assertEquals(listOf("ok"), d.elements.getValue("root").children)
    }

    @Test
    fun missingEnumsTakeTheirNamedDefaults() {
        val d = doc(
            """"root":{"type":"box","children":["b","i","s","m","p"]},
               "b":{"type":"button","props":{"label":"Go","action":{"type":"message","text":"go"}}},
               "i":{"type":"image","props":{"file":"a.jpg","width":10,"height":10,"thumbhash":"x","alt":"a"}},
               "s":{"type":"scroll","props":{},"children":[]},
               "m":{"type":"marker","props":{"status":"exploded"}},
               "p":{"type":"plot","props":{"kind":"radar","x":["a"],"y":{"min":0,"max":1,"ticks":[]},"series":[{"name":"s","values":[1],"color":1}],"summary":"s"}}""",
        )
        assertEquals(listOf("b", "i", "s", "m", "p"), d.elements.getValue("root").children)
        assertEquals(ButtonVariant.Secondary, (d.elements.getValue("b") as Element.Button).variant)
        assertEquals(Shape.Landscape, (d.elements.getValue("i") as Element.Image).shape)
        assertEquals(Shape.Landscape, (d.elements.getValue("s") as Element.Scroll).shape)
        assertEquals(StepStatus.Pending, (d.elements.getValue("m") as Element.Marker).status)
        assertEquals(PlotKind.Line, (d.elements.getValue("p") as Element.Plot).kind)
    }

    @Test
    fun pressWithoutAValidActionKeepsItsChild() {
        val d = doc(
            """"root":{"type":"box","children":["p","q","r"]},
               "p":{"type":"press","props":{"action":{"type":"launch-missiles"}},"children":["t"]},
               "q":{"type":"press","props":{"action":{"type":"tool","name":"search"},"role":"item"},"children":["u"]},
               "r":{"type":"press","props":{"role":"hologram"},"children":["v"]},
               "t":$text,"u":$text,"v":$text""",
        )
        assertEquals(listOf("p", "q", "r"), d.elements.getValue("root").children)
        val p = d.elements.getValue("p") as Element.Press
        assertNull(p.action)
        assertEquals(listOf("t"), p.children)
        val q = d.elements.getValue("q") as Element.Press
        assertEquals(Action.Tool("search", kotlinx.serialization.json.JsonObject(emptyMap())), q.action)
        assertEquals(PressRole.Item, q.role)
        assertEquals(PressRole.Plain, (d.elements.getValue("r") as Element.Press).role)
    }

    @Test
    fun undrawableDocumentFallsBack() {
        assertFalse(doc(""""root":{"type":"hologram"}""").drawable)
        assertFalse(doc(text.let { """"other":$it""" }).drawable)
        assertFalse(doc(""""root":$text""", root = "missing").drawable)
        val d = doc(""""root":{"type":"text","props":{}}""", fallback = "Revenue was up 18%.")
        assertFalse(d.drawable)
        assertEquals("Revenue was up 18%.", d.fallback)
    }

    @Test
    fun badJsonIsAnEmptyDocument() {
        for (raw in listOf("", "nope", "[]", "{\"elements\":[]}", "{\"root\":1,\"elements\":{\"a\":5}}")) {
            val d = GenUi.parse(raw)
            assertFalse(raw, d.drawable)
        }
    }

    @Test
    fun cyclesAndSharedChildrenAreCut() {
        val d = doc(
            """"root":{"type":"box","children":["a","b"]},
               "a":{"type":"box","children":["root","c"]},
               "b":{"type":"box","children":["c","b"]},
               "c":$text""",
        )
        assertEquals(listOf("c"), d.elements.getValue("a").children)
        assertEquals(emptyList<String>(), d.elements.getValue("b").children)
    }

    @Test
    fun switchSlotsAcceptAKeyOrAList() {
        val d = doc(""""root":{"type":"switch","slots":{"compact":"a","regular":["b","gone"]}},"a":$text,"b":$text""")
        val s = d.elements.getValue("root") as Element.Switch
        assertEquals(listOf("a"), s.compact)
        assertEquals(listOf("b"), s.regular)
    }

    @Test
    fun plotNeedsItsAxisExceptForADonut() {
        val series = """"series":[{"name":"s","values":[1,null,3],"color":1}]"""
        assertNull(doc(""""root":{"type":"plot","props":{"kind":"line","x":["a","b","c"],$series,"summary":"s"}}""").elements["root"])
        val donut = doc(""""root":{"type":"plot","props":{"kind":"donut","x":[],$series,"slices":[{"label":"a","value":1,"color":2}],"summary":"s"}}""")
        assertTrue(donut.drawable)
        val line = doc(""""root":{"type":"plot","props":{"kind":"line","x":["a","b","c"],"y":{"min":0,"max":4,"ticks":[]},$series,"summary":"s"}}""")
        assertEquals(listOf(1.0, null, 3.0), (line.elements.getValue("root") as Element.Plot).series[0].values)
    }
}
