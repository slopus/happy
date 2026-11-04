package com.slopus.happy.documents

import com.slopus.happy.documents.yjs.YAny
import com.slopus.happy.documents.yjs.YDoc
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.Base64

/**
 * iOS's document fixtures (`scripts/generate-document-fixtures.mjs` over
 * yjs 13.6.31 and BlockNote 0.51.4, the daemon's own conversion code):
 * documents, merges, cursors and an awareness update.
 */
object DocumentFixtures {
    val root: JsonObject by lazy {
        Json.parseToJsonElement(DocumentFixtures::class.java.getResource("/documents/documents.json")!!.readText()).jsonObject
    }
    val documents: List<JsonObject> get() = root["documents"]!!.jsonArray.map { it.jsonObject }
    val merges: List<JsonObject> get() = root["merges"]!!.jsonArray.map { it.jsonObject }
    val cursors: List<JsonObject> get() = root["cursors"]!!.jsonArray.map { it.jsonObject }
    val presence: JsonObject get() = root["presence"]!!.jsonObject

    fun bytes(value: JsonElement?): ByteArray = Base64.getDecoder().decode(value!!.jsonPrimitive.content)

    fun string(value: JsonElement?): String? = (value as? JsonPrimitive)?.takeIf { it.isString }?.content

    fun document(name: String): JsonObject = documents.first { string(it["name"]) == name }

    fun fixture(name: String): ByteArray = bytes(document(name)["update"])

    fun doc(update: ByteArray, client: Long = 999): YDoc = YDoc(client).also { it.applyUpdate(update) }

    class Box {
        val updates = ArrayList<ByteArray>()
        val changes = ArrayList<DocumentLinesChange>()
    }

    fun editor(update: ByteArray, client: Long = 77): Pair<DocumentEditor, Box> {
        val editor = DocumentEditor(doc(update, client))
        val box = Box()
        editor.onLocalUpdate = { box.updates += it }
        editor.onLinesChange = { box.changes += it }
        return editor to box
    }

    /** What another replica reads after receiving every update. */
    fun replay(base: ByteArray, updates: List<ByteArray>): List<DocumentBlock> {
        val doc = YDoc(5)
        doc.applyUpdate(base)
        updates.forEach(doc::applyUpdate)
        return DocumentReader.blocks(doc)
    }

    fun yany(value: JsonElement): YAny = YAny.parseJSON(value.toString())

    fun json(value: YAny): JsonElement = Json.parseToJsonElement(value.jsonString)
}

/** Blocks in the JSON shape BlockNote's `docToBlocks` gives, for comparing with it (iOS's `BlockNoteJSON`). */
object BlockNoteJSON {
    fun block(block: DocumentBlock): JsonElement {
        val props = LinkedHashMap<String, JsonElement>()
        for ((key, value) in DocumentSchema.defaults(block.type)) json(block.props[key] ?: value)?.let { props[key] = it }
        val out = LinkedHashMap<String, JsonElement>()
        out["id"] = JsonPrimitive(block.id)
        out["type"] = JsonPrimitive(block.type)
        out["props"] = JsonObject(props)
        out["children"] = JsonArray(block.children.map(::block))
        when (val content = block.content) {
            is DocumentBlock.Content.Inline -> out["content"] = inline(content.runs)
            is DocumentBlock.Content.Table -> out["content"] = JsonArray(content.rows.map { row -> JsonArray(row.map { cell -> JsonPrimitive(cell.joinToString("") { it.text }) }) })
            else -> Unit
        }
        return JsonObject(out)
    }

    private fun json(value: YAny): JsonElement? = when (value) {
        YAny.Undefined -> null
        YAny.Null -> JsonNull
        is YAny.Bool -> JsonPrimitive(value.value)
        is YAny.Number -> JsonPrimitive(value.value)
        is YAny.Str -> JsonPrimitive(value.value)
        else -> JsonPrimitive(value.jsonString)
    }

    private fun inline(runs: List<DocumentRun>): JsonArray {
        val out = ArrayList<JsonElement>()
        for (run in runs) {
            val styles = LinkedHashMap<String, JsonElement>()
            for ((key, value) in run.marks) {
                if (key == "link") continue
                styles[key] = if (key in DocumentSchema.booleanMarks) JsonPrimitive(true) else (value["stringValue"]?.let(::json) ?: JsonPrimitive(true))
            }
            val text = JsonObject(mapOf("type" to JsonPrimitive("text"), "text" to JsonPrimitive(run.text), "styles" to JsonObject(styles)))
            val href = run.marks["link"]?.get("href")?.stringValue
            if (href != null) {
                val last = out.lastOrNull() as? JsonObject
                if (last != null && DocumentFixtures.string(last["type"]) == "link" && DocumentFixtures.string(last["href"]) == href) {
                    out[out.size - 1] = JsonObject(last + ("content" to JsonArray(last["content"]!!.jsonArray + text)))
                } else {
                    out += JsonObject(mapOf("type" to JsonPrimitive("link"), "href" to JsonPrimitive(href), "content" to JsonArray(listOf(text))))
                }
            } else {
                out += text
            }
        }
        return JsonArray(out)
    }

    /** Tables compare by their cells' text; numbers by value; everything else as it is. */
    fun normalize(value: JsonElement?): JsonElement {
        fun walk(value: JsonElement): JsonElement = when (value) {
            is JsonObject -> {
                var obj: Map<String, JsonElement> = value
                if (DocumentFixtures.string(obj["type"]) == "table") {
                    val content = obj["content"] as? JsonObject
                    val rows = content?.get("rows") as? JsonArray
                    if (rows != null) {
                        obj = obj + ("content" to JsonArray(rows.map { row ->
                            JsonArray(row.jsonObject["cells"]!!.jsonArray.map { cell ->
                                JsonPrimitive((cell.jsonObject["content"] as? JsonArray).orEmpty().mapNotNull { DocumentFixtures.string(it.jsonObject["text"]) }.joinToString(""))
                            })
                        }))
                    }
                    obj = obj + ("props" to JsonObject(emptyMap()))
                }
                JsonObject(obj.mapValues { walk(it.value) })
            }
            is JsonArray -> JsonArray(value.map(::walk))
            is JsonPrimitive -> if (!value.isString && value.booleanOrNull == null && value.doubleOrNull != null) JsonPrimitive(value.doubleOrNull!!) else value
            else -> value
        }
        return walk(value ?: JsonNull)
    }
}
