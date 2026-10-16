package com.slopus.happy.autocomplete

import com.slopus.happy.model.SessionMetadata
import kotlinx.coroutines.CancellationException

/** One row in the list; picking it puts [text] in place of the active word. */
sealed interface Suggestion {
    val key: String
    val text: String

    data class Command(val command: String, val description: String?) : Suggestion {
        override val key get() = "cmd-$command"
        override val text get() = "/$command"
    }

    data class FileMention(val fileName: String, val filePath: String, val fullPath: String, val fileType: FileItem.FileType) : Suggestion {
        override val key get() = "file-$fullPath"
        override val text get() = "@$fullPath"
    }
}

/** What the composer asks for suggestions: an active word such as `/co` or `@src/ma`. */
fun interface SuggestionSource {
    suspend fun suggestions(query: String): List<Suggestion>
}

/** suggestions.ts asks both searches for 50. */
const val SUGGESTION_LIMIT = 50

/**
 * suggestions.ts `getSuggestions` for one session: `/` searches the
 * session's commands, `@` its files; anything else, or a failure, gives
 * nothing.
 */
class SessionSuggestions(
    private val sessionId: String,
    private val metadata: () -> SessionMetadata?,
    private val files: FileSearchCache,
) : SuggestionSource {
    override suspend fun suggestions(query: String): List<Suggestion> = try {
        when {
            query.startsWith("/") -> searchCommands(metadata(), query.substring(1), SUGGESTION_LIMIT)
                .map { Suggestion.Command(it.command, it.description) }
            query.startsWith("@") -> files.search(sessionId, query.substring(1), SUGGESTION_LIMIT)
                .map { Suggestion.FileMention(it.fileName, it.filePath, it.fullPath, it.fileType) }
            else -> emptyList()
        }
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        emptyList()
    }
}

/**
 * useActiveSuggestions.ts's state with its defaults (clamp the selection,
 * select the first row when a list appears, wrap around). [selected] is -1
 * with nothing selected.
 */
data class SuggestionList(val suggestions: List<Suggestion> = emptyList(), val selected: Int = -1) {
    /** New results for the latest query. */
    fun replaced(next: List<Suggestion>): SuggestionList {
        val selected = when {
            next.isEmpty() -> -1
            suggestions.isEmpty() -> 0
            selected >= next.size -> next.size - 1
            selected < 0 -> 0
            else -> selected
        }
        return SuggestionList(next, selected)
    }

    fun movedUp(): SuggestionList = when {
        suggestions.isEmpty() -> this
        selected <= 0 -> copy(selected = suggestions.size - 1)
        else -> copy(selected = selected - 1)
    }

    fun movedDown(): SuggestionList = when {
        suggestions.isEmpty() -> this
        selected >= suggestions.size - 1 -> copy(selected = 0)
        selected < 0 -> copy(selected = 0)
        else -> copy(selected = selected + 1)
    }
}
