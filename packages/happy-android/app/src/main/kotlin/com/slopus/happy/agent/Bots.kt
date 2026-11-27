package com.slopus.happy.agent

import androidx.compose.runtime.Immutable
import com.slopus.happy.connection.AgentConnectionException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Happy Cloud's two kinds of bot (happy-cluster's bot `kind`), apart from
 * `isAdmin`: [Shared] is one conversation that only the team's owners
 * receive, which home lists among its places; [Personal] is a definition
 * every member talks to in a conversation of their own (the bot's `agent`
 * is the caller's), listed under Bots. A Happy Agent daemon sends no kind,
 * and its bots are listed as before.
 */
enum class BotKind(val wire: String) {
    Shared("shared"),
    Personal("personal");

    companion object {
        /** [bot]'s kind; null for none or one this build doesn't know, which is listed as a bot. */
        fun of(bot: JsonObject): BotKind? = bot.string("kind")?.let { kind -> entries.firstOrNull { it.wire == kind } }

        /** Whether [bot] carries a kind at all, known or not: only Happy Cloud sends one. */
        fun carried(bot: JsonObject): Boolean = bot.string("kind") != null
    }
}

/** The caller may change [bot]'s name, picture and instructions (`editable`); absent is no. */
fun botEditable(bot: JsonObject): Boolean = (bot["editable"] as? JsonPrimitive)?.booleanOrNull == true

/**
 * A bot's name and instructions as being edited, over what the bot last
 * said ([savedName], [savedInstructions]). Save sends only what differs
 * (`PATCH /v0/bots/:id` takes `{ name?, instructions? }`). The name is
 * the bot object's rule: 1 to 256 characters once trimmed, no control
 * characters; instructions at most 32 KiB of UTF-8, empty allowed.
 */
@Immutable
data class BotEditForm(
    val name: String,
    val instructions: String,
    val savedName: String,
    val savedInstructions: String,
) {
    enum class Problem { NameBlank, NameTooLong, NameControl, InstructionsTooLong }

    private val trimmedName: String get() = name.trim()

    val nameChanged: Boolean get() = trimmedName != savedName
    val instructionsChanged: Boolean get() = instructions != savedInstructions
    val changed: Boolean get() = nameChanged || instructionsChanged

    /** Why it can't be saved as it stands; null when it can. */
    val problem: Problem?
        get() = when {
            trimmedName.isEmpty() -> Problem.NameBlank
            trimmedName.codePointCount(0, trimmedName.length) > NAME_MAX -> Problem.NameTooLong
            trimmedName.any { it.code < 0x20 || it.code == 0x7f } -> Problem.NameControl
            instructions.toByteArray(Charsets.UTF_8).size > INSTRUCTIONS_MAX_BYTES -> Problem.InstructionsTooLong
            else -> null
        }

    val canSave: Boolean get() = changed && problem == null

    /** The PATCH body: the fields changed here, under [mutationId]. */
    fun body(mutationId: String): JsonObject = buildJsonObject {
        if (nameChanged) put("name", trimmedName)
        if (instructionsChanged) put("instructions", instructions)
        put("mutationId", mutationId)
    }

    /**
     * [bot] as heard again (an answer, `bot.updated`, a read): a field left
     * alone here follows it, one being edited keeps what was typed. A bot
     * that leaves `instructions` out keeps those last heard.
     */
    fun heard(bot: JsonObject): BotEditForm {
        val nextName = bot.string("name") ?: savedName
        val nextInstructions = bot.string("instructions") ?: savedInstructions
        return BotEditForm(
            name = if (nameChanged) name else nextName,
            instructions = if (instructionsChanged) instructions else nextInstructions,
            savedName = nextName,
            savedInstructions = nextInstructions,
        )
    }

    companion object {
        const val NAME_MAX = 256
        const val INSTRUCTIONS_MAX_BYTES = 32 * 1024

        fun of(bot: JsonObject): BotEditForm {
            val name = bot.string("name").orEmpty()
            val instructions = bot.string("instructions").orEmpty()
            return BotEditForm(name, instructions, name, instructions)
        }
    }
}

/**
 * Changes one bot's definition (happy-cluster `PATCH /v0/bots/:id`, and
 * its picture through `PUT`/`DELETE /v0/bots/:id/avatar`). Each change
 * names the version it changes (`If-Match`); one that lost a race (`409`)
 * goes once more over the bot the conflict carries, or a fresh read, under
 * the same `mutationId`. Every answer is the bot as it now stands.
 */
class BotEditor(private val client: AgentClient, private val botId: String) {
    private val path = "/v0/bots/${AgentClient.escape(botId)}"

    suspend fun read(): JsonObject = bot(client.send("GET", path).text)

    suspend fun save(form: BotEditForm, version: String): JsonObject {
        val body = form.body(AgentClient.newId())
        return retried(version) { current -> client.send("PATCH", path, body, headers = mapOf("If-Match" to current)).text }
    }

    suspend fun setAvatar(jpeg: ByteArray, version: String): JsonObject =
        retried(version) { current -> client.sendBytes("PUT", "$path/avatar", jpeg, mapOf("Content-Type" to "image/jpeg", "If-Match" to current)).text }

    suspend fun removeAvatar(version: String): JsonObject =
        retried(version) { current -> client.send("DELETE", "$path/avatar", headers = mapOf("If-Match" to current)).text }

    private suspend fun retried(version: String, call: suspend (String) -> String): JsonObject = try {
        bot(call(version))
    } catch (e: AgentApiException) {
        if (e.status != 409) throw e
        val current = ((e.body as? JsonObject)?.get("bot") as? JsonObject)?.string("version") ?: read().string("version")
            ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
        bot(call(current))
    }

    private fun bot(text: String): JsonObject = try {
        AgentClient.json.parseToJsonElement(text) as? JsonObject
    } catch (_: Exception) {
        null
    }?.get("bot") as? JsonObject ?: throw AgentConnectionException(AgentConnectionException.Reason.InvalidResponse)
}
