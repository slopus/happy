package com.slopus.happy.diff

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The port against happy-app's own answers. tools/diff/generate-vectors.mjs
 * runs jsdiff 8.0.3 and happy-app's engine (sources/components/diff/engine,
 * as TypeScript) over happy-ios's seeded cases:
 * - jsdiff-vectors.json: diffWordsWithSpace, diffLines (with and without
 *   maxEditLength) and diffArrays with a whitespace-blind comparator;
 * - diff-engine-vectors.json: parsePatch, buildDiffFromPatch,
 *   buildDiffFromContents (context, ignoreWhitespace, budgets, intraline
 *   off, tab width, highlight limits) with every row and span, and both
 *   stats functions. Syntax colouring is off, as it is by default there.
 */
class DiffEngineVectorsTest {
    private fun cases(name: String): List<JsonObject> {
        val text = requireNotNull(javaClass.classLoader!!.getResource("diff/$name")) { "missing diff/$name" }.readText()
        return Json.parseToJsonElement(text).jsonObject.getValue("cases").jsonArray.map { it.jsonObject }
    }

    private fun JsonObject.str(key: String) = getValue(key).jsonPrimitive.content

    private fun <T> changesJson(changes: List<MyersDiff.Change<T>>?, value: (T) -> JsonElement): JsonElement =
        changes?.let { list ->
            JsonArray(list.map { buildJsonObject { put("value", value(it.value)); put("count", it.count); put("added", it.added); put("removed", it.removed) } })
        } ?: JsonNull

    @Test
    fun jsdiffVectors() {
        val all = cases("jsdiff-vectors.json")
        assertTrue(all.size > 300)
        for ((index, case) in all.withIndex()) {
            val actual = when (case.str("kind")) {
                "words" -> changesJson(MyersDiff.diffWordsWithSpace(case.str("old"), case.str("new"))) { JsonPrimitive(it) }
                "lines" -> {
                    val budget = MyersDiff.Budget(maxEditLength = case["maxEditLength"]?.jsonPrimitive?.int)
                    changesJson(MyersDiff.diffLines(case.str("old"), case.str("new"), budget)) { JsonPrimitive(it) }
                }
                "arrays" -> {
                    val old = case.getValue("old").jsonArray.map { it.jsonPrimitive.content }
                    val new = case.getValue("new").jsonArray.map { it.jsonPrimitive.content }
                    changesJson(MyersDiff.diffArrays(old, new, JsText::stripWhitespace)) { list -> JsonArray(list.map(::JsonPrimitive)) }
                }
                else -> error("unknown case ${case.str("kind")}")
            }
            assertEquals("case $index: $case", normalize(case.getValue("expected")), actual)
        }
    }

    @Test
    fun engineVectors() {
        val all = cases("diff-engine-vectors.json")
        assertTrue(all.size > 300)
        for ((index, case) in all.withIndex()) {
            DiffBuilder.clearCache()
            val actual: JsonElement = when (case.str("kind")) {
                "parse" -> JsonArray(PatchParser.parse(case.str("patch")).map(::rawFileJson))
                "patch" -> documentJson(DiffBuilder.fromPatch(case.str("patch"), options(case.getValue("options").jsonObject)))
                "contents" -> documentJson(
                    DiffBuilder.fromContents(case.str("path"), case.str("oldText"), case.str("newText"), options(case.getValue("options").jsonObject)),
                )
                "stats" -> DiffStats.countPatch(case.str("patch")).let { countsJson(it) }
                "contentStats" -> DiffStats.countContents(case.str("oldText"), case.str("newText")).let { countsJson(it) }
                else -> error("unknown case ${case.str("kind")}")
            }
            assertEquals("case $index (${case.str("kind")})", case.getValue("expected"), actual)
        }
    }

    /** jsdiff leaves `added`/`removed` out nowhere in 8.0.3, but be safe about booleans written as absent. */
    private fun normalize(element: JsonElement): JsonElement = when (element) {
        is JsonArray -> JsonArray(element.map(::normalize))
        is JsonObject -> if ("count" in element) {
            buildJsonObject {
                put("value", element.getValue("value"))
                put("count", element.getValue("count").jsonPrimitive.int)
                put("added", element["added"]?.jsonPrimitive?.booleanOrNull ?: false)
                put("removed", element["removed"]?.jsonPrimitive?.booleanOrNull ?: false)
            }
        } else element
        else -> element
    }

    private fun options(json: JsonObject) = BuildOptions(
        contextLines = json["contextLines"]?.jsonPrimitive?.intOrNull ?: 3,
        ignoreWhitespace = json["ignoreWhitespace"]?.jsonPrimitive?.booleanOrNull ?: false,
        diffBudget = json["diffBudget"]?.jsonObject?.let { DiffBudget(it.getValue("timeoutMs").jsonPrimitive.long, it.getValue("maxEditLength").jsonPrimitive.int) },
        intraline = json["intraline"]?.jsonPrimitive?.booleanOrNull ?: true,
        tabWidth = json["tabWidth"]?.jsonPrimitive?.intOrNull ?: 4,
        maxHighlightLines = json["maxHighlightLines"]?.jsonPrimitive?.intOrNull ?: 8000,
    )

    private fun countsJson(counts: DiffStats.Counts) = buildJsonObject {
        put("additions", counts.additions)
        put("deletions", counts.deletions)
    }

    private fun rawFileJson(file: RawFile) = buildJsonObject {
        put("path", file.path)
        file.oldPath?.let { put("oldPath", it) }
        put("kind", file.kind.wire)
        put("hunks", JsonArray(file.hunks.map { hunk ->
            buildJsonObject {
                put("oldStart", hunk.oldStart)
                put("oldLines", hunk.oldLines)
                put("newStart", hunk.newStart)
                put("newLines", hunk.newLines)
                put("section", hunk.section)
                put("lines", JsonArray(hunk.lines.map { line ->
                    buildJsonObject {
                        put("type", line.type.wire)
                        put("text", line.text)
                        line.oldNo?.let { put("oldNo", it) }
                        line.newNo?.let { put("newNo", it) }
                    }
                }))
            }
        }))
    }

    private fun documentJson(doc: DiffDocument) = buildJsonObject {
        put("files", JsonArray(doc.files.map { file ->
            buildJsonObject {
                put("path", file.path)
                file.oldPath?.let { put("oldPath", it) }
                put("kind", file.kind.wire)
                put("language", file.language?.let(::JsonPrimitive) ?: JsonNull)
                put("additions", file.additions)
                put("deletions", file.deletions)
                put("rows", buildJsonArray { file.rows.forEach { add(rowJson(it)) } })
                put("maxColumns", file.maxColumns)
                put("maxLineNo", file.maxLineNo)
            }
        }))
        put("additions", doc.additions)
        put("deletions", doc.deletions)
        doc.error?.let { put("error", it) }
    }

    private fun rowJson(row: DiffRow): JsonObject = when (row) {
        is DiffRow.Hunk -> buildJsonObject {
            put("kind", "hunk")
            put("key", row.key)
            put("text", row.text)
            put("section", row.section)
            row.hidden?.let { put("hidden", it) }
        }
        is DiffRow.Line -> buildJsonObject {
            put("kind", "line")
            put("key", row.key)
            put("type", row.type.wire)
            row.oldNo?.let { put("oldNo", it) }
            row.newNo?.let { put("newNo", it) }
            put("text", row.text)
            put("spans", JsonArray(row.spans.map { span ->
                buildJsonObject {
                    put("t", span.text)
                    put("k", span.kind.wire)
                    put("e", span.emphasis.ordinal)
                }
            }))
        }
        is DiffRow.Message -> buildJsonObject {
            put("kind", "message")
            put("key", row.key)
            put("code", row.code.wire)
        }
    }
}
