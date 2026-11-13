package com.slopus.happy.genui

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

// Gen UI render documents (task_375 genui/RENDER.md, render/catalog.json):
// what the daemon compiles a model's Gen UI document into, a flat map of
// keyed elements of 15 primitives. The document carries no dimensions; the
// client owns every number. Parsing never fails: an unknown primitive is
// dropped with its subtree, an unknown prop or enum value takes its default,
// an element missing a required prop is dropped, and a document with nothing
// drawable is its `fallback` text.

enum class Direction { Column, Row }

enum class BoxRole { Plain, Card, Header, Actions, Notice, Section, Item, Record, Tile, Mosaic }

enum class Gap { None, Inline, Tight, Related, Labeled, Heading, Items, Blocks }

enum class Align { Start, Center, End, Baseline, Stretch }

enum class Justify { Start, Between, End }

enum class Divide { None, Full, Inset }

enum class Leading { None, Icon, Thumb, Number }

enum class Density { Table, Pairs }

enum class Shape { Landscape, Square, Portrait }

enum class TextRole { Title, Subtitle, Heading, Prompt, Body, Note, Label, Value, Delta, Item, Detail, Trailing, Column, Rowhead, Cell, Number, Ordinal }

enum class Overflow { Wrap, Clamp, Truncate }

enum class TextAlign { Start, End }

enum class IconRole { Leading, Inline }

enum class ImageRole { Figure, Tile, Thumb, Cover }

enum class ButtonVariant { Primary, Secondary, Plain, Chip }

/** What a press wraps, so its pressed and chosen states can cover the whole of it. */
enum class PressRole { Plain, Item, Tile }

enum class StepStatus { Done, Active, Pending, Failed }

enum class PlotKind { Line, Area, Bar, Donut }

/** The catalog's icon names. */
enum class IconName(val wire: String) {
    Check("check"), X("x"), Alert("alert"), Info("info"), Clock("clock"), Calendar("calendar"), User("user"),
    Users("users"), File("file"), Folder("folder"), Code("code"), Terminal("terminal"), GitBranch("git-branch"),
    GitCommit("git-commit"), GitPullRequest("git-pull-request"), Link("link"), Search("search"), Star("star"),
    Heart("heart"), Download("download"), Upload("upload"), Play("play"), Pause("pause"), Image("image"),
    Chart("chart"), Globe("globe"), Bolt("bolt"), Bug("bug"), Lock("lock"), Sparkles("sparkles"),
    ArrowRight("arrow-right"), ArrowUpRight("arrow-up-right"), ArrowUp("arrow-up"), ArrowDown("arrow-down"),
    ArrowDownRight("arrow-down-right"), ChevronRight("chevron-right"), Dollar("dollar"), MapPin("map-pin"), Copy("copy"),
    ;

    companion object {
        fun of(wire: String?): IconName? = entries.firstOrNull { it.wire == wire }
    }
}

@Immutable
sealed interface Action {
    data class Message(val text: String) : Action
    data class Open(val url: String) : Action
    data class Copy(val text: String) : Action
    data class Tool(val name: String, val input: JsonObject) : Action

    /** Opens the Happy Agent secret form on [secret]; the person types the values. */
    data class Secret(val secret: SecretPrefill) : Action

    /** Opens Happy Cloud's form for a [kind] secret on [secret], its prefill as written. */
    data class ClusterSecret(val kind: ClusterSecretKind, val secret: JsonObject) : Action

    /** Opens the page of plugin [id], where the person may install it. */
    data class Plugin(val id: String) : Action

    /** An action this build can't run, or one written wrong: its button is drawn, disabled. */
    data class Unsupported(val type: String?) : Action
}

@Immutable
data class Span(val text: String, val strong: Boolean = false, val emphasis: Boolean = false, val code: Boolean = false, val link: String? = null)

@Immutable
data class GridColumn(val fill: Boolean, val end: Boolean)

@Immutable
data class ViewerRef(val group: String, val index: Int)

@Immutable
data class ViewerItem(val file: String, val width: Int, val height: Int, val thumbhash: String, val alt: String, val caption: String?)

/** A plot colour: a 1-based palette index, a named colour ([Tone]), or the muted grey (neither). */
@Immutable
data class PlotColor(val index: Int?, val tone: Tone? = null) {
    companion object {
        val Muted = PlotColor(null)
    }
}

@Immutable
data class Tick(val value: Double, val label: String)

@Immutable
data class Axis(val min: Double, val max: Double, val ticks: List<Tick>)

@Immutable
data class PlotSeries(val name: String, val values: List<Double?>, val labels: List<String?>, val color: PlotColor)

@Immutable
data class Slice(val label: String, val value: Double, val color: PlotColor)

@Immutable
data class LegendRow(val label: String, val color: PlotColor, val value: String?, val share: String?)

@Immutable
data class Center(val value: String, val label: String)

/** One primitive. [children] are element keys, in order. */
@Immutable
sealed interface Element {
    val children: List<String> get() = emptyList()

    data class Box(
        val direction: Direction = Direction.Column,
        val role: BoxRole = BoxRole.Plain,
        val gap: Gap = Gap.None,
        val tone: Tone? = null,
        val align: Align = Align.Stretch,
        val justify: Justify = Justify.Start,
        val equal: Boolean = false,
        val wrap: Boolean = false,
        val divide: Divide = Divide.None,
        val leading: Leading = Leading.None,
        val grow: Boolean = false,
        override val children: List<String> = emptyList(),
    ) : Element

    data class Grid(
        val columns: List<GridColumn>, val density: Density, val divide: Boolean, val header: Boolean, override val children: List<String>,
    ) : Element

    data class Scroll(val shape: Shape, override val children: List<String>) : Element

    data class Switch(val compact: List<String>, val regular: List<String>) : Element

    /** [fixed] text keeps its natural width in a row; its siblings give way. */
    data class Text(val spans: List<Span>, val role: TextRole, val tone: Tone?, val overflow: Overflow, val align: TextAlign, val fixed: Boolean = false) : Element

    data class Icon(val name: IconName, val tone: Tone, val role: IconRole) : Element

    data class Image(
        val file: String, val width: Int, val height: Int, val thumbhash: String, val alt: String, val shape: Shape,
        val role: ImageRole, val overlay: String?, val viewer: ViewerRef?,
    ) : Element

    data class Pill(val text: String, val tone: Tone, val icon: IconName?) : Element

    data class Button(
        val label: String, val action: Action, val icon: IconName?, val variant: ButtonVariant, val tone: Tone, val group: String?,
    ) : Element

    /** A press with no [action] draws its children, not tappable. */
    data class Press(val action: Action?, val role: PressRole, val group: String?, override val children: List<String>) : Element

    data class Bar(val value: Double, val tone: Tone) : Element

    data class Marker(val status: StepStatus, val rail: Boolean) : Element

    data class Spark(val values: List<Double>, val tone: Tone) : Element

    data class Plot(
        val kind: PlotKind, val x: List<String>, val y: Axis?, val series: List<PlotSeries>, val stacked: Boolean,
        val slices: List<Slice>, val legend: List<LegendRow>, val center: Center?, val summary: String,
    ) : Element

    data class Code(val text: String, val language: String?, val title: String?) : Element
}

@Immutable
data class RenderDocument(
    val fallback: String?,
    val root: String?,
    val elements: Map<String, Element>,
    val viewers: Map<String, List<ViewerItem>>,
) {
    /** Whether [root] names an element that can be drawn; otherwise the host shows [fallback]. */
    val drawable: Boolean get() = root != null && root in elements
}

/** The `genuiRender` format this build draws (API.md: a client that doesn't draw a version shows the summary). */
const val GEN_UI_RENDER_VERSION = 1

/** Where a `gen_ui` artifact version or vault app keeps the render document the computer compiled. */
const val GEN_UI_RENDER_PATH = ".genui/render.json"

object GenUi {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** Text that isn't a render document gives one with nothing to draw and no fallback. */
    fun parse(text: String): RenderDocument {
        val obj = runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return RenderDocument(null, null, emptyMap(), emptyMap())
        return document(obj)
    }

    /** A document of a `genuiRender` other than [GEN_UI_RENDER_VERSION] keeps only its fallback. */
    fun document(obj: JsonObject): RenderDocument {
        if (obj.number("genuiRender") != GEN_UI_RENDER_VERSION.toDouble()) return RenderDocument(obj.string("fallback"), null, emptyMap(), emptyMap())
        val raw = obj.obj("elements") ?: JsonObject(emptyMap())
        val parsed = raw.mapNotNull { (key, value) -> element(value)?.let { key to it } }.toMap()
        val viewers = obj.obj("viewers")?.mapNotNull { (group, items) ->
            (items as? JsonArray)?.let { group to it.filterIsInstance<JsonObject>().mapNotNull(::viewerItem) }
        }?.toMap() ?: emptyMap()
        return RenderDocument(obj.string("fallback"), obj.string("root"), prune(parsed), viewers)
    }

    /** One element, or null when its type is unknown or a required prop is missing. */
    fun element(value: JsonElement): Element? {
        val o = value as? JsonObject ?: return null
        val p = o.obj("props") ?: JsonObject(emptyMap())
        val children = o.keys("children")
        return runCatching { elementOf(o.string("type"), p, children, o.obj("slots")) }.getOrNull()
    }

    private fun elementOf(type: String?, p: JsonObject, children: List<String>, slots: JsonObject?): Element? = when (type) {
        "box" -> Element.Box(
            p.enum("direction", Direction.Column), p.enum("role", BoxRole.Plain), p.enum("gap", Gap.None), p.tone(),
            p.enum("align", Align.Stretch), p.enum("justify", Justify.Start), p.bool("equal"), p.bool("wrap"),
            p.enum("divide", Divide.None), p.enum("leading", Leading.None), p.bool("grow"), children,
        )
        "grid" -> {
            val columns = p.objects("columns").map { GridColumn(it.string("width") == "fill", it.string("align") == "end") }
            if (columns.isEmpty()) null else Element.Grid(columns, p.enum("density", Density.Table), p.bool("divide"), p.bool("header"), children)
        }
        "scroll" -> Element.Scroll(p.enum("shape", Shape.Landscape), children)
        "switch" -> Element.Switch(slots.slot("compact"), slots.slot("regular"))
        "text" -> {
            val spans = p.objects("spans").mapNotNull { s ->
                s.string("text")?.let { Span(it, s.bool("strong"), s.bool("emphasis"), s.bool("code"), s.string("link")) }
            }
            if (spans.isEmpty()) null
            else Element.Text(spans, p.enum("role", TextRole.Body), p.tone(), p.enum("overflow", Overflow.Wrap), p.enum("align", TextAlign.Start), p.bool("fixed"))
        }
        "icon" -> IconName.of(p.string("name"))?.let { Element.Icon(it, p.enum("tone", Tone.Neutral), p.enum("role", IconRole.Leading)) }
        "image" -> {
            val file = p.string("file")
            val width = p.number("width")
            val height = p.number("height")
            val thumbhash = p.string("thumbhash")
            val alt = p.string("alt")
            val shape = p.enum("shape", Shape.Landscape)
            if (file == null || width == null || height == null || thumbhash == null || alt == null) null
            else Element.Image(
                file, width.toInt(), height.toInt(), thumbhash, alt, shape, p.enum("role", ImageRole.Figure),
                p.string("overlay"),
                p.obj("viewer")?.let { v -> v.string("group")?.let { g -> v.number("index")?.let { ViewerRef(g, it.toInt()) } } },
            )
        }
        "pill" -> p.string("text")?.let { Element.Pill(it, p.enum("tone", Tone.Neutral), IconName.of(p.string("icon"))) }
        "button" -> p.string("label")?.let { label ->
            Element.Button(
                label, p.action(), IconName.of(p.string("icon")), p.enum("variant", ButtonVariant.Secondary), p.enum("tone", Tone.Neutral), p.string("group"),
            )
        }
        "press" -> Element.Press(p.action().takeIf { it !is Action.Unsupported }, p.enum("role", PressRole.Plain), p.string("group"), children)
        "bar" -> p.number("value")?.let { Element.Bar(it.coerceIn(0.0, 1.0), p.enum("tone", Tone.Neutral)) }
        "marker" -> Element.Marker(p.enum("status", StepStatus.Pending), p.bool("rail"))
        "spark" -> {
            val values = p.array("values").mapNotNull { (it as? JsonPrimitive)?.doubleOrNull }
            if (values.size < 2) null else Element.Spark(values, p.enum("tone", Tone.Neutral))
        }
        "plot" -> plot(p)
        "code" -> p.string("text")?.let { Element.Code(it, p.string("language"), p.string("title")) }
        else -> null
    }

    private fun plot(p: JsonObject): Element.Plot? {
        val kind = p.enum("kind", PlotKind.Line)
        val series = p.objects("series").mapNotNull { s ->
            val name = s.string("name") ?: return@mapNotNull null
            if (s["values"] !is JsonArray) return@mapNotNull null
            PlotSeries(
                name,
                s.array("values").map { (it as? JsonPrimitive)?.doubleOrNull },
                s.array("labels").map { (it as? JsonPrimitive)?.takeIf { v -> v !is JsonNull && v.isString }?.content },
                color(s["color"]) ?: return@mapNotNull null,
            )
        }
        if (series.isEmpty()) return null
        val y = p.obj("y")?.let { y ->
            val min = y.number("min")
            val max = y.number("max")
            if (min == null || max == null) null
            else Axis(min, max, y.objects("ticks").mapNotNull { t -> t.number("value")?.let { v -> t.string("label")?.let { Tick(v, it) } } })
        }
        if (kind != PlotKind.Donut && y == null) return null
        return Element.Plot(
            kind,
            p.array("x").mapNotNull { (it as? JsonPrimitive)?.content },
            y,
            series,
            p.bool("stacked"),
            p.objects("slices").mapNotNull { s ->
                val label = s.string("label") ?: return@mapNotNull null
                val value = s.number("value") ?: return@mapNotNull null
                Slice(label, value, color(s["color"]) ?: return@mapNotNull null)
            },
            p.objects("legend").mapNotNull { l ->
                val label = l.string("label") ?: return@mapNotNull null
                LegendRow(label, color(l["color"]) ?: return@mapNotNull null, l.string("value"), l.string("share"))
            },
            p.obj("center")?.let { c -> c.string("value")?.let { v -> c.string("label")?.let { Center(v, it) } } },
            p.string("summary") ?: "",
        )
    }

    /** A palette index, `muted`, or a colour name; a name the theme doesn't have is muted. */
    private fun color(value: JsonElement?): PlotColor? {
        val prim = value as? JsonPrimitive ?: return null
        if (prim.isString) {
            val tone = tone(prim.content)
            return if (tone == null || tone == Tone.Muted) PlotColor.Muted else PlotColor(null, tone)
        }
        return prim.intOrNull?.let { PlotColor(it) }
    }

    private fun tone(name: String): Tone? = Tone.entries.firstOrNull { it.name.equals(name, ignoreCase = true) }

    /** An optional tone: absent is null (the role's own colour); present but unknown is neutral. */
    private fun JsonObject.tone(): Tone? = string("tone")?.let { tone(it) ?: Tone.Neutral }

    private fun viewerItem(o: JsonObject): ViewerItem? {
        val file = o.string("file") ?: return null
        return ViewerItem(file, o.number("width")?.toInt() ?: 0, o.number("height")?.toInt() ?: 0, o.string("thumbhash") ?: "", o.string("alt") ?: "", o.string("caption"))
    }

    /**
     * Drops references a renderer can't follow: keys of dropped or missing
     * elements, and any edge that would revisit an element (a cycle, or one
     * element under two parents), so drawing is a finite tree walk.
     */
    private fun prune(elements: Map<String, Element>): Map<String, Element> {
        val seen = HashSet<String>()
        val out = LinkedHashMap<String, Element>()
        fun keep(keys: List<String>): List<String> = keys.filter { it in elements && seen.add(it) }
        fun visit(key: String) {
            val e = elements.getValue(key)
            val pruned = when (e) {
                is Element.Box -> e.copy(children = keep(e.children))
                is Element.Grid -> e.copy(children = keep(e.children))
                is Element.Scroll -> e.copy(children = keep(e.children))
                is Element.Press -> e.copy(children = keep(e.children))
                is Element.Switch -> e.copy(compact = keep(e.compact), regular = keep(e.regular))
                else -> e
            }
            out[key] = pruned
            val next = when (pruned) {
                is Element.Switch -> pruned.compact + pruned.regular
                else -> pruned.children
            }
            next.forEach(::visit)
        }
        // Every element is a possible root; walking from each unseen one keeps the first parent of each.
        for (key in elements.keys) if (seen.add(key)) visit(key)
        return out
    }

    private fun JsonObject?.slot(name: String): List<String> = when (val v = this?.get(name)) {
        is JsonPrimitive -> if (v.isString) listOf(v.content) else emptyList()
        is JsonArray -> v.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
        else -> emptyList()
    }

    /** The element's action; a missing, unknown or malformed one is [Action.Unsupported], never dropped. */
    private fun JsonObject.action(): Action {
        val a = obj("action") ?: return Action.Unsupported(null)
        val type = a.string("type")
        return when (type) {
            "message" -> a.string("text")?.let { Action.Message(it) }
            "open" -> a.string("url")?.let { Action.Open(it) }
            "copy" -> a.string("text")?.let { Action.Copy(it) }
            "tool" -> a.string("name")?.let { Action.Tool(it, a.obj("input") ?: JsonObject(emptyMap())) }
            "secret" -> GenUiActions.secret(a.obj("secret"))
            "cluster_secret" -> GenUiActions.clusterSecret(a.obj("secret"))
            "plugin" -> GenUiActions.plugin(a.obj("plugin"))
            else -> null
        } ?: Action.Unsupported(type)
    }

    private fun JsonObject.keys(key: String): List<String> = array(key).mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
    private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.number(key: String): Double? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }
    private fun JsonObject.bool(key: String): Boolean = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: false
    private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
    private fun JsonObject.array(key: String): List<JsonElement> = this[key] as? JsonArray ?: emptyList()
    private fun JsonObject.objects(key: String): List<JsonObject> = array(key).filterIsInstance<JsonObject>()

    private inline fun <reified E : Enum<E>> JsonObject.enumOrNull(key: String): E? {
        val raw = string(key)?.replace("-", "") ?: return null
        return enumValues<E>().firstOrNull { it.name.equals(raw, ignoreCase = true) }
    }

    private inline fun <reified E : Enum<E>> JsonObject.enum(key: String, default: E): E = enumOrNull<E>(key) ?: default
}
