package com.slopus.happy.call

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * How `readConversation` pages through a conversation (iOS `CallRead`): backwards, from the newest turn into older
 * ones, a turn at a time. A turn is the person's message and the agent's last words ([CallTurn]), or the person's
 * message still waiting for an answer, which is the newest. Each has a reference of its own, `t:` and the end of its
 * ID on the computer (its run's, or the waiting message's own): two characters, more where two would fit another turn
 * the phone has of that conversation.
 */
object CallRead {
    /** Turns a read gives unless it is told where to stop. */
    const val TURNS = 5
    /** The most one read gives, however far apart its ends are. */
    const val MAX_TURNS = 50
    /** Words of each message a read gives unless asked for more or fewer. */
    const val WORDS = 500
    const val MIN_WORDS = 20
    const val MAX_WORDS = 5000
    /** Bytes of UTF-8 a word may take on average before a message is cut for its size alone: code and long names, or text with no spaces. */
    private const val BYTES_PER_WORD = 10

    /** Where a read starts (`from`) or stops (`backTo`). */
    sealed interface Point {
        /** Turns back from the newest: 0 is the newest. */
        data class Back(val back: Int) : Point
        /** A turn's reference without its `t:`. */
        data class Ref(val suffix: String) : Point
    }

    /** What a read was asked for. */
    data class Request(val from: Point? = null, val backTo: Point? = null, val words: Int = WORDS)

    /** One turn as a read pages over it: a finished turn, or the message still waiting for an answer. */
    data class Item(val id: String, val turn: CallTurn? = null, val pending: CallMessage? = null)

    /** Why a read can't be given. */
    class Refusal(val reason: String)

    /** A message cut in the middle, [words] its whole length. */
    data class Cut(val text: String, val words: Int, val leftOut: Int)

    /**
     * The turns a read can give, oldest first: those with something to say (the person's message, the agent's last
     * words, an error), then the message still waiting for an answer.
     */
    fun items(state: CallTargetState): List<Item> {
        val items = state.turns.filter { !it.user.isNullOrEmpty() || !it.reply.isNullOrEmpty() || it.ended == "error" }.map { Item(it.id, turn = it) }
        return state.unanswered?.let { items + Item(it.id, pending = it) } ?: items
    }

    /** Each ID's reference: `t:` and its last two characters, or as many more as tell it from every other ID here. */
    fun references(ids: List<String>): List<String> = ids.map { id ->
        var length = minOf(2, id.length)
        while (length < id.length && ids.any { it != id && it.endsWith(id.takeLast(length)) }) length++
        "t:" + id.takeLast(length)
    }

    /** The arguments' request, or why they can't be read. */
    fun request(arguments: Map<String, JsonElement>): Pair<Request?, String?> {
        val from = point(arguments["from"], "from")
        if (from is Refusal) return null to from.reason
        val backTo = point(arguments["backTo"], "backTo")
        if (backTo is Refusal) return null to backTo.reason
        val raw = arguments["words"]
        val words = when {
            raw == null || raw is JsonNull -> WORDS
            raw is JsonPrimitive && raw.booleanOrNull == null && raw.content.trim().toDoubleOrNull()?.isFinite() == true ->
                clamp(Math.round(raw.content.trim().toDouble()).toDouble())
            else -> return null to "words must be a number of words, $MIN_WORDS to $MAX_WORDS."
        }
        return Request(from as Point?, backTo as Point?, words) to null
    }

    private fun clamp(words: Double): Int = minOf(MAX_WORDS.toDouble(), maxOf(MIN_WORDS.toDouble(), words)).toInt()

    /** `from` or `backTo` as given: absent (null), a number of turns back, or a turn's reference; a conversation's reference (`s3`) is told apart. */
    private fun point(value: JsonElement?, name: String): Any? {
        val wrong = Refusal("$name is a turn's ref from a read, such as t:3f, or a number of turns back from the newest (0 is the newest).")
        if (value == null || value is JsonNull) return null
        if (value !is JsonPrimitive || value.booleanOrNull != null && !value.isString) return wrong
        if (!value.isString) {
            val number = value.doubleOrNull ?: return wrong
            if (Math.rint(number) != number || number < 0) return wrong
            return Point.Back(minOf(number, 1_000_000.0).toInt())
        }
        val text = value.content.trim(' ', '\t')
        if (text.isEmpty()) return null
        if (text.all { it in '0'..'9' }) return Point.Back(text.take(7).toInt())
        if (text.lowercase().startsWith("t:") && text.length > 2) return Point.Ref(text.substring(2))
        if (text.length > 1 && text[0] == 's' && text.drop(1).all { it in '0'..'9' }) {
            return Refusal("$text is a conversation's ref; $name takes a turn's ref, such as t:3f, or a number of turns back.")
        }
        return wrong
    }

    /**
     * The turns [request] asks for among [items], as indexes oldest first (null when there are none), or why they
     * can't be read: a reference that fits no turn or several, or a start past the oldest.
     */
    fun range(request: Request, items: List<Item>, references: List<String>, older: Boolean): Any? {
        val ids = items.map { it.id }
        if (ids.isEmpty()) return null
        fun index(point: Point, name: String): Any = when (point) {
            is Point.Back -> if (point.back < ids.size) {
                ids.size - 1 - point.back
            } else {
                val held = if (older) " the phone has" else ""
                Refusal("$name ${point.back} is past the oldest of the ${ids.size} turns$held (0 to ${ids.size - 1} back).")
            }
            is Point.Ref -> {
                val exact = ids.lastIndexOf(point.suffix)
                val fits = ids.indices.filter { ids[it].endsWith(point.suffix) }
                when {
                    exact >= 0 -> exact
                    fits.size == 1 -> fits[0]
                    fits.isEmpty() -> {
                        val held = if (older) " in the turns the phone has of it" else ""
                        Refusal("No turn t:${point.suffix} in this conversation$held. Use a ref from one of its reads.")
                    }
                    else -> Refusal("t:${point.suffix} fits several turns: ${fits.joinToString(", ") { references[it] }}. Use one of those.")
                }
            }
        }
        var newest = ids.size - 1
        request.from?.let { from ->
            when (val found = index(from, "from")) {
                is Refusal -> return found
                else -> newest = found as Int
            }
        }
        var oldest = maxOf(0, newest - (TURNS - 1))
        request.backTo?.let { backTo ->
            // Back past the oldest reads to the oldest.
            if (backTo is Point.Back && backTo.back >= ids.size) {
                oldest = 0
            } else {
                when (val found = index(backTo, "backTo")) {
                    is Refusal -> return found
                    else -> oldest = found as Int
                }
            }
        }
        if (oldest > newest) oldest = newest.also { newest = oldest }
        oldest = maxOf(oldest, newest - (MAX_TURNS - 1))
        return oldest..newest
    }

    /**
     * A message cut in the middle: its start and its end, [limit] words of it in all, and between them how many were
     * left out; null if it is within [limit] words and [limit] × 10 bytes. Half the words are the start's, half the
     * end's, each cut at a whole word (or, a word too long for half the bytes, between characters).
     */
    fun cut(text: String, limit: Int): Cut? {
        // Each word's chars and UTF-8 bytes, start and end.
        val starts = ArrayList<Int>()
        val ends = ArrayList<Int>()
        val startBytes = ArrayList<Int>()
        val endBytes = ArrayList<Int>()
        var byte = 0
        var open = -1
        var openByte = 0
        var index = 0
        while (index < text.length) {
            val point = text.codePointAt(index)
            if (isSpace(text[index])) {
                if (open >= 0) {
                    starts += open; ends += index; startBytes += openByte; endBytes += byte
                    open = -1
                }
            } else if (open < 0) {
                open = index
                openByte = byte
            }
            byte += utf8(point)
            index += Character.charCount(point)
        }
        if (open >= 0) {
            starts += open; ends += text.length; startBytes += openByte; endBytes += byte
        }
        val total = starts.size
        val bytes = byte
        val maxBytes = limit * BYTES_PER_WORD
        if (total <= limit && bytes <= maxBytes) return null
        val half = maxBytes / 2
        var headEnd = 0
        var head = 0
        while (head < (limit + 1) / 2 && head < total && endBytes[head] <= half) {
            headEnd = ends[head]
            head++
        }
        if (head == 0 && total > 0) headEnd = starts[0] + CallContext.truncated(text.substring(starts[0]), half).length
        var tailStart = text.length
        var tail = 0
        while (tail < limit / 2 && total - 1 - tail >= head && bytes - startBytes[total - 1 - tail] <= half) {
            tailStart = starts[total - 1 - tail]
            tail++
        }
        if (tail == 0 && total > 0 && (total > head || head == 0)) {
            val end = ends[total - 1]
            tailStart = end - suffixLength(text.substring(0, end), half)
        }
        val leftOut = maxOf(1, total - head - tail)
        val start = text.substring(0, headEnd).trim()
        val finish = text.substring(tailStart).trim()
        val marker = "… ($leftOut ${if (leftOut == 1) "word" else "words"} left out) …"
        return Cut(listOf(start, marker, finish).filter { it.isNotEmpty() }.joinToString(" "), total, leftOut)
    }

    /** How many chars at the end of [text], whole code points, fit [bytes] of UTF-8. */
    private fun suffixLength(text: String, bytes: Int): Int {
        var size = 0
        var start = text.length
        while (start > 0) {
            val point = text.codePointBefore(start)
            size += utf8(point)
            if (size > bytes) break
            start -= Character.charCount(point)
        }
        return text.length - start
    }

    private fun utf8(point: Int): Int = when {
        point < 0x80 -> 1
        point < 0x800 -> 2
        point < 0x10000 -> 3
        else -> 4
    }

    /** A space, tab or line break: where words end. */
    private fun isSpace(character: Char): Boolean = character == ' ' || character == '\t' || character == '\n' || character == '\r'
}
