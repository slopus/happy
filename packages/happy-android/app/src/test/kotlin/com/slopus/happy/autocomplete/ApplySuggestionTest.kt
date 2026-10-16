package com.slopus.happy.autocomplete

import org.junit.Assert.assertEquals
import org.junit.Test

/** applySuggestion.test.ts, case for case. */
class ApplySuggestionTest {
    @Test
    fun `should replace @ mention at end of text`() {
        val content = "Hello @joh"
        val selection = TextSelection(10, 10)
        val result = applySuggestion(content, selection, "@john_smith")
        assertEquals(AppliedSuggestion("Hello @john_smith ", 18), result)
    }

    @Test
    fun `should replace colon emoji at end of text`() {
        val content = "I feel :hap"
        val selection = TextSelection(11, 11)
        val result = applySuggestion(content, selection, ":happy:")
        assertEquals(AppliedSuggestion("I feel :happy: ", 15), result)
    }

    @Test
    fun `should replace slash command at end of text`() {
        val content = "Type /hel"
        val selection = TextSelection(9, 9)
        val result = applySuggestion(content, selection, "/help")
        assertEquals(AppliedSuggestion("Type /help ", 11), result)
    }

    @Test
    fun `should replace entire word when cursor is in middle`() {
        val content = "Hello @username here"
        val selection = TextSelection(10, 10)
        val result = applySuggestion(content, selection, "@john_smith")
        assertEquals(AppliedSuggestion("Hello @john_smith here", 17), result)
    }

    @Test
    fun `should handle cursor at beginning of word after prefix`() {
        val content = "Hello @username"
        val selection = TextSelection(7, 7)
        val result = applySuggestion(content, selection, "@john_smith")
        assertEquals(AppliedSuggestion("Hello @john_smith ", 18), result)
    }

    @Test
    fun `should add space when there is more text after`() {
        val content = "Hello @user,welcome"
        val selection = TextSelection(11, 11)
        val result = applySuggestion(content, selection, "@john_smith")
        assertEquals(AppliedSuggestion("Hello @john_smith ,welcome", 18), result)
    }

    @Test
    fun `should not add double space if space already exists`() {
        val content = "Hello @user welcome"
        val selection = TextSelection(11, 11)
        val result = applySuggestion(content, selection, "@john_smith")
        assertEquals(AppliedSuggestion("Hello @john_smith welcome", 17), result)
    }

    @Test
    fun `should respect addSpace parameter when false`() {
        val content = "Hello @user"
        val selection = TextSelection(11, 11)
        val result = applySuggestion(content, selection, "@john_smith", listOf('@', ':', '/'), false)
        assertEquals(AppliedSuggestion("Hello @john_smith", 17), result)
    }

    @Test
    fun `should insert suggestion at cursor when no active word`() {
        val content = "Hello world"
        val selection = TextSelection(6, 6)
        val result = applySuggestion(content, selection, "@john_smith")
        assertEquals(AppliedSuggestion("Hello @john_smith world", 18), result)
    }

    @Test
    fun `should handle text selection replacement`() {
        val content = "Hello world"
        val selection = TextSelection(6, 11)
        val result = applySuggestion(content, selection, "@john_smith")
        assertEquals(AppliedSuggestion("Hello @john_smith ", 18), result)
    }

    @Test
    fun `should handle empty content`() {
        val content = ""
        val selection = TextSelection(0, 0)
        val result = applySuggestion(content, selection, "@john_smith")
        assertEquals(AppliedSuggestion("@john_smith ", 12), result)
    }

    @Test
    fun `should handle suggestion at start of text`() {
        val content = "@use"
        val selection = TextSelection(4, 4)
        val result = applySuggestion(content, selection, "@john_smith")
        assertEquals(AppliedSuggestion("@john_smith ", 12), result)
    }

    @Test
    fun `should handle multiple words with same prefix`() {
        val content = "Hi @user1, meet @user2"
        val selection = TextSelection(9, 9)
        val result = applySuggestion(content, selection, "@alice")
        assertEquals(AppliedSuggestion("Hi @alice , meet @user2", 10), result)
    }

    @Test
    fun `should work with custom prefixes`() {
        val content = "Use \$var"
        val selection = TextSelection(8, 8)
        val result = applySuggestion(content, selection, "\$variable", listOf('$'))
        assertEquals(AppliedSuggestion("Use \$variable ", 14), result)
    }

    @Test
    fun `should properly replace word before stop character`() {
        val content = "Hello @user!"
        val selection = TextSelection(11, 11)
        val result = applySuggestion(content, selection, "@john_smith")
        assertEquals(AppliedSuggestion("Hello @john_smith !", 18), result)
    }

    @Test
    fun `should handle parentheses`() {
        val content = "(@user)"
        val selection = TextSelection(6, 6)
        val result = applySuggestion(content, selection, "@john_smith")
        assertEquals(AppliedSuggestion("(@john_smith )", 13), result)
    }
}
