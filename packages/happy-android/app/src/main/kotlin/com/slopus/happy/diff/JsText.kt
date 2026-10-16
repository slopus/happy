package com.slopus.happy.diff

/**
 * String operations with JavaScript's meaning, where Kotlin's differ:
 * whitespace is JS `\s` (Kotlin's `isWhitespace` also takes U+001C–U+001F
 * and U+0085 and misses U+FEFF), and splitting keeps every empty piece.
 * Lengths and offsets are UTF-16 units in both languages.
 */
internal object JsText {
    /** `\s` in JavaScript. */
    fun isWhitespace(code: Int): Boolean = when (code) {
        in 0x09..0x0D, 0x20, 0xA0, 0x1680, in 0x2000..0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF -> true
        else -> false
    }

    /** JavaScript's line terminators, which `.` and `$` stop at. */
    fun isLineTerminator(char: Char): Boolean = char == '\n' || char == '\r' || char == '\u2028' || char == '\u2029'

    /** `String.prototype.trim`. */
    fun trim(text: String): String {
        var start = 0
        var end = text.length
        while (start < end && isWhitespace(text[start].code)) start++
        while (end > start && isWhitespace(text[end - 1].code)) end--
        return text.substring(start, end)
    }

    /** `text.replace(/\s/g, '')`. */
    fun stripWhitespace(text: String): String {
        if (text.none { isWhitespace(it.code) }) return text
        val out = StringBuilder(text.length)
        for (char in text) if (!isWhitespace(char.code)) out.append(char)
        return out.toString()
    }

    /** `text.split('\n')`, minus the empty piece a final newline leaves when [dropTrailingEmpty]. */
    fun lines(text: String, dropTrailingEmpty: Boolean): List<String> {
        val parts = text.split('\n')
        return if (dropTrailingEmpty && parts.last().isEmpty()) parts.dropLast(1) else parts
    }

    /**
     * `JSON.parse` of a quoted string, or null where it would throw: only
     * JSON's escapes, and no raw control characters.
     */
    fun parseJsonString(quoted: String): String? {
        if (quoted.length < 2 || quoted.first() != '"' || quoted.last() != '"') return null
        val out = StringBuilder()
        var i = 1
        val end = quoted.length - 1
        while (i < end) {
            val char = quoted[i]
            when {
                char == '"' -> return null
                char.code < 0x20 -> return null
                char != '\\' -> out.append(char)
                else -> {
                    if (i + 1 >= end) return null
                    when (val escape = quoted[i + 1]) {
                        '"', '\\', '/' -> out.append(escape)
                        'b' -> out.append('\b')
                        'f' -> out.append('\u000C')
                        'n' -> out.append('\n')
                        'r' -> out.append('\r')
                        't' -> out.append('\t')
                        'u' -> {
                            if (i + 6 > end) return null
                            val hex = quoted.substring(i + 2, i + 6)
                            if (!hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
                            out.append(hex.toInt(16).toChar())
                            i += 4
                        }
                        else -> return null
                    }
                    i++
                }
            }
            i++
        }
        return out.toString()
    }
}
