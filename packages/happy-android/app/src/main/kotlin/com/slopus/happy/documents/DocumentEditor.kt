package com.slopus.happy.documents

import com.slopus.happy.documents.yjs.YAny
import com.slopus.happy.documents.yjs.YDoc
import com.slopus.happy.documents.yjs.YID
import com.slopus.happy.documents.yjs.YRelativePosition
import com.slopus.happy.documents.yjs.YTransaction
import com.slopus.happy.documents.yjs.YTransactionResult
import com.slopus.happy.documents.yjs.YType
import java.util.UUID

/** One line of the editor: a block without its children, at its depth. */
data class DocumentLine(
    val block: DocumentBlock,
    val depth: Int = 0,
    /** A numbered item's number. */
    val number: Int? = null,
) {
    val id: String get() = block.id
    /** UTF-16 length of what the line shows: its text, or one unit for a block without text. */
    val length: Int get() = if (block.isInline) block.plainText.length else 1
}

/** What a transaction changed in the lines: the lines in [range] replaced by [lines]. */
data class DocumentLinesChange(val range: IntRange, val lines: List<DocumentLine>, val local: Boolean)

/** A caret in the editor's terms: a block and a UTF-16 offset into its text, where a hard break counts as one. */
data class DocumentCaret(val id: String, val offset: Int)

/**
 * A document Surface open for editing (iOS's `DocumentEditor`): the Yjs
 * document and the blocks read from it, with every edit the editor makes
 * written as the Yjs structure y-prosemirror writes for the same edit in
 * BlockNote, so desktop reads exactly what was typed here.
 *
 * Belongs to one thread (the main thread in the app).
 */
class DocumentEditor(val doc: YDoc) {
    var blocks: List<DocumentBlock> = emptyList()
        private set
    var lines: List<DocumentLine> = emptyList()
        private set
    /** Every local change, as the update to send. */
    var onLocalUpdate: ((ByteArray) -> Unit)? = null
    /** Lines that changed, local or remote, after each transaction. */
    var onLinesChange: ((DocumentLinesChange) -> Unit)? = null

    private var cache = HashMap<YID, DocumentBlock>()
    internal var containers = HashMap<String, YType>()

    init {
        doc.onTransaction = { transactionEnded(it) }
        reread(null)
        lines = flatten(blocks)
    }

    private val fragment: YType get() = doc.getXmlFragment(DocumentSchema.FRAGMENT)
    private val rootGroup: YType? get() = fragment.children.firstOrNull { it.nodeName == "blockGroup" }

    private fun transactionEnded(result: YTransactionResult) {
        if (result.local) onLocalUpdate?.invoke(result.update)
        val dirty = HashSet<YID>()
        for (type in result.changed) {
            var current: YType? = type
            while (current != null) {
                val id = current.itemID
                if (current.nodeName == "blockContainer" && id != null) dirty += id
                current = current.parent
            }
        }
        val before = lines
        reread(dirty)
        val after = flatten(blocks)
        lines = after
        diff(before, after, result.local)?.let { onLinesChange?.invoke(it) }
    }

    /** Reads blocks again, reusing those no change touched. */
    private fun reread(dirty: Set<YID>?) {
        val nextCache = HashMap<YID, DocumentBlock>()
        val nextContainers = HashMap<String, YType>()
        // A reused block's descendants stay as they were; index them too.
        fun reuse(container: YType, block: DocumentBlock) {
            if (block.children.isEmpty()) return
            val group = container.children.drop(1).firstOrNull { it.nodeName == "blockGroup" } ?: return
            group.children.filter { it.nodeName == "blockContainer" }.zip(block.children).forEach { (child, childBlock) ->
                child.itemID?.let { nextCache[it] = childBlock }
                nextContainers[childBlock.id] = child
                reuse(child, childBlock)
            }
        }
        fun read(group: YType): List<DocumentBlock> = group.children.mapNotNull { container ->
            if (container.nodeName != "blockContainer") return@mapNotNull null
            val key = container.itemID ?: YID(-1, 0)
            val cached = cache[key]
            val block = if (dirty != null && key !in dirty && cached != null) {
                reuse(container, cached)
                cached
            } else {
                val read = DocumentReader.block(container)
                val childGroup = container.children.drop(1).firstOrNull { it.nodeName == "blockGroup" }
                read.copy(children = childGroup?.let { read(it) } ?: emptyList())
            }
            nextCache[key] = block
            nextContainers[block.id] = container
            block
        }
        blocks = rootGroup?.let(::read) ?: emptyList()
        cache = nextCache
        containers = nextContainers
    }

    fun line(id: String): DocumentLine? = lines.firstOrNull { it.id == id }
    fun lineIndex(id: String): Int? = lines.indexOfFirst { it.id == id }.takeIf { it >= 0 }

    /** Applies a change from the computer or another replica. */
    fun applyRemote(update: ByteArray) = doc.applyUpdate(update, origin = "remote")

    /** Sets a line's text and formats, writing only the difference. */
    fun setRuns(id: String, runs: List<DocumentRun>) {
        val container = containers[id] ?: return
        val element = container.children.firstOrNull() ?: return
        val line = line(id)?.takeIf { it.block.isInline } ?: return
        val code = line.block.type == "codeBlock"
        doc.transact { tr -> writeInline(tr, element, normalized(runs), code) }
    }

    /** Changes a line's type, keeping its text (a paragraph made a heading). */
    fun setType(id: String, type: String, props: Map<String, YAny> = emptyMap()) {
        val line = line(id) ?: return
        if (line.block.type == type) {
            setProps(id, props)
            return
        }
        var block = line.block.copy(type = type, props = carriedProps(line.block, type) + props)
        if (type == "codeBlock") block = block.copy(content = DocumentBlock.Content.Inline(listOf(DocumentRun(line.block.plainText))))
        replaceContent(id, block)
    }

    fun setProps(id: String, props: Map<String, YAny>) {
        val element = containers[id]?.children?.firstOrNull() ?: return
        doc.transact { tr ->
            for ((key, value) in props.entries.sortedBy { it.key }) if (element.attribute(key) != value) element.setAttribute(tr, key, value)
        }
    }

    fun toggleChecked(id: String) {
        val line = line(id)?.takeIf { it.block.type == "checkListItem" } ?: return
        setProps(id, mapOf("checked" to YAny.Bool(!line.block.checked)))
    }

    /**
     * Replaces the lines in [range] (end exclusive) with [new] ones: the one
     * primitive every structural edit (split, join, paste, indent, delete)
     * goes through. Lines keep their IDs where they stay; the tree is
     * written as the difference from what the document holds.
     */
    fun replaceLines(range: IntRange, new: List<DocumentLine>) {
        val all = lines.subList(0, range.first) + new + lines.subList(range.last + 1, lines.size)
        reconcile(tree(all))
    }

    /** Writes [desired] as the difference from the current blocks. */
    fun reconcile(desired: List<DocumentBlock>) {
        doc.transact { tr ->
            val group = rootGroup ?: YDoc.element("blockGroup").also { fragment.insert(tr, fragment.length, listOf(it)) }
            reconcile(tr, group, blocks, desired)
        }
    }

    private fun reconcile(tr: YTransaction, group: YType, current: List<DocumentBlock>, desired: List<DocumentBlock>) {
        val kept = keptIDs(current.map { it.id }, desired.map { it.id })
        // Blocks that leave this group, or move within it, go; a move is written as a new copy.
        for (block in current) {
            if (block.id in kept) continue
            val container = containers[block.id] ?: continue
            val index = group.indexOf(container) ?: continue
            group.delete(tr, index, 1)
        }
        val currentByID = HashMap<String, DocumentBlock>()
        for (block in current) currentByID.putIfAbsent(block.id, block)
        var previous: YType? = null
        for (block in desired) {
            val container = containers[block.id]
            val old = currentByID[block.id]
            if (block.id in kept && container != null && old != null) {
                update(tr, container, old, block)
                previous = container
            } else {
                val made = YDoc.element("blockContainer")
                group.insert(tr, previous?.item, listOf(made))
                fill(tr, made, block)
                previous = made
            }
        }
    }

    private fun update(tr: YTransaction, container: YType, old: DocumentBlock, new: DocumentBlock) {
        if (old.copy(children = emptyList()) != new.copy(children = emptyList())) {
            val element = container.children.firstOrNull()
            if (old.content is DocumentBlock.Content.Unsupported) {
                // Never written over: what this editor can't read stays as it is.
            } else if (old.type == new.type && element != null) {
                for ((key, value) in new.props.entries.sortedBy { it.key }) if (element.attribute(key) != value) element.setAttribute(tr, key, value)
                val content = new.content
                if (old.content != content && content is DocumentBlock.Content.Inline) writeInline(tr, element, normalized(content.runs), new.type == "codeBlock")
            } else {
                container.delete(tr, 0, 1)
                val made = YDoc.element(new.type)
                container.insert(tr, 0, listOf(made))
                fillElement(tr, made, new)
            }
        }
        val group = container.children.drop(1).firstOrNull { it.nodeName == "blockGroup" }
        if (new.children.isEmpty()) {
            if (group != null) container.indexOf(group)?.let { container.delete(tr, it, 1) }
        } else if (group != null) {
            reconcile(tr, group, old.children, new.children)
        } else {
            val made = YDoc.element("blockGroup")
            container.insert(tr, container.length, listOf(made))
            for (child in new.children.asReversed()) {
                val childContainer = YDoc.element("blockContainer")
                made.insert(tr, 0, listOf(childContainer))
                fill(tr, childContainer, child)
            }
        }
    }

    private fun replaceContent(id: String, block: DocumentBlock) {
        val container = containers[id] ?: return
        val old = container.itemID?.let { cache[it] } ?: return
        val next = block.copy(children = old.children)
        doc.transact { tr -> update(tr, container, old, next) }
    }

    /** Writes a new container's ID, content and children; it is in the document already. */
    private fun fill(tr: YTransaction, container: YType, block: DocumentBlock) {
        val element = YDoc.element(block.type)
        container.insert(tr, 0, listOf(element))
        fillElement(tr, element, block)
        if (block.children.isNotEmpty()) {
            val group = YDoc.element("blockGroup")
            container.insert(tr, 1, listOf(group))
            var previous: YType? = null
            for (child in block.children) {
                val childContainer = YDoc.element("blockContainer")
                group.insert(tr, previous?.item, listOf(childContainer))
                fill(tr, childContainer, child)
                previous = childContainer
            }
        }
        container.setAttribute(tr, "id", YAny.Str(block.id))
    }

    /**
     * A new content element's attributes and text, as y-prosemirror writes
     * a new node: every attribute the schema has, then the given ones.
     */
    private fun fillElement(tr: YTransaction, element: YType, block: DocumentBlock) {
        val content = block.content
        if (content is DocumentBlock.Content.Inline) writeInline(tr, element, normalized(content.runs), block.type == "codeBlock")
        val written = HashSet<String>()
        for ((key, value) in DocumentSchema.defaults(block.type)) {
            val final = block.props[key] ?: value
            written += key
            if (final != YAny.Undefined) element.setAttribute(tr, key, final)
        }
        for ((key, value) in block.props.entries.sortedBy { it.key }) {
            if (key !in written && value != YAny.Undefined) element.setAttribute(tr, key, value)
        }
    }

    private sealed class Segment {
        class Text(val runs: List<DocumentRun>) : Segment()
        data object HardBreak : Segment()
    }

    /**
     * Makes an element's text and hard breaks say [runs]: text the element
     * keeps is diffed in place, the rest replaced.
     */
    private fun writeInline(tr: YTransaction, element: YType, runs: List<DocumentRun>, code: Boolean) {
        val wanted = segments(runs, code)
        val children = element.children
        fun kindMatches(child: YType, segment: Segment) = when (segment) {
            is Segment.Text -> child.isText
            Segment.HardBreak -> child.nodeName == "hardBreak"
        }
        var prefix = 0
        while (prefix < children.size && prefix < wanted.size && kindMatches(children[prefix], wanted[prefix])) prefix++
        var suffix = 0
        while (suffix < children.size - prefix && suffix < wanted.size - prefix &&
            kindMatches(children[children.size - 1 - suffix], wanted[wanted.size - 1 - suffix])
        ) suffix++
        for (i in 0 until prefix) (wanted[i] as? Segment.Text)?.let { diffText(tr, children[i], it.runs) }
        for (i in 0 until suffix) (wanted[wanted.size - 1 - i] as? Segment.Text)?.let { diffText(tr, children[children.size - 1 - i], it.runs) }
        val removeCount = children.size - prefix - suffix
        if (removeCount > 0) element.delete(tr, prefix, removeCount)
        var at = prefix
        for (segment in wanted.subList(prefix, wanted.size - suffix)) {
            when (segment) {
                Segment.HardBreak -> element.insert(tr, at, listOf(YDoc.element("hardBreak")))
                is Segment.Text -> {
                    val text = YDoc.text()
                    element.insert(tr, at, listOf(text))
                    var index = 0
                    for (run in segment.runs) {
                        text.insertText(tr, index, run.text, pairs(run.marks))
                        index += run.text.length
                    }
                }
            }
            at++
        }
    }

    /**
     * Writes the difference between a text's content and [runs]: the
     * changed middle replaced, then formats fixed where only they changed.
     */
    private fun diffText(tr: YTransaction, text: YType, runs: List<DocumentRun>) {
        val old = text.toDelta().mapNotNull { op -> (op.insert as? YType.DeltaOp.Insert.Text)?.let { DocumentRun(it.text, op.attributes) } }
        if (old == runs) return
        val oldUnits = old.joinToString("") { it.text }
        val newUnits = runs.joinToString("") { it.text }
        val oldMarks = markIndex(old)
        val newMarks = markIndex(runs)
        var prefix = 0
        while (prefix < oldUnits.length && prefix < newUnits.length && oldUnits[prefix] == newUnits[prefix]) prefix++
        // Never split a surrogate pair: back off to the pair's start or end.
        if (prefix > 0 && oldUnits[prefix - 1].isHighSurrogate()) prefix--
        var suffix = 0
        while (suffix < oldUnits.length - prefix && suffix < newUnits.length - prefix &&
            oldUnits[oldUnits.length - 1 - suffix] == newUnits[newUnits.length - 1 - suffix]
        ) suffix++
        if (suffix > 0 && oldUnits[oldUnits.length - suffix].isLowSurrogate()) suffix--
        val deleteCount = oldUnits.length - prefix - suffix
        val insertEnd = newUnits.length - suffix
        // Formats in the kept parts first, while positions still match the old text.
        fixFormats(tr, text, oldMarks, newMarks, 0, prefix, 0, old, runs)
        fixFormats(tr, text, oldMarks, newMarks, oldUnits.length - suffix, oldUnits.length, insertEnd, old, runs)
        if (deleteCount > 0) text.deleteText(tr, prefix, deleteCount)
        if (insertEnd > prefix) {
            var index = prefix
            var position = 0
            for (run in runs) {
                val length = run.text.length
                val start = maxOf(position, prefix)
                val end = minOf(position + length, insertEnd)
                if (start < end) {
                    text.insertText(tr, index, run.text.substring(start - position, end - position), pairs(run.marks))
                    index += end - start
                }
                position += length
            }
        }
    }

    private fun fixFormats(
        tr: YTransaction, text: YType, old: IntArray, new: IntArray, from: Int, until: Int, newStart: Int,
        runsOld: List<DocumentRun>, runsNew: List<DocumentRun>,
    ) {
        var i = from
        while (i < until) {
            val target = runsNew[new[newStart + i - from]].marks
            if (runsOld[old[i]].marks == target) { i++; continue }
            var end = i + 1
            while (end < until && runsNew[new[newStart + end - from]].marks == target && runsOld[old[end]].marks != target) end++
            val attributes = pairs(target).toMutableList()
            val removed = sortedSetOf<String>()
            for (k in i until end) for (key in runsOld[old[k]].marks.keys) if (target[key] == null) removed += key
            for (key in removed) attributes += key to YAny.Null
            text.format(tr, i, end - i, attributes)
            i = end
        }
    }

    // Carets as relative positions, the way y-prosemirror makes them
    // (`absolutePositionToRelativePosition`, `relativePositionToAbsolutePosition`),
    // so a cursor sent from here lands where desktop draws it and back. They
    // also hold the local selection still while a remote edit merges.

    fun relativePosition(caret: DocumentCaret): YRelativePosition? {
        val element = contentElement(caret.id) ?: return null
        val children = element.children
        if (children.isEmpty()) return YRelativePosition(element.itemID, null, null)
        var remaining = maxOf(0, caret.offset)
        for (child in children) {
            if (child.isText) {
                if (child.length >= remaining) return YRelativePosition.from(child, remaining)
                remaining -= child.length
            } else {
                remaining -= 1
            }
        }
        return YRelativePosition.from(element, children.size)
    }

    fun caret(position: YRelativePosition): DocumentCaret? {
        val (type, index) = position.resolve(doc) ?: return null
        val element: YType
        var offset = 0
        if (type.isText) {
            element = type.parent ?: return null
            for (child in element.children) {
                if (child === type) break
                offset += if (child.isText) child.length else 1
            }
            offset += index
        } else {
            element = type
            for (child in type.children.take(index)) offset += if (child.isText) child.length else 1
        }
        var node: YType? = type
        while (node != null) {
            if (node.item?.deleted == true) return null
            node = node.parent
        }
        val container = element.parent?.takeIf { it.nodeName == "blockContainer" } ?: return null
        val id = container.attribute("id")?.stringValue ?: return null
        val line = line(id) ?: return null
        return DocumentCaret(id, minOf(offset, line.length))
    }

    private fun contentElement(id: String): YType? =
        containers[id]?.children?.firstOrNull()?.takeIf { it.nodeName != "blockGroup" }

    companion object {
        fun flatten(blocks: List<DocumentBlock>, depth: Int = 0): List<DocumentLine> {
            val out = ArrayList<DocumentLine>()
            flattenInto(blocks, depth, out)
            return out
        }

        private fun flattenInto(blocks: List<DocumentBlock>, depth: Int, out: MutableList<DocumentLine>) {
            var number = 0
            for (block in blocks) {
                if (block.type == "numberedListItem") {
                    val start = block.props["start"]?.numberValue
                    number = if (number == 0 && start != null) start.toInt() else number + 1
                } else {
                    number = 0
                }
                out += DocumentLine(block.copy(children = emptyList()), depth, if (block.type == "numberedListItem") number else null)
                flattenInto(block.children, depth + 1, out)
            }
        }

        internal fun diff(old: List<DocumentLine>, new: List<DocumentLine>, local: Boolean): DocumentLinesChange? {
            var prefix = 0
            while (prefix < old.size && prefix < new.size && old[prefix] == new[prefix]) prefix++
            if (prefix == old.size && prefix == new.size) return null
            var suffix = 0
            while (suffix < old.size - prefix && suffix < new.size - prefix && old[old.size - 1 - suffix] == new[new.size - 1 - suffix]) suffix++
            return DocumentLinesChange(prefix until old.size - suffix, new.subList(prefix, new.size - suffix).toList(), local)
        }

        /** The tree flat lines describe: a line deeper than the one before is its child. */
        fun tree(lines: List<DocumentLine>): List<DocumentBlock> {
            var index = 0
            fun build(depth: Int): MutableList<DocumentBlock> {
                val out = ArrayList<DocumentBlock>()
                while (index < lines.size) {
                    val line = lines[index]
                    val lineDepth = minOf(line.depth, if (out.isEmpty()) depth else depth + 1)
                    if (lineDepth < depth) break
                    if (lineDepth > depth) {
                        val last = out.last()
                        out[out.size - 1] = last.copy(children = last.children + build(depth + 1))
                        continue
                    }
                    out += line.block.copy(children = emptyList())
                    index++
                }
                return out
            }
            return build(0)
        }

        fun newID(): String = UUID.randomUUID().toString().lowercase()

        /** IDs both lists hold in the same relative order (a longest increasing run). */
        internal fun keptIDs(current: List<String>, desired: List<String>): Set<String> {
            val positions = HashMap<String, Int>()
            current.forEachIndexed { i, id -> positions.putIfAbsent(id, i) }
            val sequence = desired.mapNotNull { id -> positions[id]?.let { id to it } }
            // Patience sorting for the longest increasing subsequence of positions.
            val tails = ArrayList<Int>()
            val tailIndex = ArrayList<Int>()
            val parent = IntArray(sequence.size) { -1 }
            sequence.forEachIndexed { i, item ->
                var low = 0
                var high = tails.size
                while (low < high) {
                    val mid = (low + high) / 2
                    if (tails[mid] < item.second) low = mid + 1 else high = mid
                }
                if (low > 0) parent[i] = tailIndex[low - 1]
                if (low == tails.size) { tails += item.second; tailIndex += i } else { tails[low] = item.second; tailIndex[low] = i }
            }
            val kept = HashSet<String>()
            var k = tailIndex.lastOrNull() ?: -1
            while (k >= 0) {
                kept += sequence[k].first
                k = parent[k]
            }
            return kept
        }

        /** What a line keeps when it becomes another type: colors carry, the rest is the new type's. */
        fun carriedProps(block: DocumentBlock, type: String): Map<String, YAny> {
            val keys = DocumentSchema.defaults(type).map { it.first }.toSet()
            return block.props.filter { (key, _) -> key in keys && key in setOf("backgroundColor", "textColor", "textAlignment") }
        }

        /** Runs joined where their formats match, empty ones dropped. */
        internal fun normalized(runs: List<DocumentRun>): List<DocumentRun> {
            val out = ArrayList<DocumentRun>()
            for (run in runs) DocumentReader.append(out, run)
            return out
        }

        /** Text pieces between hard breaks; a code block's newlines stay in its text. */
        private fun segments(runs: List<DocumentRun>, code: Boolean): List<Segment> {
            if (code) return if (runs.isEmpty()) emptyList() else listOf(Segment.Text(runs))
            val out = ArrayList<Segment>()
            var pending = ArrayList<DocumentRun>()
            for (run in runs) {
                run.text.split('\n').forEachIndexed { index, part ->
                    if (index > 0) {
                        if (pending.isNotEmpty()) { out += Segment.Text(pending); pending = ArrayList() }
                        out += Segment.HardBreak
                    }
                    if (part.isNotEmpty()) DocumentReader.append(pending, DocumentRun(part, run.marks))
                }
            }
            if (pending.isNotEmpty()) out += Segment.Text(pending)
            return out
        }

        internal fun pairs(marks: Map<String, YAny>): List<Pair<String, YAny>> = marks.entries.sortedBy { it.key }.map { it.key to it.value }

        /** For each UTF-16 unit, which run it belongs to. */
        private fun markIndex(runs: List<DocumentRun>): IntArray {
            val out = IntArray(runs.sumOf { it.text.length })
            var at = 0
            runs.forEachIndexed { i, run -> repeat(run.text.length) { out[at++] = i } }
            return out
        }
    }
}
