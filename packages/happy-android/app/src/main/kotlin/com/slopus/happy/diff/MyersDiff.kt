package com.slopus.happy.diff

/*
 * Myers' O(ND) diff as jsdiff 8.0.3 implements it (src/diff/base.ts), with
 * the tokenizers happy-app's diff engine uses: lines (`diffLines`), arrays
 * with a comparator (`diffArrays`) and words with whitespace
 * (`diffWordsWithSpace`). The edit-graph walk, its diagonal pruning, the
 * tie-breaking between insertions and removals and the component merging
 * follow the original step for step, so the same inputs give the same
 * changes. Tokens are interned to integers first: equality is an
 * equivalence, so comparing ids is comparing tokens.
 *
 * jsdiff is distributed under the BSD 3-Clause License:
 *
 *   Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
 *   All rights reserved.
 *
 *   Redistribution and use in source and binary forms, with or without
 *   modification, are permitted provided that the following conditions are met:
 *
 *   1. Redistributions of source code must retain the above copyright notice, this
 *      list of conditions and the following disclaimer.
 *
 *   2. Redistributions in binary form must reproduce the above copyright notice,
 *      this list of conditions and the following disclaimer in the documentation
 *      and/or other materials provided with the distribution.
 *
 *   3. Neither the name of the copyright holder nor the names of its
 *      contributors may be used to endorse or promote products derived from
 *      this software without specific prior written permission.
 *
 *   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 *   AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 *   IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 *   DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 *   FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 *   DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 *   SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 *   CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 *   OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 *   OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
object MyersDiff {
    /** A run of tokens kept, added or removed; [count] is how many tokens. */
    data class Change<T>(val value: T, val count: Int, val added: Boolean, val removed: Boolean)

    /** jsdiff's `timeout` and `maxEditLength`: past either the diff gives up and returns null. */
    data class Budget(val timeoutMs: Long? = null, val maxEditLength: Int? = null) {
        companion object {
            val Unlimited = Budget()
        }
    }

    /** `diffLines`: each line keeps its `\n` or `\r\n`. */
    fun diffLines(oldText: String, newText: String, budget: Budget = Budget.Unlimited): List<Change<String>>? {
        val old = lineTokens(oldText)
        val new = lineTokens(newText)
        val interner = HashMap<String, Int>()
        val runs = run(intern(old, interner) { it }, intern(new, interner) { it }, budget) ?: return null
        return values(runs, old, new) { it.joinToString("") }
    }

    /** `diffArrays` with a comparator, given as the [key] two equal elements share. */
    fun diffArrays(
        old: List<String>,
        new: List<String>,
        key: (String) -> String = { it },
        budget: Budget = Budget.Unlimited,
    ): List<Change<List<String>>>? {
        val interner = HashMap<String, Int>()
        val runs = run(intern(old, interner, key), intern(new, interner, key), budget) ?: return null
        return values(runs, old, new) { it.toList() }
    }

    /** `diffWordsWithSpace`: words, runs of horizontal whitespace, single newlines and single other characters. */
    fun diffWordsWithSpace(oldText: String, newText: String): List<Change<String>> {
        val old = wordTokens(oldText)
        val new = wordTokens(newText)
        val interner = HashMap<String, Int>()
        val runs = run(intern(old, interner) { it }, intern(new, interner) { it }, Budget.Unlimited) ?: emptyList()
        return values(runs, old, new) { it.joinToString("") }
    }

    private inline fun intern(tokens: List<String>, interner: HashMap<String, Int>, key: (String) -> String): IntArray =
        IntArray(tokens.size) { interner.getOrPut(key(tokens[it])) { interner.size } }

    /** LineDiff's tokenizer: `split(/(\n|\r\n)/)`, separators glued onto their lines, the empty tail dropped. */
    internal fun lineTokens(text: String): List<String> {
        val tokens = ArrayList<String>()
        var start = 0
        var index = 0
        while (index < text.length) {
            when {
                text[index] == '\n' -> {
                    tokens.add(text.substring(start, index + 1))
                    index++
                    start = index
                }
                text[index] == '\r' && index + 1 < text.length && text[index + 1] == '\n' -> {
                    tokens.add(text.substring(start, index + 2))
                    index += 2
                    start = index
                }
                else -> index++
            }
        }
        if (start < text.length) tokens.add(text.substring(start))
        return tokens
    }

    /** `(\r?\n)|[word]+|[^\S\n\r]+|[^word]` with the `u` flag: by code point. */
    internal fun wordTokens(text: String): List<String> {
        val tokens = ArrayList<String>()
        var index = 0
        fun next(at: Int) = at + Character.charCount(text.codePointAt(at))
        while (index < text.length) {
            val code = text.codePointAt(index)
            val end = when {
                code == '\r'.code && index + 1 < text.length && text[index + 1] == '\n' -> index + 2
                code == '\n'.code -> index + 1
                isWordChar(code) -> {
                    var end = next(index)
                    while (end < text.length && isWordChar(text.codePointAt(end))) end = next(end)
                    end
                }
                isHorizontalSpace(code) -> {
                    var end = next(index)
                    while (end < text.length && isHorizontalSpace(text.codePointAt(end))) end = next(end)
                    end
                }
                else -> next(index)
            }
            tokens.add(text.substring(index, end))
            index = end
        }
        return tokens
    }

    /** jsdiff's `extendedWordChars`: ASCII letters, digits and `_`, the soft hyphen, Latin letters with diacritics. */
    private fun isWordChar(code: Int): Boolean = when (code) {
        in 0x61..0x7A, in 0x41..0x5A, in 0x30..0x39, 0x5F, 0xAD,
        in 0xC0..0xD6, in 0xD8..0xF6, in 0xF8..0x2C6, in 0x2C8..0x2D7, in 0x2DE..0x2FF, in 0x1E00..0x1EFF -> true
        else -> false
    }

    private fun isHorizontalSpace(code: Int) = code != '\n'.code && code != '\r'.code && JsText.isWhitespace(code)

    // The edit graph.

    private class Component(val count: Int, val added: Boolean, val removed: Boolean, val previous: Component?)

    private class Path(var oldPos: Int, var last: Component?)

    internal data class Run(val count: Int, val added: Boolean, val removed: Boolean)

    /** `diffWithOptionsObj`: the runs that turn [old] into [new], or null once the budget is spent. */
    internal fun run(old: IntArray, new: IntArray, budget: Budget): List<Run>? {
        val oldLen = old.size
        val newLen = new.size
        var maxEditLength = newLen + oldLen
        budget.maxEditLength?.let { maxEditLength = minOf(maxEditLength, it) }
        val deadline = budget.timeoutMs?.let { System.currentTimeMillis() + it }

        // Diagonals run from -(maxEditLength + 1) to maxEditLength + 1.
        val offset = maxOf(0, maxEditLength) + 1
        val bestPath = arrayOfNulls<Path>(offset * 2 + 1)

        fun extractCommon(path: Path, diagonal: Int): Int {
            var oldPos = path.oldPos
            var newPos = oldPos - diagonal
            var common = 0
            while (newPos + 1 < newLen && oldPos + 1 < oldLen && old[oldPos + 1] == new[newPos + 1]) {
                newPos++
                oldPos++
                common++
            }
            if (common > 0) path.last = Component(common, added = false, removed = false, previous = path.last)
            path.oldPos = oldPos
            return newPos
        }

        fun addToPath(path: Path, added: Boolean, removed: Boolean, oldPosInc: Int): Path {
            val last = path.last
            return if (last != null && last.added == added && last.removed == removed) {
                Path(path.oldPos + oldPosInc, Component(last.count + 1, added, removed, last.previous))
            } else {
                Path(path.oldPos + oldPosInc, Component(1, added, removed, last))
            }
        }

        val seed = Path(-1, null)
        var newPos = extractCommon(seed, 0)
        if (seed.oldPos + 1 >= oldLen && newPos + 1 >= newLen) return runs(seed.last)
        bestPath[offset] = seed

        var minDiagonal = Int.MIN_VALUE
        var maxDiagonal = Int.MAX_VALUE
        var editLength = 1
        while (editLength <= maxEditLength) {
            if (deadline != null && System.currentTimeMillis() > deadline) return null
            var diagonal = maxOf(minDiagonal, -editLength)
            while (diagonal <= minOf(maxDiagonal, editLength)) {
                val removePath = bestPath[offset + diagonal - 1]
                val addPath = bestPath[offset + diagonal + 1]
                if (removePath != null) bestPath[offset + diagonal - 1] = null
                var canAdd = false
                if (addPath != null) {
                    val addPathNewPos = addPath.oldPos - diagonal
                    canAdd = addPathNewPos in 0 until newLen
                }
                val canRemove = removePath != null && removePath.oldPos + 1 < oldLen
                if (!canAdd && !canRemove) {
                    bestPath[offset + diagonal] = null
                    diagonal += 2
                    continue
                }
                val basePath = if (!canRemove || (canAdd && removePath!!.oldPos < addPath!!.oldPos)) {
                    addToPath(addPath!!, added = true, removed = false, oldPosInc = 0)
                } else {
                    addToPath(removePath!!, added = false, removed = true, oldPosInc = 1)
                }
                newPos = extractCommon(basePath, diagonal)
                if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) return runs(basePath.last)
                bestPath[offset + diagonal] = basePath
                if (basePath.oldPos + 1 >= oldLen) maxDiagonal = minOf(maxDiagonal, diagonal - 1)
                if (newPos + 1 >= newLen) minDiagonal = maxOf(minDiagonal, diagonal + 1)
                diagonal += 2
            }
            editLength++
        }
        return null
    }

    private fun runs(last: Component?): List<Run> {
        val runs = ArrayList<Run>()
        var component = last
        while (component != null) {
            runs.add(Run(component.count, component.added, component.removed))
            component = component.previous
        }
        runs.reverse()
        return runs
    }

    /** `buildValues`: each run's tokens, from the new side unless removed. */
    private inline fun <T> values(runs: List<Run>, old: List<String>, new: List<String>, join: (List<String>) -> T): List<Change<T>> {
        var newPos = 0
        var oldPos = 0
        return runs.map { run ->
            val value = if (!run.removed) {
                val slice = new.subList(newPos, newPos + run.count)
                newPos += run.count
                if (!run.added) oldPos += run.count
                join(slice)
            } else {
                val slice = old.subList(oldPos, oldPos + run.count)
                oldPos += run.count
                join(slice)
            }
            Change(value, run.count, run.added, run.removed)
        }
    }
}
