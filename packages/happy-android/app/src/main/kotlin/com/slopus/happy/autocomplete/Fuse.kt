package com.slopus.happy.autocomplete

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/** A searched field and its weight; weights are normalised to sum to 1. */
class FuseKey<T>(val weight: Double, val get: (T) -> String?)

/**
 * The part of Fuse.js 7.1 that happy-app's suggestions use: object lists,
 * weighted keys, extended search (`=exact`, `'include`, `^prefix`,
 * `suffix$`, `!not`, `!^`, `!…$`, fuzzy otherwise; spaces AND, `|` OR),
 * case-insensitive Bitap with [ignoreLocation], field-length norm, and the
 * same scores and order. Diacritics, match indices and logical queries
 * aren't ported.
 */
class Fuse<T>(
    private val items: List<T>,
    keys: List<FuseKey<T>>,
    private val threshold: Double = 0.6,
    private val ignoreLocation: Boolean = false,
    private val location: Int = 0,
    private val distance: Int = 100,
    private val useExtendedSearch: Boolean = false,
) {
    private class Field(val value: String, val norm: Double)

    private val weights: List<Double>
    private val records: List<List<Field?>>

    init {
        val total = keys.sumOf { it.weight }
        weights = keys.map { it.weight / total }
        val norms = HashMap<Int, Double>()
        records = items.map { item ->
            keys.map { key ->
                key.get(item)?.takeIf { it.isNotBlank() }?.let { value ->
                    val tokens = value.split(' ').count { it.isNotEmpty() }
                    // 1/sqrt(tokens), to 3 decimals.
                    Field(value, norms.getOrPut(tokens) { (1 / tokens.toDouble().pow(0.5) * 1000).roundToInt() / 1000.0 })
                }
            }
        }
    }

    data class Result<T>(val item: T, val index: Int, val score: Double)

    fun search(query: String, limit: Int = -1): List<Result<T>> {
        val searcher: (String) -> Match = if (useExtendedSearch) extendedSearcher(query) else bitapSearcher(query)
        val results = ArrayList<Result<T>>()
        records.forEachIndexed { index, fields ->
            var matched = false
            var total = 1.0
            fields.forEachIndexed { keyIndex, field ->
                if (field == null) return@forEachIndexed
                val match = searcher(field.value)
                if (match.isMatch) {
                    matched = true
                    val weight = weights[keyIndex]
                    val score = if (match.score == 0.0 && weight != 0.0) Math.ulp(1.0) else match.score
                    total *= score.pow(weight * field.norm)
                }
            }
            if (matched) results += Result(items[index], index, total)
        }
        results.sortWith(compareBy<Result<T>> { it.score }.thenBy { it.index })
        return if (limit > -1) results.take(limit) else results
    }

    private data class Match(val isMatch: Boolean, val score: Double)

    private fun bitapSearcher(pattern: String): (String) -> Match {
        val bitap = Bitap(pattern.lowercase())
        return { text -> bitap.searchIn(text.lowercase()) }
    }

    private fun extendedSearcher(pattern: String): (String) -> Match {
        val query = parseQuery(pattern.lowercase())
        return search@{ raw ->
            val text = raw.lowercase()
            for (group in query) {
                var total = 0.0
                var matches = 0
                for (searcher in group) {
                    val match = searcher(text)
                    if (!match.isMatch) {
                        total = 0.0
                        matches = 0
                        break
                    }
                    matches++
                    total += match.score
                }
                if (matches > 0) return@search Match(true, total / matches)
            }
            Match(false, 1.0)
        }
    }

    private fun exact(isMatch: Boolean) = Match(isMatch, if (isMatch) 0.0 else 1.0)

    /** parseQuery.js: `|` splits ORs, spaces outside quotes split ANDs. */
    private fun parseQuery(pattern: String): List<List<(String) -> Match>> = pattern.split('|').map { group ->
        group.trim().split(SPACE).filter { it.isNotBlank() }.map { token ->
            matcher(token, quoted = true) ?: matcher(token, quoted = false)!!
        }
    }

    private fun matcher(token: String, quoted: Boolean): ((String) -> Match)? {
        for ((type, single, multi) in MATCHERS) {
            val value = (if (quoted) multi else single).matchEntire(token)?.groupValues?.get(1) ?: continue
            return when (type) {
                Type.Exact -> { text -> exact(text == value) }
                Type.Include -> { text -> exact(text.contains(value)) }
                Type.Prefix -> { text -> exact(text.startsWith(value)) }
                Type.InversePrefix -> { text -> exact(!text.startsWith(value)) }
                Type.InverseSuffix -> { text -> exact(!text.endsWith(value)) }
                Type.Suffix -> { text -> exact(text.endsWith(value)) }
                Type.Inverse -> { text -> exact(!text.contains(value)) }
                Type.Fuzzy -> Bitap(value)::searchIn
            }
        }
        return null
    }

    private enum class Type { Exact, Include, Prefix, InversePrefix, InverseSuffix, Suffix, Inverse, Fuzzy }

    /** bitap/index.js: patterns over 32 chars search in 32-char chunks. */
    private inner class Bitap(private val pattern: String) {
        private val chunks: List<Pair<String, Int>> = when {
            pattern.isEmpty() -> emptyList()
            pattern.length <= MAX_BITS -> listOf(pattern to 0)
            else -> buildList {
                val remainder = pattern.length % MAX_BITS
                var i = 0
                while (i < pattern.length - remainder) {
                    add(pattern.substring(i, i + MAX_BITS) to i)
                    i += MAX_BITS
                }
                if (remainder > 0) add(pattern.substring(pattern.length - MAX_BITS) to pattern.length - MAX_BITS)
            }
        }

        fun searchIn(text: String): Match {
            if (pattern == text) return Match(true, 0.0)
            var total = 0.0
            var matched = false
            for ((chunk, start) in chunks) {
                val match = bitap(text, chunk, location + start)
                if (match.isMatch) matched = true
                total += match.score
            }
            return Match(matched, if (matched) total / chunks.size else 1.0)
        }
    }

    private fun score(pattern: String, errors: Int, current: Int, expected: Int): Double {
        val accuracy = errors.toDouble() / pattern.length
        if (ignoreLocation) return accuracy
        val proximity = abs(expected - current)
        if (distance == 0) return if (proximity != 0) 1.0 else accuracy
        return accuracy + proximity.toDouble() / distance
    }

    /** bitap/search.js, without match indices. */
    private fun bitap(text: String, pattern: String, location: Int): Match {
        val patternLen = pattern.length
        val textLen = text.length
        val alphabet = HashMap<Char, Int>()
        pattern.forEachIndexed { i, c -> alphabet[c] = (alphabet[c] ?: 0) or (1 shl (patternLen - i - 1)) }
        val expected = max(0, min(location, textLen))
        var currentThreshold = threshold
        var bestLocation = expected

        var index = text.indexOf(pattern, bestLocation)
        while (index > -1) {
            currentThreshold = min(score(pattern, 0, index, expected), currentThreshold)
            bestLocation = index + patternLen
            index = text.indexOf(pattern, bestLocation)
        }

        bestLocation = -1
        var lastBitArr = IntArray(0)
        var finalScore = 1.0
        var binMax = patternLen + textLen
        val mask = 1 shl (patternLen - 1)

        for (i in 0 until patternLen) {
            var binMin = 0
            var binMid = binMax
            while (binMin < binMid) {
                if (score(pattern, i, expected + binMid, expected) <= currentThreshold) binMin = binMid else binMax = binMid
                binMid = (binMax - binMin) / 2 + binMin
            }
            binMax = binMid

            var start = max(1, expected - binMid + 1)
            val finish = min(expected + binMid, textLen) + patternLen
            val bitArr = IntArray(finish + 2)
            bitArr[finish + 1] = (1 shl i) - 1
            fun last(j: Int) = if (j < lastBitArr.size) lastBitArr[j] else 0

            var j = finish
            while (j >= start) {
                val current = j - 1
                val charMatch = if (current < textLen) alphabet[text[current]] ?: 0 else 0
                bitArr[j] = ((bitArr[j + 1] shl 1) or 1) and charMatch
                if (i != 0) bitArr[j] = bitArr[j] or (((last(j + 1) or last(j)) shl 1) or 1 or last(j + 1))
                if ((bitArr[j] and mask) != 0) {
                    finalScore = score(pattern, i, current, expected)
                    if (finalScore <= currentThreshold) {
                        currentThreshold = finalScore
                        bestLocation = current
                        if (bestLocation <= expected) break
                        start = max(1, 2 * expected - bestLocation)
                    }
                }
                j--
            }

            if (score(pattern, i + 1, expected, expected) > currentThreshold) break
            lastBitArr = bitArr
        }
        // Exact matches (score 0) count as "almost" exact.
        return Match(bestLocation >= 0, max(0.001, finalScore))
    }

    private companion object {
        const val MAX_BITS = 32

        /** Spaces outside double quotes. */
        val SPACE = Regex(" +(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)")

        /** In parseQuery.js's order, which matters: (type, single, quoted). */
        val MATCHERS = listOf(
            Triple(Type.Exact, Regex("^=(.*)$"), Regex("^=\"(.*)\"$")),
            Triple(Type.Include, Regex("^'(.*)$"), Regex("^'\"(.*)\"$")),
            Triple(Type.Prefix, Regex("^\\^(.*)$"), Regex("^\\^\"(.*)\"$")),
            Triple(Type.InversePrefix, Regex("^!\\^(.*)$"), Regex("^!\\^\"(.*)\"$")),
            Triple(Type.InverseSuffix, Regex("^!(.*)\\$$"), Regex("^!\"(.*)\"\\$$")),
            Triple(Type.Suffix, Regex("^(.*)\\$$"), Regex("^\"(.*)\"\\$$")),
            Triple(Type.Inverse, Regex("^!(.*)$"), Regex("^!\"(.*)\"$")),
            Triple(Type.Fuzzy, Regex("^(.*)$"), Regex("^\"(.*)\"$")),
        )
    }
}
