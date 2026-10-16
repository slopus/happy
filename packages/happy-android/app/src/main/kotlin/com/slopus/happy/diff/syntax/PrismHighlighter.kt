package com.slopus.happy.diff.syntax

import com.slopus.happy.diff.DiffHighlighter
import com.slopus.happy.diff.SpanKind
import com.slopus.happy.diff.SyntaxRun

/** happy-app engine/highlight.ts over [Prism]: Prism's token names collapsed to the theme's dozen colours, per line. */
object PrismHighlighter : DiffHighlighter {
    /** classify. */
    fun classify(type: String): SpanKind = when (type) {
        "keyword", "boolean", "null", "important", "atrule", "rule", "directive", "entity" -> SpanKind.Keyword
        "string", "char", "regex", "template-string", "attr-value", "url" -> SpanKind.Str
        "comment", "prolog", "doctype", "cdata", "docstring" -> SpanKind.Comment
        "number", "hexcode", "unit" -> SpanKind.Number
        "function", "method", "function-variable", "macro" -> SpanKind.Function
        "class-name", "builtin", "symbol", "namespace", "selector" -> SpanKind.Type
        "operator", "arrow" -> SpanKind.Operator
        "punctuation", "interpolation-punctuation" -> SpanKind.Punctuation
        "tag", "script" -> SpanKind.Tag
        "attr-name", "property", "parameter" -> SpanKind.Attr
        "variable", "constant" -> SpanKind.Variable
        else -> SpanKind.Plain
    }

    private fun plainLines(text: String) = text.split('\n').map { if (it.isEmpty()) emptyList() else listOf(SyntaxRun(SpanKind.Plain, it.length)) }

    /**
     * highlightLines: one run list per `\n`-separated line of [text]. Pass a
     * whole contiguous region: colouring depends on context (block comments,
     * template strings).
     */
    override fun highlightLines(text: String, language: String): List<List<SyntaxRun>> {
        val lineCount = if (text.isEmpty()) 1 else text.count { it == '\n' } + 1
        val tokens = (if (Prism.hasGrammar(language)) runCatching { Prism.tokenize(text, language) }.getOrNull() else null)
            ?: return plainLines(text)

        val out = ArrayList<List<SyntaxRun>>()
        var current = ArrayList<SyntaxRun>()
        fun push(kind: SpanKind, length: Int) {
            if (length <= 0) return
            val last = current.lastOrNull()
            if (last != null && last.kind == kind) current[current.lastIndex] = SyntaxRun(kind, last.length + length) else current.add(SyntaxRun(kind, length))
        }
        fun emit(location: Int, length: Int, kind: SpanKind) {
            var start = location
            val end = location + length
            while (true) {
                val newline = text.indexOf('\n', start).takeIf { it in start until end }
                if (newline == null) {
                    push(kind, end - start)
                    return
                }
                push(kind, newline - start)
                out.add(current)
                current = ArrayList()
                start = newline + 1
            }
        }
        fun walk(nodes: List<Prism.Node>, inherited: SpanKind) {
            for (node in nodes) {
                when (node) {
                    is Prism.Node.Text -> emit(node.location, node.length, inherited)
                    is Prism.Node.Token -> {
                        val kind = classify(node.name)
                        walk(node.content, if (kind == SpanKind.Plain) inherited else kind)
                    }
                }
            }
        }
        walk(tokens, SpanKind.Plain)
        out.add(current)
        // Defensive: walking tokens must not change the line count.
        while (out.size < lineCount) out.add(emptyList())
        return out
    }
}
