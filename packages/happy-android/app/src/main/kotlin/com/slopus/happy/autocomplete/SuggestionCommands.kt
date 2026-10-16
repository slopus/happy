package com.slopus.happy.autocomplete

import com.slopus.happy.model.SessionMetadata

/** suggestionCommands.ts `CommandItem`: a command without its slash. */
data class CommandItem(val command: String, val description: String? = null)

/** suggestionCommands.ts `IGNORED_COMMANDS`: CLI-only commands that make no sense from the phone. */
val IGNORED_COMMANDS = setOf(
    "add-dir", "agents", "config", "statusline", "bashes", "settings", "cost", "doctor", "exit", "help", "ide",
    "init", "install-github-app", "memory", "migrate-installer", "model", "pr-comments", "release-notes",
    "resume", "status", "bug", "review", "security-review", "terminal-setup", "upgrade", "vim", "permissions",
    "hooks", "export", "logout", "login",
)

/** Always offered, first. */
val DEFAULT_COMMANDS = listOf(
    CommandItem("compact", "Compact the conversation history"),
    CommandItem("clear", "Clear the conversation"),
    CommandItem("goal", "Set a session goal"),
    CommandItem("mcp", "Show connected MCP servers"),
    CommandItem("skills", "Show available skills"),
)

private val COMMAND_DESCRIPTIONS = mapOf(
    "compact" to "Compact the conversation history",
    "goal" to "Set a session goal",
    "help" to "Show available commands",
    "clear" to "Clear the conversation",
    "reset" to "Reset the session",
    "export" to "Export conversation",
    "debug" to "Show debug information",
    "status" to "Show connection status",
    "stop" to "Stop current operation",
    "abort" to "Abort current operation",
    "cancel" to "Cancel current operation",
)

/** suggestionCommands.ts `getCommandsFromSession`: the defaults, then the session's commands and skills, minus ignored ones. */
fun sessionCommands(metadata: SessionMetadata?): List<CommandItem> {
    if (metadata == null) return DEFAULT_COMMANDS
    val commands = DEFAULT_COMMANDS.toMutableList()
    for (command in metadata.slashCommands.orEmpty() + metadata.skills.orEmpty()) {
        if (command in IGNORED_COMMANDS || commands.any { it.command == command }) continue
        commands += CommandItem(command, COMMAND_DESCRIPTIONS[command])
    }
    return commands
}

/** suggestionCommands.ts `searchCommands`: everything for a blank query, else Fuse on command (0.7) and description (0.3). */
fun searchCommands(metadata: SessionMetadata?, query: String, limit: Int = 10, threshold: Double = 0.3): List<CommandItem> {
    val commands = sessionCommands(metadata)
    if (query.isBlank()) return commands.take(limit)
    val fuse = Fuse(
        commands,
        listOf(FuseKey(0.7) { it.command }, FuseKey(0.3) { it.description }),
        threshold = threshold,
        ignoreLocation = true,
        useExtendedSearch = true,
    )
    return fuse.search(query, limit).map { it.item }
}
