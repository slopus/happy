package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * One slash command an agent offers (API.md "Slash commands"): its [name]
 * without the slash, whether text may follow it, what it does, and its
 * [kind] (`skill`, `compaction`, or any other a module names). [image]: it
 * has artwork, served at [imagePath], shown as [thumbhash] until it comes.
 */
@Immutable
data class SlashCommand(
    val name: String,
    val hasArguments: Boolean,
    val description: String,
    val kind: String? = null,
    val image: Boolean = false,
    val thumbhash: String? = null,
) {
    val isSkill: Boolean get() = kind == SKILL

    fun json(): JsonObject = buildJsonObject {
        put("name", name)
        put("hasArguments", hasArguments)
        put("description", description)
        kind?.let { put("kind", it) }
        if (image) putJsonObject("image") { thumbhash?.let { put("thumbhash", it) } }
    }

    companion object {
        const val SKILL = "skill"
        const val COMPACTION = "compaction"

        fun parse(value: JsonElement?): SlashCommand? {
            val o = value.obj ?: return null
            val image = o["image"].obj
            return SlashCommand(
                name = o["name"].str?.takeIf { it.isNotEmpty() } ?: return null,
                hasArguments = o["hasArguments"].bool ?: false,
                description = o["description"].str.orEmpty(),
                kind = o["kind"].str,
                image = image != null,
                thumbhash = image?.get("thumbhash").str,
            )
        }

        /**
         * One of `GET /v0/skills`'s summaries as the skill command an agent
         * would offer for it (API.md "Slash commands"); null unless it is
         * enabled and ready, as only those are offered to agents.
         */
        fun globalSkill(value: JsonElement?): SlashCommand? {
            val o = value.obj ?: return null
            if (o["enabled"].bool != true || o["status"].str != "ready") return null
            return SlashCommand(o["name"].str?.takeIf { it.isNotEmpty() } ?: return null, true, o["description"].str.orEmpty(), SKILL)
        }

        /** A catalog as sent (`slashCommands`); null when the answer carries none, so what is known stays. */
        fun parseAll(value: JsonElement?): List<SlashCommand>? = value.arr?.mapNotNull(::parse)

        fun json(commands: List<SlashCommand>): JsonArray = JsonArray(commands.map(SlashCommand::json))

        /** Where a command's artwork is read (`GET …/slash-commands/:name/image`). */
        fun imagePath(agentId: String, name: String): String =
            "/v0/agents/${ConversationApi.escape(agentId)}/slash-commands/${ConversationApi.escape(name)}/image"
    }
}

/** A draft that runs a command: the command, and the text after its name, if any. */
data class CommandInvocation(val command: SlashCommand, val arguments: String?)

/**
 * The composer's reading of slash commands, as desktop's composer reads
 * them (`composerState.ts`, fd553cc3, 4078fd44): a draft is a command only
 * while it is one leading `/` and a command word that something offered
 * still begins with, so a pasted path is ordinary text. The palette lists
 * commands before skills, each group in the agent's order.
 */
object SlashCommands {
    private val query = Regex("^/([A-Za-z0-9._:-]*)$")
    private val invocation = Regex("^/([A-Za-z0-9][A-Za-z0-9._:-]*)(?:\\s([\\s\\S]*))?$")

    /** The word after `/` while [text] is a command being chosen; null for anything else. */
    fun query(text: String, commands: List<SlashCommand>): String? {
        if (commands.isEmpty()) return null
        val word = query.matchEntire(text)?.groupValues?.get(1) ?: return null
        return word.takeIf { commands.any { command -> matches(command, word) } }
    }

    /** The commands [word] begins, commands before skills, in the agent's order within each. */
    fun matching(commands: List<SlashCommand>, word: String): List<SlashCommand> =
        ordered(commands).filter { matches(it, word) }

    fun ordered(commands: List<SlashCommand>): List<SlashCommand> =
        commands.filter { !it.isSkill } + commands.filter { it.isSkill }

    /** An offered command at the start of a submitted [text], with what follows it. */
    fun invocation(text: String, commands: List<SlashCommand>): CommandInvocation? {
        val match = invocation.matchEntire(text) ?: return null
        val command = commands.firstOrNull { it.name == match.groupValues[1] } ?: return null
        val arguments = match.groups[2]?.value
        return CommandInvocation(command, arguments)
    }

    private fun matches(command: SlashCommand, word: String): Boolean =
        word.isEmpty() || command.name.lowercase().startsWith(word.lowercase())
}
