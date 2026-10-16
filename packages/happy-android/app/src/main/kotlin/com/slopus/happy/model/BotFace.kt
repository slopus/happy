package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlin.random.Random

// The face a new bot is given, drawn from a seed (utils/botFace.ts), and the
// name it goes by (utils/botName.ts). Every face is DiceBear's Adventurer
// Neutral (Lisa Wischofsky, CC BY 4.0), the style definition bundled as
// assets/botface/adventurer-neutral.json exactly as @dicebear/styles 10.6.0
// ships it. What @dicebear/core 10.7.0 does with it for `{ seed, size }` is
// reproduced here: the same seed resolves to the same face as on happy-app
// and the desktop, offline and in a test.

/** One of the four faces offered for a new bot, by position. */
const val BOT_FACE_COUNT = 4

/** The raster the daemon keeps: 256px is more than any face is shown at. */
const val BOT_FACE_PAINT_SIZE = 256

/** Where the style definition is bundled. */
const val BOT_FACE_STYLE_ASSET = "botface/adventurer-neutral.json"

/** rollBotFaceSeeds: four fresh seeds, eight base-36 characters each. */
fun rollBotFaceSeeds(random: Random = Random.Default): List<String> =
    List(BOT_FACE_COUNT) { CharArray(8) { "0123456789abcdefghijklmnopqrstuvwxyz"[random.nextInt(36)] }.concatToString() }

/** DiceBear's FNV-1a 32-bit hash over UTF-16 code units, as an unsigned value. */
internal fun fnv1a(input: String): Int {
    var hash = 0x811c9dc5.toInt()
    for (char in input) {
        hash = hash xor char.code
        hash *= 0x01000193
    }
    return hash
}

/** DiceBear's Mulberry32: stateful, seeded with a 32-bit value. */
internal class Mulberry32(private var state: Int) {
    fun next(): Long {
        state += 0x6d2b79f5
        val z = state
        var t = (z xor (z ushr 15)) * (z or 1)
        t = t xor (t + (t xor (t ushr 7)) * (t or 61))
        return (t xor (t ushr 14)).toLong() and 0xffffffffL
    }

    fun nextFloat(): Double = next() / 4294967296.0
}

/** DiceBear's key-based Prng: every value depends on `seed:key` only, never on call order. */
internal class DiceBearPrng(private val seed: String) {
    fun value(key: String): Double = Mulberry32(fnv1a("$seed:$key")).nextFloat()

    fun bool(key: String, likelihood: Double): Boolean = value(key) * 100 < likelihood

    fun weightedPick(key: String, weights: Map<String, Double>): String? {
        if (weights.isEmpty()) return null
        val sorted = weights.keys.sorted()
        if (sorted.size == 1) return sorted[0]
        val total = sorted.sumOf { weights.getValue(it) }
        if (total == 0.0) return pick(key, sorted)
        val threshold = value(key) * total
        var cumulative = 0.0
        for (name in sorted) {
            cumulative += weights.getValue(name)
            if (threshold < cumulative) return name
        }
        return sorted.last()
    }

    fun pick(key: String, items: List<String>): String? {
        if (items.size <= 1) return items.firstOrNull()
        val unique = items.distinct().sorted()
        return unique[(value(key) * unique.size).toInt()]
    }

    fun shuffle(key: String, items: List<String>): List<String> {
        if (items.size <= 1) return items.toList()
        val result = items.distinct().sorted().toMutableList()
        val prng = Mulberry32(fnv1a("$seed:$key"))
        for (i in result.size - 1 downTo 1) {
            val j = (prng.nextFloat() * (i + 1)).toInt()
            val swap = result[i]
            result[i] = result[j]
            result[j] = swap
        }
        return result
    }
}

/** A fill as the style writes it: a colour of its own, a palette by name, or none. */
@Immutable
sealed interface FaceFill {
    data class Literal(val value: String) : FaceFill
    data class Palette(val name: String) : FaceFill
}

/** The SVG the style draws with: groups, paths and ellipses, each filling or inheriting a fill. */
@Immutable
sealed interface FaceShape {
    val fill: FaceFill?

    data class Group(override val fill: FaceFill?, val children: List<FaceShape>) : FaceShape
    data class Path(override val fill: FaceFill?, val d: String, val evenOdd: Boolean) : FaceShape
    data class Ellipse(override val fill: FaceFill?, val cx: Float, val cy: Float, val rx: Float, val ry: Float) : FaceShape
}

/** A component's variant: what it draws, and how often it is picked against its siblings. */
@Immutable
data class FaceVariant(val weight: Double, val shapes: List<FaceShape>)

@Immutable
data class FaceComponent(val probability: Double, val variants: Map<String, FaceVariant>)

/** Where the canvas places a component: its `translate(x y)`. */
@Immutable
data class FaceSlot(val component: String, val x: Float, val y: Float)

/**
 * The parts of a DiceBear style definition Adventurer Neutral uses: the
 * canvas and its components in drawing order, the palettes, and its credit.
 */
@Immutable
data class BotFaceStyle(
    val width: Float,
    val height: Float,
    val slots: List<FaceSlot>,
    val components: Map<String, FaceComponent>,
    val palettes: Map<String, List<String>>,
    /** botFaceCredit: who drew the pack, and where her work is. */
    val artist: String,
    val artistUrl: String,
) {
    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun parse(text: String): BotFaceStyle {
            val root = json.parseToJsonElement(text) as JsonObject
            val canvas = root.obj("canvas")
            val creator = root.obj("meta").obj("creator")
            return BotFaceStyle(
                width = canvas.number("width").toFloat(),
                height = canvas.number("height").toFloat(),
                slots = (canvas["elements"] as JsonArray).map { element ->
                    val o = element as JsonObject
                    require(o.string("type") == "component") { "The canvas draws only components" }
                    val (x, y) = translation(o.attributes()?.let { (it["transform"] as? JsonPrimitive)?.content })
                    FaceSlot(o.string("name")!!, x, y)
                },
                components = root.obj("components").mapValues { (_, value) ->
                    val o = value as JsonObject
                    FaceComponent(
                        probability = (o["probability"] as? JsonPrimitive)?.doubleOrNull ?: 100.0,
                        variants = o.obj("variants").mapValues { (_, variant) ->
                            val v = variant as JsonObject
                            FaceVariant((v["weight"] as? JsonPrimitive)?.doubleOrNull ?: 1.0, shapes(v["elements"]))
                        },
                    )
                },
                palettes = root.obj("colors").mapValues { (_, value) ->
                    ((value as JsonObject)["values"] as JsonArray).map { toHex((it as JsonPrimitive).content) }
                },
                artist = creator.string("name").orEmpty(),
                artistUrl = creator.string("url").orEmpty(),
            )
        }

        private fun shapes(value: JsonElement?): List<FaceShape> = (value as? JsonArray).orEmpty().mapNotNull { element ->
            val o = element as JsonObject
            val attributes = o.attributes() ?: JsonObject(emptyMap())
            val fill = when (val raw = attributes["fill"]) {
                is JsonPrimitive -> FaceFill.Literal(raw.content)
                is JsonObject -> raw.string("name")?.let(FaceFill::Palette)
                else -> null
            }
            fun float(key: String) = (attributes[key] as? JsonPrimitive)?.content?.toFloatOrNull() ?: 0f
            when (o.string("name")) {
                "g" -> FaceShape.Group(fill, shapes(o["children"]))
                "path" -> FaceShape.Path(fill, attributes.string("d").orEmpty(), attributes.string("fill-rule") == "evenodd")
                "ellipse" -> FaceShape.Ellipse(fill, float("cx"), float("cy"), float("rx"), float("ry"))
                else -> null
            }
        }

        /** The only transform the canvas writes: `translate(x y)`, comma or space between. */
        private fun translation(transform: String?): Pair<Float, Float> {
            val numbers = transform?.substringAfter("translate(", "")?.substringBefore(")")
                ?.split(' ', ',')?.mapNotNull { it.trim().toFloatOrNull() }.orEmpty()
            return (numbers.getOrNull(0) ?: 0f) to (numbers.getOrNull(1) ?: 0f)
        }

        /** Color.toHex: lowercase, `#rgb` and `#rgba` widened. */
        private fun toHex(color: String): String {
            val h = color.removePrefix("#").lowercase()
            return when (h.length) {
                3, 4 -> "#" + h.map { "$it$it" }.joinToString("")
                else -> "#$h"
            }
        }

        private fun JsonObject.obj(key: String) = this[key] as JsonObject
        private fun JsonObject.attributes() = this["attributes"] as? JsonObject
        private fun JsonObject.string(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        private fun JsonObject.number(key: String) = (this[key] as JsonPrimitive).doubleOrNull ?: 0.0
    }
}

/** One placed component of a face: the variant picked and where the canvas puts it. */
@Immutable
data class PlacedFacePart(val component: String, val variant: String, val x: Float, val y: Float, val shapes: List<FaceShape>)

/**
 * A seed's face, resolved: the background colour and the parts in drawing
 * order, with every palette the parts name settled to one colour.
 */
@Immutable
data class BotFace(
    val seed: String,
    val width: Float,
    val height: Float,
    val background: String?,
    val parts: List<PlacedFacePart>,
    val colors: Map<String, String>,
) {
    /** What a part's [fill] paints with; null draws nothing (SVG's `none`). */
    fun color(fill: FaceFill?): String? = when (fill) {
        null -> null
        is FaceFill.Literal -> fill.value.takeIf { it != "none" }
        is FaceFill.Palette -> colors[fill.name]
    }
}

/**
 * DiceBear's Resolver and Renderer for `{ seed }` alone: no flip, scale,
 * rotation or rounding; each component shown by its probability, its
 * variant by weight; each palette shuffled by the seed and its first
 * colour taken.
 */
fun resolveBotFace(style: BotFaceStyle, seed: String): BotFace {
    val prng = DiceBearPrng(seed)
    val colors = style.palettes.mapValues { (name, values) -> prng.shuffle("${name}Color", values).first() }
    val parts = style.slots.mapNotNull { slot ->
        val component = style.components[slot.component] ?: return@mapNotNull null
        if (!prng.bool("${slot.component}Probability", component.probability)) return@mapNotNull null
        val variant = prng.weightedPick("${slot.component}Variant", component.variants.mapValues { it.value.weight }) ?: return@mapNotNull null
        PlacedFacePart(slot.component, variant, slot.x, slot.y, component.variants.getValue(variant).shapes)
    }
    return BotFace(seed, style.width, style.height, colors["background"], parts, colors)
}

/** The daemon's ceiling on a bot's name (Happy Agent's `botNameSchema`). */
const val BOT_NAME_MAX_LENGTH = 256

private val CONTROL_CHARACTERS = Regex("[\\x00-\\x1f\\x7f]")

/** sanitizeBotName: a pasted line break or tab becomes a space, and the ceiling is kept. */
fun sanitizeBotName(input: String): String = input.replace(CONTROL_CHARACTERS, " ").take(BOT_NAME_MAX_LENGTH)

/** isValidBotName: nonblank once trimmed, within the ceiling, no control characters. */
fun isValidBotName(name: String): Boolean = describeBotNameProblem(name) == null

/** describeBotNameProblem: why the daemon would refuse [name], in the person's words; null when it's fine. */
fun describeBotNameProblem(name: String): String? {
    val trimmed = name.trim()
    return when {
        trimmed.isEmpty() -> "Give the bot a name"
        trimmed.length > BOT_NAME_MAX_LENGTH -> "A bot's name is at most $BOT_NAME_MAX_LENGTH characters"
        CONTROL_CHARACTERS.containsMatchIn(trimmed) -> "A bot's name cannot contain line breaks or control characters"
        else -> null
    }
}

/**
 * useNewSessionDraft's bot fields: whether the composer makes a bot, its
 * name, the four faces on offer and the one picked. Memory only: a
 * restarted app offers a session, the ordinary case.
 */
@Immutable
data class BotDraft(
    val creating: Boolean = false,
    val name: String = "",
    val seeds: List<String>,
    val slot: Int = 0,
) {
    val faceSeed: String get() = seeds[slot]
}

/** What a bot start asks for: its name, trimmed, and the face it will wear. */
data class BotRequest(val name: String, val faceSeed: String)
