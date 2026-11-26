package com.slopus.happy.conversation

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * Whether a message a computer sent is one the protocol allows
 * (happy-agent-client `protocol/messages.ts`, the source of truth): its
 * fields' presence, types and enums, its blocks and its calls'
 * presentations. A message that fails is drawn as one placeholder row
 * ([Message.undisplayable]) and the rest of the conversation goes on.
 *
 * The reason is a JSON pointer into the message and what is wrong there,
 * the first found; never a value it held.
 *
 * Deliberately looser than the schema where a valid server breaks it or a
 * newer one may grow, as desktop is (the shared fixtures'
 * `protocol-messages/README.md`): no string length, array length or
 * pattern limits (the cluster sends a question's `header` as ""); a
 * presentation `type` this build doesn't know is no presentation, the call
 * a plain line, never a failure; an image block may come without its
 * `data` (history leaves a large picture's bytes out).
 */
object MessageCheck {
    /** Why [value] isn't a protocol message, as a short path and reason without its values; null when it is one. */
    fun problem(value: JsonElement?): String? = try {
        message(value)
        null
    } catch (e: Invalid) {
        e.message
    }

    private class Invalid(message: String) : Exception(message, null, false, false)

    private fun invalid(path: String, why: String): Nothing = throw Invalid("${path.ifEmpty { "/" }}: $why")

    private fun kind(value: JsonElement?): String = when (value) {
        null -> "missing"
        is JsonNull -> "null"
        is JsonObject -> "an object"
        is JsonArray -> "an array"
        is JsonPrimitive -> when {
            value.isString -> "a string"
            value.content == "true" || value.content == "false" -> "a boolean"
            else -> "a number"
        }
    }

    private fun expected(path: String, what: String, value: JsonElement?): Nothing = invalid(path, "expected $what, got ${kind(value)}")

    /** A JSON pointer one step down; keys escaped as RFC 6901 has them. */
    private fun at(path: String, key: Any) = "$path/" + key.toString().replace("~", "~0").replace("/", "~1")

    // Values

    private fun obj(value: JsonElement?, path: String): JsonObject = value as? JsonObject ?: expected(path, "an object", value)

    private fun arr(value: JsonElement?, path: String): JsonArray = value as? JsonArray ?: expected(path, "an array", value)

    private fun isString(value: JsonElement?) = value is JsonPrimitive && value.isString

    private fun string(value: JsonElement?, path: String) {
        if (!isString(value)) expected(path, "a string", value)
    }

    private fun number(value: JsonElement?, path: String): Double {
        val p = value as? JsonPrimitive
        return p?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() } ?: expected(path, "a number", value)
    }

    private fun integer(value: JsonElement?, path: String, minimum: Long? = null) {
        val n = (value as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() && it == Math.floor(it) }
            ?: expected(path, "an integer", value)
        if (minimum != null && n < minimum) invalid(path, "expected an integer of at least $minimum")
    }

    private fun boolean(value: JsonElement?, path: String) {
        val p = value as? JsonPrimitive
        if (p == null || p.isString || (p.content != "true" && p.content != "false")) expected(path, "a boolean", value)
    }

    private fun oneOf(value: JsonElement?, path: String, vararg allowed: String) {
        if (!isString(value) || (value as JsonPrimitive).content !in allowed) expected(path, "one of ${allowed.joinToString("|")}", value)
    }

    private fun stringArray(value: JsonElement?, path: String) {
        arr(value, path).forEachIndexed { index, item -> string(item, "$path/$index") }
    }

    // Fields of an object: required, optional (absent), or nullable (present, maybe null).

    private inline fun JsonObject.required(key: String, path: String, check: (JsonElement?, String) -> Unit) = check(this[key], at(path, key))

    private inline fun JsonObject.optional(key: String, path: String, check: (JsonElement?, String) -> Unit) {
        if (key in this) check(this[key], at(path, key))
    }

    private inline fun JsonObject.nullable(key: String, path: String, check: (JsonElement?, String) -> Unit) {
        val value = this[key]
        if (value == null) expected(at(path, key), "a value or null", null)
        if (value !is JsonNull) check(value, at(path, key))
    }

    private inline fun JsonObject.optionalNullable(key: String, path: String, check: (JsonElement?, String) -> Unit) {
        val value = this[key]
        if (value != null && value !is JsonNull) check(value, at(path, key))
    }

    private fun JsonObject.nullAt(key: String, path: String) {
        val value = this[key]
        if (value !is JsonNull) expected(at(path, key), "null", value)
    }

    // Message

    private fun message(value: JsonElement?) {
        val o = obj(value, "")
        o.required("id", "", ::string)
        o.required("role", "") { v, p -> oneOf(v, p, "user", "agent", "system", "service") }
        o.required("createdAt", "") { v, p -> integer(v, p) }
        val content = arr(o["content"], "/content")
        content.forEachIndexed { index, block -> block(block, "/content/$index") }
        metadata(obj(o["metadata"], "/metadata"))
        when ((o["role"] as JsonPrimitive).content) {
            "user" -> {
                o.required("status", "") { v, p -> oneOf(v, p, "pending", "accepted") }
                o.required("delivery", "") { v, p -> oneOf(v, p, "queue", "steer") }
                o.required("mode", "", ::mode)
                o.nullable("runId", "", ::string)
                o.optionalNullable("profile", "", ::string)
                o.optional("clientMetadata", "") { v, p -> obj(v, p) }
                o.optional("quote", "") { v, p -> obj(v, p) }
            }
            "service" -> {
                o.optional("error", "", ::error)
                o.optional("failure", "", ::failure)
                o.optional("notice", "") { v, p -> obj(v, p).required("kind", p, ::string) }
            }
        }
    }

    private fun metadata(o: JsonObject) {
        for (key in listOf("providerId", "modelId", "senderAgentId", "senderAgentExplanation", "userId")) {
            o.optional(key, "/metadata", ::string)
        }
    }

    private fun mode(value: JsonElement?, path: String) {
        val o = obj(value, path)
        o.required("providerId", path, ::string)
        o.optional("providerType", path, ::string)
        o.optionalNullable("account", path) { v, p -> obj(v, p).required("id", p, ::string) }
        o.required("modelId", path, ::string)
        o.required("effort", path, ::string)
        o.nullable("serviceTier", path, ::string)
        o.required("permissionMode", path) { v, p -> oneOf(v, p, "read_only", "workspace_write", "auto", "full_access") }
    }

    private fun error(value: JsonElement?, path: String) {
        val o = obj(value, path)
        o.required("code", path, ::string)
        o.nullable("mode", path, ::mode)
        o.nullable("credentialSource", path) { v, p ->
            val source = obj(v, p)
            source.required("kind", p, ::string)
            source.required("location", p, ::string)
            source.nullable("host", p, ::string)
        }
        o.required("recovery", path) { v, p ->
            val recovery = obj(v, p)
            recovery.required("steps", p, ::stringArray)
            recovery.required("actions", p, ::stringArray)
            recovery.optional("commands", p) { list, lp ->
                arr(list, lp).forEachIndexed { index, item ->
                    val command = obj(item, "$lp/$index")
                    command.required("label", "$lp/$index", ::string)
                    command.required("command", "$lp/$index", ::string)
                }
            }
        }
    }

    /** The fields every failure carries; a known kind without its own fields reads as an unknown one, as the schema has it. */
    private fun failure(value: JsonElement?, path: String) {
        val o = obj(value, path)
        o.required("kind", path, ::string)
        o.required("message", path, ::string)
        o.required("fallbackProviders", path) { v, p ->
            arr(v, p).forEachIndexed { index, item ->
                val fp = "$p/$index"
                val fallback = obj(item, fp)
                fallback.required("providerId", fp, ::string)
                fallback.required("providerLabel", fp, ::string)
                fallback.required("modelId", fp, ::string)
                fallback.nullable("usedPercent", fp) { n, np -> number(n, np) }
                fallback.nullable("usageWindow", fp, ::string)
                fallback.required("group", fp, ::string)
            }
        }
        o.optional("resolution", path) { v, p ->
            val resolution = obj(v, p)
            resolution.required("at", p) { n, np -> integer(n, np) }
            resolution.required("action", p, ::string)
        }
    }

    // Blocks

    private fun block(value: JsonElement?, path: String) {
        val o = obj(value, path)
        o.required("type", path, ::string)
        when ((o["type"] as JsonPrimitive).content) {
            "text", "reasoning" -> o.required("text", path, ::string)
            "image" -> {
                o.required("mimeType", path, ::string)
                o.optional("data", path, ::string)
            }
            "file" -> fileBlock(o, path)
            "tool_call_request" -> {
                o.required("name", path, ::string)
                o.optional("arguments", path) { v, p -> obj(v, p) }
                (o.keys - setOf("type", "name", "arguments")).firstOrNull()?.let { invalid(at(path, it), "not allowed") }
            }
            "tool_call" -> toolCall(o, path)
            "configuration" -> {
                o.nullable("before", path, ::mode)
                o.required("after", path, ::mode)
                o.nullable("beforeMessageId", path, ::string)
            }
            "compaction" -> compaction(o, path)
            // Retired blocks are opaque history.
            "ui", "action", "quick_replies" -> Unit
            else -> invalid(at(path, "type"), "unknown block type")
        }
    }

    private fun fileBlock(o: JsonObject, path: String) {
        o.required("attachment", path, ::string)
        o.required("name", path, ::string)
        attachmentDetails(o, path)
    }

    /** What an attachment or a presented item says of itself, past its name. */
    private fun attachmentDetails(o: JsonObject, path: String) {
        o.optional("mimeType", path, ::string)
        o.optional("size", path) { v, p -> integer(v, p, minimum = 0) }
        o.optional("kind", path, ::string)
        o.optional("width", path) { v, p -> integer(v, p, minimum = 1) }
        o.optional("height", path) { v, p -> integer(v, p, minimum = 1) }
        o.optional("durationMs", path) { v, p -> integer(v, p, minimum = 0) }
        o.optional("thumbhash", path, ::string)
        o.optional("scale", path) { v, p -> number(v, p) }
        o.optional("preview", path) { v, p -> obj(v, p) }
        o.optional("animated", path) { v, p -> if (v != JsonPrimitive(true)) expected(p, "true", v) }
    }

    private fun toolCall(o: JsonObject, path: String) {
        o.required("id", path, ::string)
        o.required("name", path, ::string)
        o.required("status", path) { v, p -> oneOf(v, p, "running", "completed", "failed") }
        o.optional("arguments", path) { v, p -> obj(v, p) }
        o.optional("result", path) { v, p -> obj(v, p) }
        o.optional("presentation", path, ::presentation)
        o.optional("elevated", path, ::boolean)
        o.optional("review", path, ::review)
        // A reviewed call carries both, an unreviewed one neither.
        if ("review" in o && "elevated" !in o) invalid(at(path, "review"), "expected elevated with it")
        if ("elevated" in o && "review" !in o) invalid(at(path, "elevated"), "expected review with it")
    }

    private fun review(value: JsonElement?, path: String) {
        val o = obj(value, path)
        o.required("outcome", path) { v, p -> oneOf(v, p, "allowed", "denied", "unproven") }
        o.required("reason", path, ::string)
        if ((o["outcome"] as JsonPrimitive).content == "unproven") {
            o.required("kind", path) { v, p -> oneOf(v, p, "timed_out", "unavailable") }
        } else {
            o.required("risk", path) { v, p -> oneOf(v, p, "low", "medium", "high", "critical") }
            o.required("userAuthorization", path) { v, p -> oneOf(v, p, "unknown", "low", "medium", "high") }
        }
    }

    private fun compaction(o: JsonObject, path: String) {
        o.required("trigger", path) { v, p -> oneOf(v, p, "manual", "automatic") }
        o.nullable("tokensBefore", path) { v, p -> integer(v, p, minimum = 0) }
        o.required("startedAt", path) { v, p -> integer(v, p) }
        o.required("status", path) { v, p -> oneOf(v, p, "running", "completed", "failed") }
        when ((o["status"] as JsonPrimitive).content) {
            "running" -> {
                o.nullAt("tokensAfter", path)
                o.nullAt("failureReason", path)
                o.nullAt("completedAt", path)
            }
            "completed" -> {
                o.nullable("tokensAfter", path) { v, p -> integer(v, p, minimum = 0) }
                o.nullAt("failureReason", path)
                o.required("completedAt", path) { v, p -> integer(v, p) }
            }
            else -> {
                o.nullAt("tokensAfter", path)
                o.required("failureReason", path, ::string)
                o.required("completedAt", path) { v, p -> integer(v, p) }
            }
        }
    }

    // Presentations

    private fun presentation(value: JsonElement?, path: String) {
        val o = obj(value, path)
        o.required("type", path, ::string)
        when ((o["type"] as JsonPrimitive).content) {
            "exploration" -> o.required("operations", path) { v, p ->
                arr(v, p).forEachIndexed { index, item -> operation(item, "$p/$index") }
            }
            "exec_command" -> {
                o.required("command", path, ::string)
                o.optionalNullable("output", path, ::string)
                o.optionalNullable("terminalId", path, ::string)
            }
            "background_terminal_interaction" -> {
                o.required("command", path, ::string)
                o.required("input", path, ::string)
                o.required("terminalId", path, ::string)
            }
            "file_diff" -> {
                o.required("files", path) { v, p -> arr(v, p).forEachIndexed { index, item -> fileDiff(item, "$p/$index") } }
                o.optional("omittedFiles", path) { v, p -> integer(v, p, minimum = 0) }
            }
            "search" -> {
                o.required("query", path, ::string)
                o.optional("sources", path) { v, p ->
                    arr(v, p).forEachIndexed { index, item ->
                        val source = obj(item, "$p/$index")
                        source.required("title", "$p/$index", ::string)
                        source.required("url", "$p/$index", ::string)
                    }
                }
                o.required("target", path) { v, p -> oneOf(v, p, "web", "x") }
            }
            "agent_spawn" -> {
                o.optional("model", path) { v, p ->
                    val model = obj(v, p)
                    model.required("modelId", p, ::string)
                    model.required("providerId", p, ::string)
                    model.required("name", p, ::string)
                }
                o.optional("agentId", path, ::string)
            }
            "media" -> {
                val items = arr(o["items"], at(path, "items"))
                if (items.isEmpty()) invalid(at(path, "items"), "expected at least one item")
                items.forEachIndexed { index, item -> mediaItem(item, at(at(path, "items"), index)) }
                // A layout this build doesn't know is the automatic one.
                o.optional("layout", path) { v, p -> obj(v, p) }
            }
            "gen_ui" -> o.required("document", path) { v, p -> obj(v, p) }
            "artifact" -> {
                o.required("artifactId", path, ::string)
                o.required("version", path) { v, p -> integer(v, p, minimum = 1) }
                o.required("artifactType", path) { v, p -> oneOf(v, p, "markdown", "html", "image", "image_series", "video", "document", "gen_ui") }
                o.required("title", path, ::string)
                // A `shows` this build doesn't know means "version".
                o.optional("shows", path, ::string)
            }
            "page" -> {
                o.required("url", path, ::string)
                o.required("title", path, ::string)
                o.nullable("display", path) { v, p -> oneOf(v, p, "inline_compact", "inline_expanded", "side") }
            }
            "user_input" -> userInput(o, path)
            // Retired presentations ("ui", "quick_replies") are opaque history; newer ones leave the call a plain line.
            else -> Unit
        }
    }

    private fun operation(value: JsonElement?, path: String) {
        val o = obj(value, path)
        o.required("kind", path) { v, p -> oneOf(v, p, "list", "read", "search") }
        when ((o["kind"] as JsonPrimitive).content) {
            "list" -> o.required("target", path, ::string)
            "read" -> o.required("name", path, ::string)
            else -> {
                o.required("command", path, ::string)
                o.optional("path", path, ::string)
                o.optional("query", path, ::string)
            }
        }
    }

    private fun fileDiff(value: JsonElement?, path: String) {
        val o = obj(value, path)
        o.required("added", path) { v, p -> integer(v, p, minimum = 0) }
        o.required("deleted", path) { v, p -> integer(v, p, minimum = 0) }
        o.required("hunks", path) { v, p ->
            arr(v, p).forEachIndexed { index, item ->
                val hp = "$p/$index"
                val hunk = obj(item, hp)
                hunk.required("lines", hp) { lines, lp ->
                    arr(lines, lp).forEachIndexed { at, line ->
                        val l = obj(line, "$lp/$at")
                        l.required("kind", "$lp/$at") { k, kp -> oneOf(k, kp, "context", "add", "delete") }
                        l.required("text", "$lp/$at", ::string)
                    }
                }
                hunk.required("newStart", hp) { n, np -> integer(n, np, minimum = 0) }
                hunk.required("oldStart", hp) { n, np -> integer(n, np, minimum = 0) }
            }
        }
        o.required("kind", path) { v, p -> oneOf(v, p, "add", "delete", "update") }
        o.optional("language", path, ::string)
        o.optional("omittedLines", path) { v, p -> integer(v, p, minimum = 0) }
        o.required("path", path, ::string)
    }

    private fun mediaItem(value: JsonElement?, path: String) {
        val o = obj(value, path)
        o.optional("id", path, ::string)
        o.required("kind", path, ::string)
        o.required("name", path, ::string)
        o.required("mimeType", path, ::string)
        o.required("size", path) { v, p -> integer(v, p, minimum = 0) }
        if ((o["kind"] as JsonPrimitive).content == "image") {
            o.required("width", path) { v, p -> integer(v, p, minimum = 1) }
            o.required("height", path) { v, p -> integer(v, p, minimum = 1) }
            o.required("thumbhash", path, ::string)
        }
        attachmentDetails(o, path)
        o.optional("source", path) { v, p ->
            val source = obj(v, p)
            source.required("path", p, ::string)
            source.required("absolutePath", p, ::string)
        }
    }

    /** The questions a `request_user_input` call asked, and each one's answers by its ID. */
    private fun userInput(o: JsonObject, path: String) {
        val questions = arr(o["questions"], at(path, "questions"))
        if (questions.isEmpty()) invalid(at(path, "questions"), "expected at least one question")
        questions.forEachIndexed { index, item ->
            val qp = at(at(path, "questions"), index)
            val q = obj(item, qp)
            q.required("id", qp, ::string)
            // Empty is allowed (the cluster sends ""), past 64 is not, as desktop has it.
            q.required("header", qp) { v, p ->
                string(v, p)
                if ((v as JsonPrimitive).content.length > 64) invalid(p, "expected at most 64 characters")
            }
            q.required("question", qp, ::string)
            q.required("multiSelect", qp, ::boolean)
            q.required("options", qp) { v, p ->
                arr(v, p).forEachIndexed { at, option ->
                    val op = "$p/$at"
                    val opt = obj(option, op)
                    opt.required("label", op, ::string)
                    opt.required("description", op, ::string)
                }
            }
        }
        val answers = obj(o["answers"], at(path, "answers"))
        for ((id, values) in answers) stringArray(values, at(at(path, "answers"), id))
    }
}
