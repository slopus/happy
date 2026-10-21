package com.slopus.happy.autocomplete

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** findActiveWord.test.ts, case for case. */
class FindActiveWordTest {
    @Test
    fun `should detect @ mention at cursor`() {
        val content = "Hello @john"
        val selection = TextSelection(11, 11)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@john", "@john", 6, 5, 5, 11), result)
    }

    @Test
    fun `should detect colon emoji at cursor`() {
        val content = "I feel :happy"
        val selection = TextSelection(13, 13)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord(":happy", ":happy", 7, 6, 6, 13), result)
    }

    @Test
    fun `should detect slash command at cursor`() {
        val content = "Type /help for info"
        val selection = TextSelection(10, 10)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("/help", "/help", 5, 5, 5, 10), result)
    }

    @Test
    fun `should detect # tag at cursor`() {
        val content = "This is #important"
        val selection = TextSelection(18, 18)
        val result = findActiveWord(content, selection, listOf('@', ':', '/', '#'))
        assertEquals(ActiveWord("#important", "#important", 8, 10, 10, 18), result)
    }

    @Test
    fun `should return just the prefix when typed alone`() {
        val content = "Hello @"
        val selection = TextSelection(7, 7)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@", "@", 6, 1, 1, 7), result)
    }

    @Test
    fun `should only detect prefix at word boundary`() {
        val content = "email@domain.com"
        val selection = TextSelection(16, 16)
        val result = findActiveWord(content, selection)
        assertNull(result)
    }

    @Test
    fun `should detect prefix after space`() {
        val content = "Hello @user"
        val selection = TextSelection(11, 11)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@user", 6, 5, 5, 11), result)
    }

    @Test
    fun `should detect prefix at start of line`() {
        val content = "@user hello"
        val selection = TextSelection(5, 5)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@user", 0, 5, 5, 5), result)
    }

    @Test
    fun `should detect prefix after newline`() {
        val content = "Hello\n@user"
        val selection = TextSelection(11, 11)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@user", 6, 5, 5, 11), result)
    }

    @Test
    fun `should stop at newline`() {
        val content = "Hello\n@user"
        val selection = TextSelection(11, 11)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@user", 6, 5, 5, 11), result)
    }

    @Test
    fun `should stop at comma`() {
        val content = "Hi, @user"
        val selection = TextSelection(9, 9)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@user", 4, 5, 5, 9), result)
    }

    @Test
    fun `should stop at parentheses`() {
        val content = "(@user)"
        val selection = TextSelection(6, 6)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@user", 1, 5, 5, 6), result)
    }

    @Test
    fun `should stop at brackets`() {
        val content = "[@user]"
        val selection = TextSelection(6, 6)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@user", 1, 5, 5, 6), result)
    }

    @Test
    fun `should stop at braces`() {
        val content = "{@user}"
        val selection = TextSelection(6, 6)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@user", 1, 5, 5, 6), result)
    }

    @Test
    fun `should stop at angle brackets`() {
        val content = "<@user>"
        val selection = TextSelection(6, 6)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@user", 1, 5, 5, 6), result)
    }

    @Test
    fun `should stop at semicolon`() {
        val content = "text;@user"
        val selection = TextSelection(10, 10)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@user", 5, 5, 5, 10), result)
    }

    @Test
    fun `should handle single space before prefix`() {
        val content = "Hello @user"
        val selection = TextSelection(11, 11)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@user", 6, 5, 5, 11), result)
    }

    @Test
    fun `should stop at multiple spaces`() {
        val content = "Hello  @user"
        val selection = TextSelection(12, 12)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@user", 7, 5, 5, 12), result)
    }

    @Test
    fun `should handle spaces within active word search`() {
        val content = "text @user name"
        val selection = TextSelection(10, 10)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@user", 5, 5, 5, 10), result)
    }

    @Test
    fun `should return undefined when cursor at beginning`() {
        val content = "@user"
        val selection = TextSelection(0, 0)
        val result = findActiveWord(content, selection)
        assertNull(result)
    }

    @Test
    fun `should return undefined when text is selected`() {
        val content = "Hello @user"
        val selection = TextSelection(6, 11)
        val result = findActiveWord(content, selection)
        assertNull(result)
    }

    @Test
    fun `should handle empty content`() {
        val content = ""
        val selection = TextSelection(0, 0)
        val result = findActiveWord(content, selection)
        assertNull(result)
    }

    @Test
    fun `should handle cursor in middle of word without prefix`() {
        val content = "Hello world"
        val selection = TextSelection(8, 8)
        val result = findActiveWord(content, selection)
        assertNull(result)
    }

    @Test
    fun `should handle prefix not in the prefix list`() {
        val content = "Hello \$user"
        val selection = TextSelection(11, 11)
        val result = findActiveWord(content, selection)
        assertNull(result)
    }

    @Test
    fun `should work with custom prefix array`() {
        val content = "Hello \$user"
        val selection = TextSelection(11, 11)
        val result = findActiveWord(content, selection, listOf('$'))
        assertEquals(ActiveWord("\$user", "\$user", 6, 5, 5, 11), result)
    }

    @Test
    fun `should work with multiple custom prefixes`() {
        val content1 = "Hello \$user"
        val selection1 = TextSelection(11, 11)
        val result1 = findActiveWord(content1, selection1, listOf('$', '%'))
        assertEquals(ActiveWord("\$user", "\$user", 6, 5, 5, 11), result1)

        val content2 = "Hello %task"
        val selection2 = TextSelection(11, 11)
        val result2 = findActiveWord(content2, selection2, listOf('$', '%'))
        assertEquals(ActiveWord("%task", "%task", 6, 5, 5, 11), result2)
    }

    @Test
    fun `should use default prefixes when none provided`() {
        val content = "Hello @user"
        val selection = TextSelection(11, 11)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@user", 6, 5, 5, 11), result)
    }

    @Test
    fun `should return full word and active part when cursor in middle`() {
        val content = "Hello @username!"
        val selection = TextSelection(10, 10)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@username", "@use", 6, 9, 4, 15), result)
    }

    @Test
    fun `should handle cursor at different positions in word`() {
        val content = "Type @mention here"
        val result1 = findActiveWord(content, TextSelection(7, 7))
        assertEquals(ActiveWord("@mention", "@m", 5, 8, 2, 13), result1)
        val result2 = findActiveWord(content, TextSelection(10, 10))
        assertEquals(ActiveWord("@mention", "@ment", 5, 8, 5, 13), result2)
    }

    @Test
    fun `should stop at stop characters after cursor`() {
        val content = "Hello @user, welcome"
        val selection = TextSelection(9, 9)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@user", "@us", 6, 5, 3, 11), result)
    }

    @Test
    fun `should handle word ending with space after cursor`() {
        val content = "Use :smile face"
        val selection = TextSelection(8, 8)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord(":smile", ":smi", 4, 6, 4, 10), result)
    }

    @Test
    fun `should handle multiple prefixes in same line`() {
        val content = "Hey @john, use :smile: and /help"
        val selection1 = TextSelection(9, 9)
        val result1 = findActiveWord(content, selection1)
        assertEquals(ActiveWord("@john", "@john", 4, 5, 5, 9), result1)

        val selection2 = TextSelection(22, 22)
        val result2 = findActiveWord(content, selection2)
        assertEquals(ActiveWord(":smile:", ":smile:", 15, 7, 7, 22), result2)

        val selection3 = TextSelection(32, 32)
        val result3 = findActiveWord(content, selection3)
        assertEquals(ActiveWord("/help", "/help", 27, 5, 5, 32), result3)
    }

    @Test
    fun `should handle prefix at end of text`() {
        val content = "Hello @"
        val selection = TextSelection(7, 7)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@", "@", 6, 1, 1, 7), result)
    }

    @Test
    fun `should handle long active words`() {
        val content = "Hello @very_long_username_here"
        val selection = TextSelection(30, 30)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@very_long_username_here", "@very_long_username_here", 6, 24, 24, 30), result)
    }

    @Test
    fun `should handle cursor positions within active word`() {
        val content = "Hello @username"
        val selection = TextSelection(10, 10)
        val result = findActiveWord(content, selection)
        assertEquals(ActiveWord("@username", "@use", 6, 9, 4, 15), result)
    }

    @Test
    fun `should return just the word string for backward compatibility`() {
        val content = "Hello @john"
        val selection = TextSelection(11, 11)
        val result = findActiveWordString(content, selection)
        assertEquals("@john", result)
    }

    @Test
    fun `should return undefined when no active word`() {
        val content = "Hello world"
        val selection = TextSelection(11, 11)
        val result = findActiveWordString(content, selection)
        assertNull(result)
    }

    @Test
    fun `should extract query without prefix`() {
        assertEquals("user", getActiveWordQuery("@user"))
        assertEquals("smile", getActiveWordQuery(":smile"))
        assertEquals("help", getActiveWordQuery("/help"))
        assertEquals("tag", getActiveWordQuery("#tag"))
    }

    @Test
    fun `should return empty string for just prefix`() {
        assertEquals("", getActiveWordQuery("@"))
        assertEquals("", getActiveWordQuery(":"))
        assertEquals("", getActiveWordQuery("/"))
        assertEquals("", getActiveWordQuery("#"))
    }

    @Test
    fun `should handle empty string`() {
        assertEquals("", getActiveWordQuery(""))
    }

    @Test
    fun `should handle long queries`() {
        assertEquals("very_long_username", getActiveWordQuery("@very_long_username"))
    }
}
