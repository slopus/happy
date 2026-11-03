package com.slopus.happy.ui.conversation

import com.slopus.happy.autocomplete.Suggestion
import com.slopus.happy.autocomplete.SuggestionSource
import com.slopus.happy.autocomplete.TextSelection
import com.slopus.happy.conversation.SlashCommand
import com.slopus.happy.conversation.SlashCommands

/**
 * A Happy Agent's slash commands as the composer's suggestion list offers
 * them ([SlashCommands]): only while the whole draft is `/` and a word some
 * command begins, commands before skills. A picked command runs at once
 * ([run]); a skill instead becomes `/name ` in the draft, for what it is
 * asked to do, as desktop's palette has it (4078fd44).
 */
class ConversationCommands(
    private val agentId: String,
    private val commands: () -> List<SlashCommand>,
    private val run: (SlashCommand) -> Boolean,
) : SuggestionSource {
    override fun query(text: String, selection: TextSelection): String? = SlashCommands.query(text, commands())?.let { "/$it" }

    override suspend fun suggestions(query: String): List<Suggestion> =
        SlashCommands.matching(commands(), query.removePrefix("/")).map { Suggestion.AgentCommand(it, agentId) }

    override fun pick(suggestion: Suggestion): Boolean =
        suggestion is Suggestion.AgentCommand && !suggestion.command.isSkill && run(suggestion.command)

    override fun draft(suggestion: Suggestion): String? = (suggestion as? Suggestion.AgentCommand)?.let { "/${it.command.name} " }
}
