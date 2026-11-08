package com.slopus.happy.agent

/**
 * Decimal fractional order keys, compared as plain strings: happy-agent's
 * `orderKeyBetween` (`packages/happy-agent-modules/sources/utils/orderKeyBetween.ts`),
 * the one its tasks, subtasks, projects, workspaces, connections and
 * Surfaces are ordered by. A key is digits that never end in 0; trailing
 * zeros don't change a key's value, so nothing lies between `1` and `10`.
 * iOS's `OrderKey` is the same port.
 */
object OrderKey {
    /**
     * A key between [before] and [after], either null for that end; null when
     * they are out of order. Between two keys it is the shortest key near
     * their middle. At an open end it steps one unit past the neighbour, so
     * placing first or last again and again grows keys with the logarithm of
     * the count, not by a digit every few placements.
     */
    fun between(before: String?, after: String?): String? {
        if (after == null) return before?.let(::justAfter) ?: "5"
        if (before == null) return justBefore(null, after)
        if (trimmed(before) >= trimmed(after)) return null
        return midpoint(before, after)
    }

    /** The shortest key near the middle of [before] and [after], or of [before] and the end of the list. */
    fun midpoint(before: String, after: String?): String {
        val prefix = StringBuilder()
        var index = 0
        while (true) {
            val low = if (index < before.length) before[index] - '0' else 0
            val high = if (after != null && index < after.length) after[index] - '0' else 10
            if (high - low > 1) return "$prefix${low + (high - low) / 2}"
            if (high - low == 1) return "$prefix$low${above(before.drop(index + 1))}"
            prefix.append(low)
            index += 1
        }
    }

    /**
     * A key between [before] and [after], as close below [after] as it can be,
     * so the room left above [before] stays large. Steps are taken at the
     * narrowest power-of-two width that fits; null when nothing lies between
     * them.
     */
    fun justBefore(before: String?, after: String): String? {
        val floor = trimmed(before ?: "")
        val ceiling = trimmed(after)
        if (floor >= ceiling) return null
        var width = 1
        while (true) {
            val truncated = padded(ceiling, width)
            // Shorter than the width, the key is its first digits less one unit.
            val value = if (ceiling.length > width) truncated else decremented(truncated)
            if (value != null && value.any { it != '0' }) {
                val key = trimmed(value)
                if (key > floor) return key
            }
            width *= 2
        }
    }

    /** A key after [before], one step past it at the narrowest power-of-two width that fits. */
    fun justAfter(before: String): String {
        val floor = trimmed(before)
        var width = 1
        while (true) {
            incremented(padded(floor, width))?.let { return trimmed(it) }
            width *= 2
        }
    }

    /** The key's first [width] digits, padded with zeros when it is shorter. */
    private fun padded(key: String, width: Int): String = key.take(width).padEnd(width, '0')

    /** [value] plus one, as many digits; null when it would take one more. */
    private fun incremented(value: String): String? {
        val digits = value.toCharArray()
        for (index in digits.indices.reversed()) {
            if (digits[index] < '9') {
                digits[index] = digits[index] + 1
                return String(digits)
            }
            digits[index] = '0'
        }
        return null
    }

    /** [value] less one, as many digits; null below zero. */
    private fun decremented(value: String): String? {
        val digits = value.toCharArray()
        for (index in digits.indices.reversed()) {
            if (digits[index] > '0') {
                digits[index] = digits[index] - 1
                return String(digits)
            }
            digits[index] = '9'
        }
        return null
    }

    private fun trimmed(key: String): String = key.trimEnd('0')

    private fun above(rest: String): String {
        val prefix = StringBuilder()
        var index = 0
        while (true) {
            val digit = if (index < rest.length) rest[index] - '0' else 0
            if (digit < 9) return "$prefix${digit + (10 - digit) / 2}"
            prefix.append('9')
            index += 1
        }
    }
}
