package com.slopus.happy.autocomplete

/** A cursor or selection in the composer's text, as UTF-16 offsets. */
data class TextSelection(val start: Int, val end: Int)

/**
 * findActiveWord.ts `ActiveWord`: the prefixed word around the cursor.
 * [word] runs from the prefix to the word's end, [activeWord] from the
 * prefix to the cursor.
 */
data class ActiveWord(
    val word: String,
    val activeWord: String,
    val offset: Int,
    val length: Int,
    val activeLength: Int,
    val endOffset: Int,
)

val DEFAULT_PREFIXES = listOf('@', ':', '/')

/** The composer's prefixes (SessionView `AGENT_INPUT_AUTOCOMPLETE_PREFIXES`): file mentions and commands. */
val COMPOSER_PREFIXES = listOf('@', '/')

private val STOP_CHARACTERS = setOf('\n', ',', '(', ')', '[', ']', '{', '}', '<', '>', ';', '!', '?', '.')

private fun findActiveWordStart(content: String, selection: TextSelection, prefixes: List<Char>): Int {
    var startIndex = selection.start - 1
    var spaceIndex = -1
    while (startIndex >= 0) {
        val char = content[startIndex]
        if (char == ' ') {
            if (spaceIndex >= 0) return spaceIndex + 1
            spaceIndex = startIndex
            startIndex--
        } else if (char in prefixes && (startIndex == 0 || content[startIndex - 1] == ' ' || content[startIndex - 1] == '\n')) {
            return startIndex
        } else if (char in STOP_CHARACTERS) {
            return startIndex + 1
        } else {
            startIndex--
        }
    }
    return (if (spaceIndex >= 0) spaceIndex else startIndex) + 1
}

private fun findActiveWordEnd(content: String, cursor: Int, wordStart: Int): Int {
    // A file path (@…) runs on through / and .
    val isFilePath = wordStart in content.indices && content[wordStart] == '@'
    var endIndex = cursor
    while (endIndex < content.length) {
        val char = content[endIndex]
        if (isFilePath && (char == '/' || char == '.')) {
            endIndex++
            continue
        }
        if (char == ' ' || char in STOP_CHARACTERS) break
        endIndex++
    }
    return endIndex
}

/**
 * findActiveWord.ts: the word at a collapsed cursor that starts with one of
 * [prefixes] at a word boundary (start, space or newline). A prefix typed
 * alone counts, so suggestions show at once.
 */
fun findActiveWord(content: String, selection: TextSelection, prefixes: List<Char> = DEFAULT_PREFIXES): ActiveWord? {
    if (selection.start != selection.end || selection.start == 0) return null
    val start = findActiveWordStart(content, selection, prefixes)
    val active = content.substring(start, selection.end)
    if (active.endsWith(' ') || active.isEmpty() || active[0] !in prefixes) return null
    val end = findActiveWordEnd(content, selection.end, start)
    val word = content.substring(start, end)
    return ActiveWord(word, active, start, word.length, active.length, end)
}

/** findActiveWord.ts `findActiveWordString`: just the part up to the cursor. */
fun findActiveWordString(content: String, selection: TextSelection, prefixes: List<Char> = DEFAULT_PREFIXES): String? =
    findActiveWord(content, selection, prefixes)?.activeWord

/** findActiveWord.ts `getActiveWordQuery`: the word without its prefix. */
fun getActiveWordQuery(activeWord: String): String = if (activeWord.length > 1) activeWord.substring(1) else ""

data class AppliedSuggestion(val text: String, val cursorPosition: Int)

/**
 * applySuggestion.ts: replaces the whole active word with [suggestion],
 * then a space unless one follows already. With no active word it goes
 * in at the cursor, replacing any selection.
 */
fun applySuggestion(
    content: String,
    selection: TextSelection,
    suggestion: String,
    prefixes: List<Char> = DEFAULT_PREFIXES,
    addSpace: Boolean = true,
): AppliedSuggestion {
    val word = findActiveWord(content, selection, prefixes)
    if (word == null) {
        val inserted = if (addSpace) "$suggestion " else suggestion
        return AppliedSuggestion(content.substring(0, selection.start) + inserted + content.substring(selection.end), selection.start + inserted.length)
    }
    val after = content.substring(word.endOffset)
    val inserted = if (addSpace && (after.isEmpty() || after[0] != ' ')) "$suggestion " else suggestion
    return AppliedSuggestion(content.substring(0, word.offset) + inserted + after, word.offset + inserted.length)
}
