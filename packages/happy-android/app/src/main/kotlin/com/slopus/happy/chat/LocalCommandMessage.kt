package com.slopus.happy.chat

/**
 * Claude Agent SDK's local slash-command wrapper messages, collapsed into
 * what the chat shows (components/parseLocalCommandMessage.ts). Rendered as
 * markdown unchanged, `<command-name>` and friends would read as raw HTML.
 */
sealed interface LocalCommandMessage {
    data object Caveat : LocalCommandMessage
    data class CommandRun(val commandName: String, val args: String? = null) : LocalCommandMessage
    data class GoalRun(val goal: String) : LocalCommandMessage
    data class GoalConfirmation(val goal: String) : LocalCommandMessage
    data class Text(val text: String) : LocalCommandMessage
}

private val CAVEAT_RE = Regex("^\\s*<local-command-caveat>[\\s\\S]*?</local-command-caveat>\\s*$")
private val STDOUT_RE = Regex("^\\s*<local-command-stdout>\\s*([\\s\\S]*?)\\s*</local-command-stdout>\\s*$")
private val COMMAND_NAME_RE = Regex("<command-name>\\s*/?([^<]+?)\\s*</command-name>")
private val COMMAND_ARGS_RE = Regex("<command-args>\\s*([\\s\\S]*?)\\s*</command-args>")
private val COMMAND_MESSAGE_TAG_RE = Regex("<command-message>[\\s\\S]*?</command-message>")
private val COMMAND_NAME_TAG_RE = Regex("<command-name>[\\s\\S]*?</command-name>")
private val COMMAND_ARGS_TAG_RE = Regex("<command-args>[\\s\\S]*?</command-args>")
private val RAW_SLASH_COMMAND_RE = Regex("^\\s*/([a-zA-Z][\\w:-]*)(?:\\s+([\\s\\S]*?))?\\s*$")
private val RAW_SLASH_COMMAND_TOKEN_RE = Regex("(^|\\s)/([a-zA-Z][\\w:-]*)(?=$|\\s)")
private val GOAL_STDOUT_RE = Regex("^Goal set:\\s*([\\s\\S]*?)\\s*$", RegexOption.IGNORE_CASE)

private data class RawSlashCommand(val commandName: String, val args: String?)

private fun rawSlashCommand(text: String): RawSlashCommand? {
    RAW_SLASH_COMMAND_RE.find(text)?.let { match ->
        val args = match.groups[2]?.value?.trim()
        return RawSlashCommand(match.groupValues[1].trim(), args?.ifEmpty { null })
    }
    val token = RAW_SLASH_COMMAND_TOKEN_RE.find(text) ?: return null
    val commandStart = token.range.first + token.groupValues[1].length
    val commandEnd = commandStart + token.groupValues[2].length + 1
    val before = text.substring(0, commandStart).trim()
    val after = text.substring(commandEnd).trim()
    val args = listOf(before, after).filter { it.isNotEmpty() }.joinToString(" ")
    return RawSlashCommand(token.groupValues[2].trim(), args.ifEmpty { null })
}

private fun goalFromStdout(text: String): String? =
    GOAL_STDOUT_RE.find(text.trim())?.groupValues?.get(1)?.trim()?.ifEmpty { null }

fun parseLocalCommandMessage(text: String): LocalCommandMessage {
    if (CAVEAT_RE.containsMatchIn(text)) return LocalCommandMessage.Caveat

    STDOUT_RE.find(text)?.let { match ->
        val stdout = match.groupValues[1].trim()
        goalFromStdout(stdout)?.let { return LocalCommandMessage.GoalConfirmation(it) }
        return LocalCommandMessage.Text(stdout)
    }

    rawSlashCommand(text)?.let { command ->
        if (command.commandName.lowercase() == "goal" && command.args != null) {
            return LocalCommandMessage.GoalRun(command.args)
        }
        return LocalCommandMessage.CommandRun(command.commandName, command.args)
    }

    COMMAND_NAME_RE.find(text)?.let { nameMatch ->
        val args = COMMAND_ARGS_RE.find(text)?.groupValues?.get(1)?.trim()?.ifEmpty { null }
        val commandName = nameMatch.groupValues[1].trim()
        // Only the wrappers: collapse to a chip, args surfaced separately.
        val stripped = text
            .replace(COMMAND_MESSAGE_TAG_RE, "")
            .replace(COMMAND_NAME_TAG_RE, "")
            .replace(COMMAND_ARGS_TAG_RE, "")
            .trim()
        if (stripped.isEmpty()) {
            if (commandName.lowercase() == "goal" && args != null) return LocalCommandMessage.GoalRun(args)
            return LocalCommandMessage.CommandRun(commandName, args)
        }
        return LocalCommandMessage.Text(stripped)
    }

    return LocalCommandMessage.Text(text)
}

/**
 * True for the user's own echoed slash command (it has a local id), which the
 * SDK re-emits as a `<command-name>` wrapper; the chat hides the echo and lets
 * the wrapper's chip stand in.
 */
fun isUserSlashCommandEcho(text: String, hasLocalId: Boolean): Boolean {
    if (!hasLocalId) return false
    val trimmed = text.trim()
    if (rawSlashCommand(trimmed) == null) return false
    val parsed = parseLocalCommandMessage(trimmed)
    return parsed is LocalCommandMessage.CommandRun || parsed is LocalCommandMessage.GoalRun
}
