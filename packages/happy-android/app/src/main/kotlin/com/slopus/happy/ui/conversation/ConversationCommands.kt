package com.slopus.happy.ui.conversation

import com.slopus.happy.agent.TeamUser
import com.slopus.happy.autocomplete.Suggestion
import com.slopus.happy.autocomplete.SuggestionSource
import com.slopus.happy.autocomplete.TextSelection
import com.slopus.happy.autocomplete.findActiveWord
import com.slopus.happy.autocomplete.mentionMarkdown
import com.slopus.happy.autocomplete.searchPeople
import com.slopus.happy.conversation.SlashCommand
import com.slopus.happy.conversation.SlashCommands

/**
 * A Happy Agent's slash commands as the composer's suggestion list offers
 * them ([SlashCommands]): only while the whole draft is `/` and a word some
 * command begins, commands before skills. A picked command runs at once
 * ([run]); a skill instead becomes `/name ` in the draft, for what it is
 * asked to do, as desktop's palette has it (4078fd44). A new chat has no
 * [agentId] yet and offers the computer's skills.
 *
 * Anywhere else, an `@` word at the cursor offers the team's [people]
 * ([searchPeople], [self] left out), as desktop's mention list does; a
 * picked person goes in as their mention ([mentionMarkdown]).
 */
class ConversationCommands(
    private val agentId: String?,
    private val commands: () -> List<SlashCommand>,
    private val people: () -> List<TeamUser> = { emptyList() },
    private val self: () -> String? = { null },
    private val run: (SlashCommand) -> Boolean,
) : SuggestionSource {
    override fun query(text: String, selection: TextSelection): String? =
        SlashCommands.query(text, commands())?.let { "/$it" }
            ?: findActiveWord(text, selection, MENTION_PREFIXES)?.activeWord?.takeIf { people().isNotEmpty() }

    override suspend fun suggestions(query: String): List<Suggestion> = when {
        query.startsWith("@") -> searchPeople(people(), query.substring(1), self())
            .mapNotNull { user -> mentionMarkdown(user)?.let { Suggestion.Person(user, it) } }
        else -> SlashCommands.matching(commands(), query.removePrefix("/")).map { Suggestion.AgentCommand(it, agentId) }
    }

    override fun pick(suggestion: Suggestion): Boolean =
        suggestion is Suggestion.AgentCommand && !suggestion.command.isSkill && run(suggestion.command)

    override fun draft(suggestion: Suggestion): String? = (suggestion as? Suggestion.AgentCommand)?.let { "/${it.command.name} " }

    private companion object {
        val MENTION_PREFIXES = listOf('@')
    }
}
