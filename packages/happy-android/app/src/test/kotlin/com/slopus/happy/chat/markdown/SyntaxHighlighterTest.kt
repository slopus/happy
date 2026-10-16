package com.slopus.happy.chat.markdown

import org.junit.Assert.assertEquals
import org.junit.Test

class SyntaxHighlighterTest {
    private fun types(code: String, language: String?) =
        tokenizeCode(code, language).filter { it.type != SyntaxTokenType.Default || it.text.isNotBlank() }.map { it.text.trim() to it.type }

    @Test
    fun noLanguageIsOnePlainToken() {
        assertEquals(listOf(SyntaxToken("const x = 1", SyntaxTokenType.Default)), tokenizeCode("const x = 1", null))
    }

    @Test
    fun keywordsStringsNumbersAndComments() {
        assertEquals(
            listOf(
                "const" to SyntaxTokenType.Keyword,
                "x" to SyntaxTokenType.Default,
                "=" to SyntaxTokenType.Assignment,
                "\"hi\"" to SyntaxTokenType.String,
                "+" to SyntaxTokenType.Operator,
                "42" to SyntaxTokenType.Number,
                ";" to SyntaxTokenType.Punctuation,
                "// done" to SyntaxTokenType.Comment,
            ),
            types("const x = \"hi\" + 42; // done", "ts"),
        )
    }

    @Test
    fun functionsMethodsAndBracketNesting() {
        val tokens = tokenizeCode("foo(bar.baz(1))", "js")
        assertEquals(SyntaxTokenType.Function, tokens.first { it.text == "foo" }.type)
        // The call pattern is listed before the method one and both start at "baz": it reads as a function, as in happy-app.
        assertEquals(SyntaxTokenType.Function, tokens.first { it.text == "baz" }.type)
        assertEquals(SyntaxTokenType.Property, tokenizeCode("a.b", "js").first { it.text == "b" }.type)
        assertEquals(listOf(1, 2, 2, 1), tokens.filter { it.type == SyntaxTokenType.Bracket }.map { it.nestLevel })
    }

    @Test
    fun linesKeepTheirBreaks() {
        val tokens = tokenizeCode("def f():\n    return True", "python")
        assertEquals("def f():\n    return True", tokens.joinToString("") { it.text })
        assertEquals(SyntaxTokenType.Function, tokens.first { it.text == "f" }.type)
        assertEquals(SyntaxTokenType.ControlFlow, tokens.first { it.text == "return" }.type)
        assertEquals(SyntaxTokenType.Boolean, tokens.first { it.text == "True" }.type)
    }
}
