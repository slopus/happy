package com.slopus.happy.chat.tools

import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// utils/codexPatchEntry.ts: what changed in each file of a Codex, Gemini or
// Happy Agent patch, whatever shape the provider sent it in.

/** One file's change (`CodexPatchEntry`), reduced to what the views read. */
data class PatchEntry(
    val kindType: String? = null,
    val movePath: String? = null,
    val diff: String? = null,
    val unifiedDiff: String? = null,
    val addContent: String? = null,
    val deleteContent: String? = null,
    val modifyOld: String? = null,
    val modifyNew: String? = null,
    val content: String? = null,
    val oldContent: String? = null,
    val newContent: String? = null,
) {
    companion object {
        fun read(o: JsonObject): PatchEntry {
            val kind = o["kind"].obj
            return PatchEntry(
                kindType = kind?.get("type").str ?: o["type"].str,
                movePath = kind?.get("move_path").str ?: o["move_path"].str,
                diff = o["diff"].str,
                unifiedDiff = o["unified_diff"].str,
                addContent = o["add"].obj?.get("content").str,
                deleteContent = o["delete"].obj?.get("content").str,
                modifyOld = o["modify"].obj?.let { it["old_content"].str.orEmpty() },
                modifyNew = o["modify"].obj?.let { it["new_content"].str.orEmpty() },
                content = o["content"].str,
                oldContent = o["oldContent"].str ?: o["old_content"].str,
                newContent = o["newContent"].str ?: o["new_content"].str,
            )
        }
    }
}

/** What a diff view draws for a change (`PatchInput`). */
sealed interface PatchInput {
    data class Patch(val patch: String) : PatchInput
    data class Pair(val oldText: String, val newText: String) : PatchInput
}

/** `getPatchChanges`: file path → change, in the provider's order; null when the input has none. */
fun patchChanges(input: JsonElement?): LinkedHashMap<String, PatchEntry>? {
    val o = input.obj ?: return null
    o["changes"].arr?.let { return changeList(it) }
    o["changes"].obj?.let { return changeMap(it) }
    o["fileChanges"].arr?.let { return changeList(it) }
    o["fileChanges"].obj?.let { return changeMap(it) }
    val envelope = o["patch"].str ?: o["input"].str ?: return null
    if (!envelope.contains("*** Begin Patch")) return null
    val changes = parseApplyPatchEnvelope(envelope) ?: return null
    val workdir = o["workdir"].str ?: return changes
    return LinkedHashMap<String, PatchEntry>().apply {
        for ((path, change) in changes) {
            put(patchPathWithWorkdir(path, workdir), change.copy(movePath = change.movePath?.let { patchPathWithWorkdir(it, workdir) }))
        }
    }
}

private fun changeMap(changes: JsonObject): LinkedHashMap<String, PatchEntry>? {
    if (changes.isEmpty() || changes.values.any { it.obj == null }) return null
    return changes.entries.associateTo(LinkedHashMap()) { (path, value) -> path to PatchEntry.read(value.obj!!) }
}

private fun changeList(changes: List<JsonElement>): LinkedHashMap<String, PatchEntry>? {
    val out = LinkedHashMap<String, PatchEntry>()
    for (change in changes) {
        val o = change.obj ?: continue
        val path = o["path"].str ?: continue
        val entry = PatchEntry.read(o)
        val type = entry.kindType
        out[path] = entry.copy(
            addContent = entry.addContent ?: if (type == "add") o["content"].str else null,
            deleteContent = entry.deleteContent ?: if (type == "delete") o["content"].str else null,
        )
    }
    return out.ifEmpty { null }
}

private val WINDOWS_ABSOLUTE = Regex("""^[A-Za-z]:[/\\]""")

private fun patchPathWithWorkdir(path: String, workdir: String): String {
    if (path.startsWith("/") || WINDOWS_ABSOLUTE.containsMatchIn(path)) return path
    val combined = "$workdir/$path"
    val parts = ArrayList<String>()
    for (part in combined.split('/')) {
        if (part.isEmpty() || part == ".") continue
        if (part == ".." && parts.isNotEmpty() && parts.last() != "..") parts.removeAt(parts.lastIndex)
        else if (part != ".." || !combined.startsWith("/")) parts.add(part)
    }
    return (if (combined.startsWith("/")) "/" else "") + parts.joinToString("/")
}

private val FILE_MARKER = Regex("""^\*\*\* (Add|Update|Delete) File: (.+)$""")
private val MOVE_MARKER = Regex("""^\*\*\* Move to: (.+)$""")

/** `parseApplyPatchEnvelope`: the `*** Begin Patch` format; null when it is not exactly that. */
fun parseApplyPatchEnvelope(patch: String): LinkedHashMap<String, PatchEntry>? {
    val lines = patch.replace("\r\n", "\n").split('\n')
    val end = lines.indexOf("*** End Patch")
    if (lines.firstOrNull() != "*** Begin Patch" || end < 0 || lines.drop(end + 1).any { it.isNotBlank() }) return null
    val changes = LinkedHashMap<String, PatchEntry>()
    val seen = HashSet<String>()
    var path: String? = null
    var action: String? = null
    var movePath: String? = null
    val addLines = ArrayList<String>()
    val oldLines = ArrayList<String>()
    val newLines = ArrayList<String>()

    fun flush() {
        val p = path
        if (p != null) {
            when (action) {
                "add" -> changes[p] = PatchEntry(kindType = "add", addContent = addLines.joinToString("\n"))
                "delete" -> changes[p] = PatchEntry(kindType = "delete")
                "update" -> changes[p] = PatchEntry(
                    kindType = "update",
                    movePath = movePath,
                    modifyOld = oldLines.joinToString("\n"),
                    modifyNew = newLines.joinToString("\n"),
                )
            }
        }
        path = null
        action = null
        movePath = null
        addLines.clear()
        oldLines.clear()
        newLines.clear()
    }

    for (line in lines.subList(1, end + 1)) {
        if (line.startsWith("*** ") || line == "***") {
            val file = FILE_MARKER.find(line)
            if (file != null) {
                flush()
                action = file.groupValues[1].lowercase()
                val p = file.groupValues[2].trim()
                // A map cannot hold two edits to one file: keep the raw envelope instead.
                if (p.isEmpty() || !seen.add(p)) return null
                path = p
                continue
            }
            val move = MOVE_MARKER.find(line)
            if (move != null && action == "update") {
                movePath = move.groupValues[1].trim()
                continue
            }
            if (line == "*** End Patch") {
                flush()
                continue
            }
            if (line == "*** End of File" && action == "update") continue
            return null
        }
        if (action == null || path == null) continue
        when (action) {
            "add" -> {
                if (!line.startsWith("+")) return null
                addLines.add(line.substring(1))
            }
            "delete" -> return null
            else -> when {
                line.startsWith("@@") -> {
                    val anchor = if (line.startsWith("@@ ")) line.substring(3) else ""
                    if (anchor.isNotEmpty()) {
                        oldLines.add(anchor)
                        newLines.add(anchor)
                    }
                }
                line.startsWith("+") -> newLines.add(line.substring(1))
                line.startsWith("-") -> oldLines.add(line.substring(1))
                else -> {
                    val content = if (line.startsWith(" ")) line.substring(1) else line
                    oldLines.add(content)
                    newLines.add(content)
                }
            }
        }
    }
    flush()
    return changes.ifEmpty { null }
}

private val UNIFIED_HUNK = Regex("""^@@+ -""", RegexOption.MULTILINE)

/** `looksLikeUnifiedDiff`: Codex reuses `diff` for whole-file bodies of adds and deletes. */
fun looksLikeUnifiedDiff(text: String): Boolean =
    UNIFIED_HUNK.containsMatchIn(text) || text.startsWith("--- ") || text.startsWith("diff --git ")

private fun wholeFile(kind: String?, content: String): PatchInput =
    if (kind == "delete") PatchInput.Pair(content, "") else PatchInput.Pair("", content)

/** `getPatchInput` */
fun patchInput(change: PatchEntry): PatchInput? {
    val kind = change.kindType
    change.diff?.let { return if (looksLikeUnifiedDiff(it)) PatchInput.Patch(it) else wholeFile(kind, it) }
    change.unifiedDiff?.let { return if (looksLikeUnifiedDiff(it)) PatchInput.Patch(it) else wholeFile(kind, it) }
    if (change.modifyOld != null || change.modifyNew != null) return PatchInput.Pair(change.modifyOld.orEmpty(), change.modifyNew.orEmpty())
    if (change.oldContent != null || change.newContent != null) return PatchInput.Pair(change.oldContent.orEmpty(), change.newContent.orEmpty())
    change.addContent?.let { return PatchInput.Pair("", it) }
    if (kind == "add" && change.content != null) return PatchInput.Pair("", change.content)
    change.deleteContent?.let { return PatchInput.Pair(it, "") }
    if (kind == "delete" && change.content != null) return PatchInput.Pair(change.content, "")
    return null
}

/** `getPatchKindLabel`: new, delete, move or edit. */
fun patchKindLabel(change: PatchEntry): String? = when (change.kindType) {
    "add" -> "new"
    "delete" -> "delete"
    "update" -> if (change.movePath != null) "move" else "edit"
    else -> null
}
