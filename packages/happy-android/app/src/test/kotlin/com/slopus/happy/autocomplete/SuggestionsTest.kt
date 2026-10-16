package com.slopus.happy.autocomplete

import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.sync.RipgrepResult
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** suggestionCommands.ts, suggestionFile.ts, suggestions.ts and useActiveSuggestions.ts's selection. */
class SuggestionsTest {
    private val metadata = SessionMetadata.parse(
        """{"path": "/repo", "host": "mac", "slashCommands": ["compact", "review", "context", "help", "add-memory"], "skills": ["release", "context"]}""",
    )

    @Test
    fun commandsAreTheDefaultsThenTheSessionsMinusIgnored() {
        assertEquals(DEFAULT_COMMANDS, sessionCommands(null))
        val commands = sessionCommands(metadata)
        assertEquals(
            listOf("compact", "clear", "goal", "mcp", "skills", "context", "add-memory", "release"),
            commands.map { it.command },
        )
        assertEquals(null, commands.first { it.command == "context" }.description)
    }

    @Test
    fun aBlankCommandQueryListsEverythingUpToTheLimit() {
        assertEquals(8, searchCommands(metadata, "").size)
        assertEquals(listOf("compact", "clear"), searchCommands(metadata, " ", limit = 2).map { it.command })
        assertEquals(listOf("compact", "context"), searchCommands(metadata, "co").map { it.command }.take(2))
    }

    @Test
    fun slashSearchesCommandsAndAtSearchesFiles() = runBlocking {
        val files = FileSearchCache(ripgrep = { _, _ -> RipgrepResult(true, stdout = "src/main.kt\nREADME.md\n") })
        val source = SessionSuggestions("s1", { metadata }, files)

        val commands = source.suggestions("/rel")
        assertEquals(listOf(Suggestion.Command("release", null)), commands)
        assertEquals("/release", commands[0].text)
        assertEquals("cmd-release", commands[0].key)

        val mentions = source.suggestions("@main")
        assertEquals(Suggestion.FileMention("main.kt", "src/", "src/main.kt", FileItem.FileType.File), mentions[0])
        assertEquals("@src/main.kt", mentions[0].text)
        assertEquals("file-src/main.kt", mentions[0].key)

        assertEquals(listOf("@src/main.kt", "@README.md", "@src/"), source.suggestions("@").map { it.text })
        assertEquals(emptyList<Suggestion>(), source.suggestions(":smile"))
    }

    @Test
    fun aFailingLookupGivesNoSuggestions() = runBlocking {
        val files = FileSearchCache(ripgrep = { _, _ -> error("socket closed") })
        assertEquals(emptyList<Suggestion>(), SessionSuggestions("s1", { metadata }, files).suggestions("@x"))
    }

    @Test
    fun filesAreListedOnceThenKeptFiveMinutes() = runBlocking {
        var now = 1_000_000L
        val calls = mutableListOf<Pair<String, List<String>>>()
        val cache = FileSearchCache(ripgrep = { sid, args -> calls += sid to args; RipgrepResult(true, stdout = "a/b.txt") }, now = { now })

        assertEquals(listOf("a/b.txt", "a/"), cache.search("s1", "").map { it.fullPath })
        cache.search("s1", "b")
        assertEquals(listOf("s1" to listOf("--files", "--follow")), calls)

        now += FileSearchCache.CACHE_TIMEOUT_MS + 1
        cache.search("s1", "b")
        assertEquals(2, calls.size)

        cache.search("s2", "b")
        assertEquals("s2", calls.last().first)
    }

    @Test
    fun aFailedListingIsRetried() = runBlocking {
        var now = 0L
        var fail = true
        val cache = FileSearchCache(ripgrep = { _, _ -> if (fail) RipgrepResult(false, error = "nope") else RipgrepResult(true, stdout = "x.md") }, now = { now })
        assertTrue(cache.search("s1", "x").isEmpty())
        fail = false
        now += 2_000
        assertEquals(listOf("x.md"), cache.search("s1", "x").map { it.fullPath })
    }

    @Test
    fun selectionStartsOnTheFirstRowClampsAndWraps() {
        val a = Suggestion.Command("a", null)
        val b = Suggestion.Command("b", null)
        val c = Suggestion.Command("c", null)
        var list = SuggestionList().replaced(listOf(a, b, c))
        assertEquals(0, list.selected)
        list = list.movedUp()
        assertEquals(2, list.selected)
        list = list.movedDown()
        assertEquals(0, list.selected)
        list = list.movedDown().movedDown()
        assertEquals(2, list.selected)
        list = list.replaced(listOf(a, b))
        assertEquals(1, list.selected)
        list = list.replaced(emptyList())
        assertEquals(-1, list.selected)
        assertEquals(list, list.movedDown())
        assertEquals(0, list.replaced(listOf(c)).selected)
    }
}
