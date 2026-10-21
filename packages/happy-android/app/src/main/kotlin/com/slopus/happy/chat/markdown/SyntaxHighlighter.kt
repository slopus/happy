package com.slopus.happy.chat.markdown

import androidx.compose.runtime.Immutable

// SimpleSyntaxHighlighter.tsx's tokenizer: regexes per line, earliest match
// wins, ties go to the pattern listed first, brackets coloured by nesting.

enum class SyntaxTokenType {
    Keyword, ControlFlow, Type, Modifier, String, Number, Boolean, Regex, Function, Method, Property,
    Comment, Docstring, Operator, Assignment, Comparison, Logical, Decorator, Import, Bracket, Punctuation, Default;

    /** Keywords, types and functions are drawn semibold. */
    val emphasized: kotlin.Boolean get() = this == Keyword || this == ControlFlow || this == Type || this == Function
}

@Immutable
data class SyntaxToken(val text: String, val type: SyntaxTokenType, val nestLevel: Int = 0)

private class Pattern(val regex: Regex, val type: SyntaxTokenType, val group: Int = 0)

private val BRACKET_PAIRS = mapOf('(' to ')', '[' to ']', '{' to '}', '<' to '>')

private fun words(list: List<String>) = list.joinToString("|")

private fun patterns(language: String): List<Pattern> {
    val controlFlow = listOf(
        "if", "else", "elif", "for", "while", "do", "switch", "case", "break", "continue", "return", "yield", "try",
        "catch", "finally", "throw", "with",
    )
    val keywords = mutableListOf("function", "const", "let", "var", "def", "class", "interface", "enum", "struct", "union", "namespace", "module")
    val types = mutableListOf("int", "string", "bool", "float", "double", "char", "void", "any", "unknown", "never", "object", "array", "number", "boolean")
    val modifiers = mutableListOf("public", "private", "protected", "static", "final", "abstract", "virtual", "override", "async", "await", "export", "default")
    val booleans = listOf("true", "false", "null", "undefined", "None", "True", "False", "nil")
    val imports = listOf("import", "from", "export", "require", "include", "using", "package")
    when (language) {
        "python", "py" -> {
            keywords += listOf("def", "lambda", "pass", "global", "nonlocal", "as", "in", "is", "not", "and", "or")
            types += listOf("str", "list", "dict", "tuple", "set")
        }
        "typescript", "ts" -> {
            types += listOf("Record", "Partial", "Required", "Readonly", "Pick", "Omit")
            keywords += listOf("type", "interface", "extends", "implements", "keyof", "typeof")
        }
        "java" -> {
            keywords += listOf("package", "extends", "implements", "super", "this")
            modifiers += listOf("synchronized", "transient", "volatile", "native", "strictfp")
        }
    }
    return listOf(
        Pattern(Regex("""(/\*[\s\S]*?\*/)"""), SyntaxTokenType.Comment),
        Pattern(Regex("""(//.*$)"""), SyntaxTokenType.Comment),
        Pattern(Regex("""(#.*$)"""), SyntaxTokenType.Comment),
        Pattern(Regex("(\"\"\"[\\s\\S]*?\"\"\"|'''[\\s\\S]*?''')"), SyntaxTokenType.Docstring),
        Pattern(Regex("""(r?["'`])((?:(?!\1)[^\\]|\\.)*)(\1)"""), SyntaxTokenType.String),
        Pattern(Regex("""(/(?:[^/\\\n]|\\.)+/[gimuy]*)"""), SyntaxTokenType.Regex),
        Pattern(Regex("""\b(0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b"""), SyntaxTokenType.Number),
        Pattern(Regex("""@\w+"""), SyntaxTokenType.Decorator),
        Pattern(Regex("""\b(function|def|async function)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)"""), SyntaxTokenType.Function, group = 2),
        Pattern(Regex("""\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()"""), SyntaxTokenType.Function),
        Pattern(Regex("""\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()"""), SyntaxTokenType.Method, group = 1),
        Pattern(Regex("""\.([a-zA-Z_$][a-zA-Z0-9_$]*)"""), SyntaxTokenType.Property, group = 1),
        Pattern(Regex("""\b(${words(imports)})\b"""), SyntaxTokenType.Import),
        Pattern(Regex("""\b(${words(controlFlow)})\b"""), SyntaxTokenType.ControlFlow),
        Pattern(Regex("""\b(${words(keywords)})\b"""), SyntaxTokenType.Keyword),
        Pattern(Regex("""\b(${words(types)})\b"""), SyntaxTokenType.Type),
        Pattern(Regex("""\b(${words(modifiers)})\b"""), SyntaxTokenType.Modifier),
        Pattern(Regex("""\b(${words(booleans)})\b"""), SyntaxTokenType.Boolean),
        Pattern(Regex("""(===|!==|==|!=|<=|>=|<|>)"""), SyntaxTokenType.Comparison),
        Pattern(Regex("""(&&|\|\||!)"""), SyntaxTokenType.Logical),
        Pattern(Regex("""(=|\+=|-=|\*=|/=|%=|\|=|&=|\^=)"""), SyntaxTokenType.Assignment),
        Pattern(Regex("""(\+|-|\*|/|%|\*\*)"""), SyntaxTokenType.Operator),
        Pattern(Regex("""(\?|:)"""), SyntaxTokenType.Operator),
        Pattern(Regex("""([()\[\]{}])"""), SyntaxTokenType.Bracket),
        Pattern(Regex("""([.,;])"""), SyntaxTokenType.Punctuation),
    )
}

private fun bracketNesting(code: String): Map<Int, Int> {
    val nesting = HashMap<Int, Int>()
    val stack = ArrayList<Char>()
    for ((i, char) in code.withIndex()) {
        if (char in BRACKET_PAIRS.keys) {
            stack.add(char)
            nesting[i] = stack.size
        } else if (char in BRACKET_PAIRS.values && stack.isNotEmpty()) {
            val open = stack.removeAt(stack.lastIndex)
            if (BRACKET_PAIRS[open] == char) nesting[i] = stack.size + 1
        }
    }
    return nesting
}

/** `tokenizeCode`: no language means one plain token. */
fun tokenizeCode(code: String, language: String?): List<SyntaxToken> {
    if (language == null) return listOf(SyntaxToken(code, SyntaxTokenType.Default))
    val patterns = patterns(language.lowercase())
    val nesting = bracketNesting(code)
    val tokens = ArrayList<SyntaxToken>()
    var offset = 0
    for ((lineIndex, line) in code.split('\n').withIndex()) {
        if (lineIndex > 0) {
            tokens.add(SyntaxToken("\n", SyntaxTokenType.Default))
            offset += 1
        }
        class Found(val start: Int, val end: Int, val type: SyntaxTokenType)
        val found = ArrayList<Found>()
        for (pattern in patterns) {
            for (match in pattern.regex.findAll(line)) {
                if (match.value.isEmpty()) continue
                val text = if (pattern.group > 0) match.groupValues[pattern.group] else match.value
                val start = if (pattern.group > 0) match.range.first + match.value.indexOf(text) else match.range.first
                found.add(Found(start, start + text.length, pattern.type))
            }
        }
        var lastEnd = 0
        var current = 0
        for (token in found.sortedBy { it.start }) {
            if (token.start < lastEnd) continue
            lastEnd = token.end
            if (token.start > current) tokens.add(SyntaxToken(line.substring(current, token.start), SyntaxTokenType.Default))
            val text = line.substring(token.start, token.end)
            tokens.add(
                if (token.type == SyntaxTokenType.Bracket) SyntaxToken(text, token.type, nesting[offset + token.start] ?: 1)
                else SyntaxToken(text, token.type),
            )
            current = token.end
        }
        if (current < line.length) tokens.add(SyntaxToken(line.substring(current), SyntaxTokenType.Default))
        offset += line.length
    }
    return tokens
}
