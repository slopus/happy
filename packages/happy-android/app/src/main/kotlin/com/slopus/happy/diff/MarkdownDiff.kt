package com.slopus.happy.diff

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.chat.markdown.MarkdownSpan
import com.slopus.happy.chat.markdown.parseMarkdown

/**
 * Two versions of a Markdown document read as one (desktop fdd502ce,
 * `markdownDiffModel.ts`, and 0a740497): both are parsed with the chat's
 * own parser and cut into blocks, a list into its items. The blocks are
 * aligned by Myers over keys of what each renders (kind and text, so
 * whitespace that doesn't show is no change). A removed block and an added
 * one between the same aligned neighbours pair when they are the same kind
 * and share at least [PAIR_SIMILARITY] of their words (Dice), and a paired
 * paragraph, heading or item is diffed word by word with its formatting
 * kept; anything else stays a whole removal and addition.
 */
@Immutable
data class MarkdownDiff(val blocks: List<Entry>) {
    @Immutable
    sealed interface Entry {
        data class Same(val block: MarkdownBlock) : Entry
        data class Added(val block: MarkdownBlock) : Entry
        data class Removed(val block: MarkdownBlock) : Entry

        /** A block edited in place: [new]'s kind, with [spans] marking what each word did. */
        data class Changed(val old: MarkdownBlock, val new: MarkdownBlock, val spans: List<DiffWord>) : Entry
    }

    /** One run of a changed block's words, its formatting and whether it was kept, inserted or deleted. */
    @Immutable
    data class DiffWord(val span: MarkdownSpan, val change: WordChange)

    enum class WordChange { Kept, Inserted, Deleted }

    val changed: Boolean get() = blocks.any { it !is Entry.Same }

    companion object {
        const val PAIR_SIMILARITY = 0.4

        /** Unchanged blocks kept on each side of a change; a longer run folds (markdownDiffTree.ts). */
        const val CONTEXT = 2

        /** A fold hides at least this many blocks; fewer show (markdownDiffTree.ts `FOLD_MINIMUM`). */
        const val FOLD_MINIMUM = 2

        /** Off the main thread: parses, aligns and pairs. */
        fun compute(old: String, new: String): MarkdownDiff = compute(units(parseMarkdown(old)), units(parseMarkdown(new)))

        internal fun compute(before: List<MarkdownBlock>, after: List<MarkdownBlock>): MarkdownDiff {
            val beforeKeys = before.map(::key)
            val afterKeys = after.map(::key)
            val ids = HashMap<String, String>()
            fun id(key: String) = ids.getOrPut(key) { ids.size.toString() }
            val changes = MyersDiff.diffArrays(beforeKeys.map(::id), afterKeys.map(::id)) ?: emptyList()
            val out = ArrayList<Entry>()
            var b = 0
            var a = 0
            var removed = ArrayList<MarkdownBlock>()
            var added = ArrayList<MarkdownBlock>()
            fun flush() {
                out += pair(removed, added)
                removed = ArrayList()
                added = ArrayList()
            }
            for (change in changes) {
                when {
                    change.removed -> repeat(change.count) { removed += before[b++] }
                    change.added -> repeat(change.count) { added += after[a++] }
                    else -> {
                        flush()
                        repeat(change.count) { out += Entry.Same(after[a++]); b++ }
                    }
                }
            }
            flush()
            return MarkdownDiff(out)
        }

        /** The diff with long unchanged runs folded: rows to draw, a fold standing for what it hides. */
        fun rows(diff: MarkdownDiff, expanded: Set<Int> = emptySet()): List<Row> {
            val blocks = diff.blocks
            val rows = ArrayList<Row>()
            var index = 0
            while (index < blocks.size) {
                if (blocks[index] !is Entry.Same) {
                    rows += Row.Block(index, blocks[index])
                    index++
                    continue
                }
                var end = index
                while (end < blocks.size && blocks[end] is Entry.Same) end++
                val first = if (index == 0) 0 else index + CONTEXT
                val last = if (end == blocks.size) end else end - CONTEXT
                val hidden = last - first
                if (hidden >= FOLD_MINIMUM && first !in expanded && diff.changed) {
                    for (i in index until first) rows += Row.Block(i, blocks[i])
                    rows += Row.Fold(first, hidden)
                    for (i in last until end) rows += Row.Block(i, blocks[i])
                } else {
                    for (i in index until end) rows += Row.Block(i, blocks[i])
                }
                index = end
            }
            return rows
        }

        /** Blocks as the diff aligns them: a list is one unit per item. */
        internal fun units(blocks: List<MarkdownBlock>): List<MarkdownBlock> = blocks.flatMap { block ->
            when (block) {
                is MarkdownBlock.BulletList -> block.items.map { MarkdownBlock.BulletList(listOf(it)) }
                is MarkdownBlock.NumberedList -> block.items.map { MarkdownBlock.NumberedList(listOf(it)) }
                else -> listOf(block)
            }
        }

        private fun text(spans: List<MarkdownSpan>) = spans.joinToString("") { it.text }

        /** What a block renders, normalized: its kind and its words, whitespace collapsed. */
        internal fun key(block: MarkdownBlock): String {
            fun norm(text: String) = text.trim().replace(Regex("\\s+"), " ")
            fun styled(spans: List<MarkdownSpan>) = spans.joinToString("") { "${it.styles.sorted()}${it.url}|${norm(it.text)}" }
            return when (block) {
                is MarkdownBlock.Text -> "p:" + styled(block.content)
                is MarkdownBlock.Header -> "h${block.level}:" + styled(block.content)
                is MarkdownBlock.BulletList -> block.items.joinToString("\n") { "ul${it.depth}:" + styled(it.spans) }
                is MarkdownBlock.NumberedList -> block.items.joinToString("\n") { "ol${it.depth}:${it.number}:" + styled(it.spans) }
                is MarkdownBlock.CodeBlock -> "code:${block.language}:" + block.content
                is MarkdownBlock.Mermaid -> "mermaid:" + block.content
                MarkdownBlock.HorizontalRule -> "hr"
                is MarkdownBlock.Options -> "options:" + block.items.joinToString("\u0000")
                is MarkdownBlock.Table -> "table:" + (listOf(block.headers) + block.rows).joinToString("\n") { row -> row.joinToString("|") { styled(it) } }
                is MarkdownBlock.Image -> "img:${block.alt}:${block.url}"
            }
        }

        /** Its words, for similarity. */
        private fun words(block: MarkdownBlock): List<String> {
            val text = when (block) {
                is MarkdownBlock.Text -> text(block.content)
                is MarkdownBlock.Header -> text(block.content)
                is MarkdownBlock.BulletList -> block.items.joinToString(" ") { text(it.spans) }
                is MarkdownBlock.NumberedList -> block.items.joinToString(" ") { text(it.spans) }
                is MarkdownBlock.CodeBlock -> block.content
                is MarkdownBlock.Table -> (listOf(block.headers) + block.rows).flatten().joinToString(" ") { text(it) }
                else -> ""
            }
            return text.lowercase().split(Regex("\\W+")).filter { it.isNotEmpty() }
        }

        /** Dice similarity of two word multisets: 1 when they share every word, 0 when none. */
        internal fun similarity(before: MarkdownBlock, after: MarkdownBlock): Double {
            val x = words(before)
            val y = words(after)
            if (x.isEmpty() && y.isEmpty()) return if (before::class == after::class) 1.0 else 0.0
            val counts = HashMap<String, Int>()
            x.forEach { counts[it] = (counts[it] ?: 0) + 1 }
            var shared = 0
            for (word in y) {
                val left = counts[word] ?: 0
                if (left > 0) {
                    shared++
                    counts[word] = left - 1
                }
            }
            return 2.0 * shared / (x.size + y.size)
        }

        private fun sameKind(a: MarkdownBlock, b: MarkdownBlock) = when {
            a is MarkdownBlock.Header && b is MarkdownBlock.Header -> true
            a is MarkdownBlock.BulletList && b is MarkdownBlock.BulletList -> true
            a is MarkdownBlock.NumberedList && b is MarkdownBlock.NumberedList -> true
            else -> a::class == b::class
        }

        /**
         * What lay between two aligned blocks: each removed block pairs with
         * the most similar added one after the last pair, in order; the rest
         * are whole removals before additions, where they were.
         */
        private fun pair(removed: List<MarkdownBlock>, added: List<MarkdownBlock>): List<Entry> {
            if (removed.isEmpty()) return added.map(Entry::Added)
            if (added.isEmpty()) return removed.map(Entry::Removed)
            val out = ArrayList<Entry>()
            var nextAdded = 0
            for (old in removed) {
                var best = -1
                var bestScore = 0.0
                for (j in nextAdded until added.size) {
                    if (!sameKind(old, added[j])) continue
                    val score = similarity(old, added[j])
                    if (score >= PAIR_SIMILARITY && score > bestScore) {
                        best = j
                        bestScore = score
                    }
                }
                if (best < 0) {
                    out += Entry.Removed(old)
                    continue
                }
                for (j in nextAdded until best) out += Entry.Added(added[j])
                out += changed(old, added[best])
                nextAdded = best + 1
            }
            for (j in nextAdded until added.size) out += Entry.Added(added[j])
            return out
        }

        private fun inline(block: MarkdownBlock): List<MarkdownSpan>? = when (block) {
            is MarkdownBlock.Text -> block.content
            is MarkdownBlock.Header -> block.content
            is MarkdownBlock.BulletList -> block.items.singleOrNull()?.spans
            is MarkdownBlock.NumberedList -> block.items.singleOrNull()?.spans
            else -> null
        }

        /** A paired block: word by word where it is prose, else its two versions whole. */
        private fun changed(old: MarkdownBlock, new: MarkdownBlock): List<Entry> {
            val before = inline(old)
            val after = inline(new)
            if (before == null || after == null) return listOf(Entry.Removed(old), Entry.Added(new))
            return listOf(Entry.Changed(old, new, words(before, after)))
        }

        /** Words (and the spaces between them) of each side, each with its span's formatting, diffed by what they read. */
        internal fun words(before: List<MarkdownSpan>, after: List<MarkdownSpan>): List<DiffWord> {
            fun tokens(spans: List<MarkdownSpan>) = spans.flatMap { span ->
                Regex("\\s+|[\\p{L}\\p{N}_]+|.").findAll(span.text).map { span.copy(text = it.value) }.toList()
            }
            val x = tokens(before)
            val y = tokens(after)
            val changes = MyersDiff.diffArrays(x.map { "${it.styles.sorted()}${it.url}|${it.text}" }, y.map { "${it.styles.sorted()}${it.url}|${it.text}" }) ?: emptyList()
            val out = ArrayList<DiffWord>()
            var i = 0
            var j = 0
            for (change in changes) {
                when {
                    change.removed -> repeat(change.count) { out += DiffWord(x[i++], WordChange.Deleted) }
                    change.added -> repeat(change.count) { out += DiffWord(y[j++], WordChange.Inserted) }
                    else -> repeat(change.count) { out += DiffWord(y[j++], WordChange.Kept); i++ }
                }
            }
            // Neighbouring runs of the same span and change read as one.
            val merged = ArrayList<DiffWord>()
            for (word in out) {
                val last = merged.lastOrNull()
                if (last != null && last.change == word.change && last.span.styles == word.span.styles && last.span.url == word.span.url) {
                    merged[merged.lastIndex] = last.copy(span = last.span.copy(text = last.span.text + word.span.text))
                } else {
                    merged += word
                }
            }
            return merged
        }
    }

    /** A drawn row: a block, or a fold of [count] unchanged blocks from [first]. */
    sealed interface Row {
        data class Block(val index: Int, val entry: Entry) : Row
        data class Fold(val first: Int, val count: Int) : Row
    }
}
