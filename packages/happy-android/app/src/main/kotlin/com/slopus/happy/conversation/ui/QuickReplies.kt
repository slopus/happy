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

// Quick replies (happy-agent API.md "Quick replies"; @slopus/happy-agent-client
// `sources/protocol/quickReplies.ts`): suggested answers, not chat UI. A
// `quick_replies` block of an agent message the daemon wrote, or the
// `quick_replies` presentation of a `suggest_replies` call; a tap is an
// ordinary send of the option with `quickReply` naming it.

/**
 * What one option shows beside its words, from the reply catalog (happy-agent
 * `sources/replies/`): display only, one line, no actions; a tap still sends
 * the option's text. A type this build doesn't know is null, the words alone.
 */
@Immutable
sealed interface ReplyUi {
    /** An AI: its mark before the words, and how it stands now at the end, read live from its program ([com.slopus.happy.agent.ProviderCli]), never from the model. */
    data class Provider(val provider: String) : ReplyUi

    companion object {
        /** The AIs `provider` names; any other is drawn as the bare option. */
        val PROVIDERS = setOf("claude", "codex", "grok", "antigravity")

        fun parse(value: JsonElement?): ReplyUi? {
            val o = value.obj ?: return null
            val props = o["props"].obj
            return when (o["type"].str) {
                "provider" -> props?.get("provider").str?.takeIf { it in PROVIDERS }?.let(::Provider)
                else -> null
            }
        }
    }
}

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
            return QuickReply(o["messageId"].str ?: return null, o["toolCallId"].str, o["index"].num?.toInt()?.takeIf { it >= 0 } ?: return null)
        }
    }
}

object QuickReplies {
    /** The most options one suggestion holds. */
    const val MAX = 6
    private const val MAX_LENGTH = 200
    private val plain = Regex("^[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]*$")

    /** `normalizeQuickReply`: whitespace runs collapsed to one space, trimmed. */
    fun normalize(option: String): String = option.replace(Regex("\\s+"), " ").trim()

    /** `quickRepliesProblems`: the client package's sentences, empty when [options] pass. */
    fun problems(options: List<String>): List<String> {
        val problems = ArrayList<String>()
        if (options.size !in 1..MAX) problems += "Suggest 1 to $MAX replies."
        options.forEachIndexed { i, option ->
            if (option.length !in 1..MAX_LENGTH || !plain.matches(option)) problems += "Reply ${i + 1} must be plain text of 1 to 200 characters on one line."
        }
        options.filterIndexed { i, option -> options.indexOf(option) != i }.firstOrNull()?.let { problems += "Replies must be unique; \"$it\" repeats." }
        return problems
    }

    /** The options of a `quick_replies` block or presentation; null where they don't pass, so none is drawn. */
    fun options(o: JsonObject): List<String>? {
        val options = o["options"].arr?.map { it.str ?: return null } ?: return null
        return options.takeIf { problems(it).isEmpty() }
    }

    /** Each option's [ReplyUi], by index; empty where `ui` is absent or not one per option. */
    fun ui(o: JsonObject, count: Int): List<ReplyUi?> {
        val ui = o["ui"].arr ?: return emptyList()
        return if (ui.size == count) ui.map(ReplyUi::parse).takeIf { list -> list.any { it != null } }.orEmpty() else emptyList()
    }
}
