package com.slopus.happy.conversation.ui

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Quick replies (@slopus/happy-agent-client `sources/protocol/quickReplies.ts`):
// answers an agent suggests, not chat UI. They come as a `quick_replies`
// block of an agent message the daemon wrote, or as the `quick_replies`
// presentation of a `suggest_replies` call. A tap is an ordinary send of the
// option's words, with `quickReply` naming the option.

/** Which option of which suggestion a person's message is: [toolCallId] for a presentation's, absent for a block's. */
@Immutable
data class QuickReply(val messageId: String, val toolCallId: String?, val index: Int) {
    fun json(): JsonObject = buildJsonObject {
        put("messageId", messageId)
        toolCallId?.let { put("toolCallId", it) }
        put("index", index)
    }

    companion object {
        fun parse(value: JsonElement?): QuickReply? {
            val o = value.obj ?: return null
            val index = o["index"].num?.takeIf { it % 1.0 == 0.0 && it >= 0 && it < QuickReplies.MAX } ?: return null
            return QuickReply(o["messageId"].str ?: return null, o["toolCallId"].str, index.toInt())
        }
    }
}

object QuickReplies {
    /** The most options one suggestion holds. */
    const val MAX = 6
    const val MAX_LENGTH = 200

    /** One line of plain text: no control or bidirectional formatting character. */
    private val PLAIN = Regex("^[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]*$")

    /** Whether [options] are what a suggestion may hold: 1 to [MAX] of them, each plain text of 1 to [MAX_LENGTH], none twice. */
    fun valid(options: List<String>): Boolean =
        options.size in 1..MAX && options.all { it.length in 1..MAX_LENGTH && PLAIN.matches(it) } && options.toSet().size == options.size

    /**
     * The options of a `quick_replies` block or presentation; null where
     * they aren't [valid], so nothing is drawn that a tap couldn't send. The
     * `ui` list the object may carry, a drawing beside each option, isn't
     * read: every option is its words.
     */
    fun options(o: JsonObject): List<String>? {
        val options = o["options"].arr?.map { it.str ?: return null } ?: return null
        return options.takeIf(::valid)
    }
}
