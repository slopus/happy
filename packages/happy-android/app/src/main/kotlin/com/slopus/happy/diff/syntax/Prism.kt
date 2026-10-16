package com.slopus.happy.diff.syntax

import java.util.regex.Matcher
import java.util.regex.Pattern

/**
 * prism-core's `Prism.tokenize`, over the grammars
 * tools/prism/generate-grammars.cjs writes to resources/diff/prism-grammars.txt
 * with their patterns rewritten for java.util.regex. Offsets are UTF-16, as
 * in JavaScript. Ported from happy-ios's HappyCore/Diff/Syntax/Prism.swift.
 */
object Prism {
    /** What `Prism.tokenize` returns: plain text, or a named token over its content. Ranges are into the tokenized text. */
    sealed interface Node {
        data class Text(val location: Int, val length: Int) : Node
        data class Token(val name: String, val content: List<Node>) : Node
    }

    private class PatternSpec(val source: Int, val ignoreCase: Boolean, val lookbehind: Boolean, val greedy: Boolean, val inside: Int)

    private class TokenSpec(val name: String, val patterns: List<PatternSpec>)

    /** The parsed table; patterns compile on first use. */
    private class Table(text: String) {
        val languages = HashMap<String, Int>()
        val grammars = ArrayList<List<TokenSpec>>()
        val sources: List<String>
        private val compiled = HashMap<Int, Pattern>()

        init {
            val macros = ArrayList<Pair<String, String>>()
            val patterns = ArrayList<String>()
            val tokens = ArrayList<MutableList<TokenSpec>>()
            var section = ""
            var pendingMacro: String? = null
            for (line in text.split('\n')) {
                if (line.startsWith("#")) {
                    if (line.startsWith("#languages") || line.startsWith("#macros") || line.startsWith("#grammars") || line.startsWith("#patterns")) {
                        section = line.substringBefore(':')
                    }
                    continue
                }
                when (section) {
                    "#languages" -> if (line.isNotEmpty()) languages[line.substringBefore(' ')] = line.substringAfter(' ').toInt()
                    "#macros" -> if (pendingMacro == null) pendingMacro = line else {
                        macros.add(pendingMacro to line)
                        pendingMacro = null
                    }
                    "#grammars" -> when (line.firstOrNull()) {
                        '@' -> tokens.add(ArrayList())
                        '=' -> tokens.last().add(TokenSpec(line.substring(1), ArrayList()))
                        '~' -> {
                            val fields = line.substring(1).split(' ')
                            val flags = fields[0]
                            (tokens.last().last().patterns as MutableList).add(
                                PatternSpec(fields[2].toInt(), flags[0] == 'i', flags[1] == 'l', flags[2] == 'g', fields[1].toInt()),
                            )
                        }
                    }
                    "#patterns" -> patterns.add(line)
                }
            }
            // The table ends with a newline: the last piece is not a pattern.
            if (patterns.lastOrNull()?.isEmpty() == true) patterns.removeAt(patterns.lastIndex)
            sources = patterns.map { source -> macros.fold(source) { s, (name, value) -> s.replace(name, value) } }
            grammars.addAll(tokens)
        }

        @Synchronized
        fun regex(pattern: PatternSpec): Pattern {
            val key = pattern.source * 2 + if (pattern.ignoreCase) 1 else 0
            return compiled.getOrPut(key) {
                // JavaScript's `i` without `u` folds case by Unicode's simple mappings.
                Pattern.compile(sources[pattern.source], if (pattern.ignoreCase) Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE else 0)
            }
        }
    }

    private val table: Table by lazy {
        val stream = requireNotNull(Prism::class.java.classLoader?.getResourceAsStream("diff/prism-grammars.txt")) { "diff/prism-grammars.txt missing" }
        Table(stream.bufferedReader().use { it.readText() })
    }

    /** Language ids with a grammar. */
    val languages: Set<String> get() = table.languages.keys

    fun hasGrammar(language: String?): Boolean = language != null && language in table.languages

    /** Compiles every pattern; for tests. */
    internal fun compileAll(): Int {
        var count = 0
        for (grammar in table.grammars) for (token in grammar) for (pattern in token.patterns) {
            table.regex(pattern)
            count++
        }
        return count
    }

    /**
     * The thread Prism runs on. java.util.regex recurses once per repetition
     * of a group with alternatives, which Prism's patterns are full of
     * (`(?:[^`\\]|\\.)*`), so a long string or code block overflows an
     * ordinary stack where V8 would not. This one has 256 MB of it.
     */
    private const val STACK_BYTES = 256L * 1024 * 1024
    @Volatile private var thread: Thread? = null
    internal val executor: java.util.concurrent.ExecutorService = java.util.concurrent.Executors.newSingleThreadExecutor { task ->
        Thread(null, task, "prism", STACK_BYTES).apply { isDaemon = true }.also { thread = it }
    }

    // By identity: coroutines' debug mode renames the threads it runs on.
    private fun onWorker() = Thread.currentThread() === thread

    /** The text's tokens in [language]'s grammar; null without one. Runs on Prism's own thread. */
    fun tokenize(text: String, language: String): List<Node>? {
        val index = table.languages[language] ?: return null
        if (onWorker()) return Tokenizer(text, 0).tokenize(index)
        return try {
            executor.submit<List<Node>> { Tokenizer(text, 0).tokenize(index) }.get()
        } catch (e: java.util.concurrent.ExecutionException) {
            throw e.cause ?: e
        }
    }

    /**
     * Prism's LinkedList, matchGrammar and matchPattern over one text. Nodes
     * live in arrays; index 0 is the head and 1 the tail.
     */
    private class Tokenizer(private val text: String, private val base: Int) {
        private sealed interface Value {
            val length: Int

            /** Text from [location] in this tokenizer's text. */
            class Text(val location: Int, override val length: Int) : Value
            class Token(val name: String, val content: List<Node>, override val length: Int) : Value
        }

        /** matchGrammar's `rematch`: which pattern caused it, and how far it looks. */
        private class Rematch(val token: Int, val pattern: Int, var reach: Int)

        private val length = text.length
        private val values = arrayListOf<Value?>(null, null)
        private val next = arrayListOf(1, -1)
        private val previous = arrayListOf(-1, 0)
        private var count = 0
        private val head = 0
        private val tail = 1
        private val matchers = HashMap<Pattern, Matcher>()

        fun tokenize(grammar: Int): List<Node> {
            addAfter(head, Value.Text(0, length))
            matchGrammar(grammar, head, 0, null)
            val nodes = ArrayList<Node>()
            var node = next[head]
            while (node != tail) {
                when (val value = values[node]!!) {
                    is Value.Text -> nodes.add(Node.Text(base + value.location, value.length))
                    is Value.Token -> nodes.add(Node.Token(value.name, value.content))
                }
                node = next[node]
            }
            return nodes
        }

        private fun addAfter(node: Int, value: Value): Int {
            val after = next[node]
            val index = values.size
            values.add(value)
            next.add(after)
            previous.add(node)
            next[node] = index
            previous[after] = index
            count++
            return index
        }

        private fun removeRange(node: Int, removeCount: Int) {
            var after = next[node]
            var removed = 0
            while (removed < removeCount && after != tail) {
                after = next[after]
                removed++
            }
            next[node] = after
            previous[after] = node
            count -= removed
        }

        private fun nodeLength(node: Int) = values[node]?.length ?: 0

        private fun isText(node: Int) = values[node] is Value.Text

        /**
         * matchPattern: the first match from [start] to [end], less its
         * lookbehind group. Greedy patterns search the rest of the whole text
         * and may look behind their start (`exec` from `lastIndex`); the
         * others search one text node alone (`exec` on its `value`), so
         * lookarounds cannot see past the node: opaque bounds.
         */
        private fun match(regex: Pattern, start: Int, end: Int, transparent: Boolean, lookbehind: Boolean): IntRange? {
            val matcher = matchers.getOrPut(regex) { regex.matcher(text) }
            matcher.region(start, end)
            matcher.useTransparentBounds(transparent)
            matcher.useAnchoringBounds(!transparent)
            if (!matcher.find()) return null
            var from = matcher.start()
            val to = matcher.end()
            if (lookbehind && matcher.groupCount() >= 1) {
                val groupStart = matcher.start(1)
                if (groupStart != -1) from += matcher.end(1) - groupStart
            }
            return from until to
        }

        private fun matchGrammar(grammarIndex: Int, startNode: Int, startPosition: Int, rematch: Rematch?) {
            val grammar = table.grammars[grammarIndex]
            for ((tokenIndex, token) in grammar.withIndex()) {
                for ((patternIndex, pattern) in token.patterns.withIndex()) {
                    if (rematch != null && rematch.token == tokenIndex && rematch.pattern == patternIndex) return
                    val regex = table.regex(pattern)

                    var currentNode = next[startNode]
                    var position = startPosition
                    while (currentNode != tail) {
                        if (rematch != null && position >= rematch.reach) break
                        // "Something went terribly wrong."
                        if (count > length) return
                        val value = values[currentNode]
                        if (value !is Value.Text) {
                            position += nodeLength(currentNode)
                            currentNode = next[currentNode]
                            continue
                        }
                        var strStart = value.location
                        var strLength = value.length

                        var removeCount = 1
                        val from: Int
                        val matchLength: Int
                        if (pattern.greedy) {
                            val found = match(regex, position, length, transparent = true, lookbehind = pattern.lookbehind)
                            if (found == null || found.first >= length) break
                            val matchFrom = found.first
                            val matchTo = found.last + 1
                            var p = position + nodeLength(currentNode)
                            while (matchFrom >= p) {
                                currentNode = next[currentNode]
                                p += nodeLength(currentNode)
                            }
                            p -= nodeLength(currentNode)
                            position = p
                            if (!isText(currentNode)) {
                                position += nodeLength(currentNode)
                                currentNode = next[currentNode]
                                continue
                            }
                            var k = currentNode
                            while (k != tail && (p < matchTo || isText(k))) {
                                removeCount++
                                p += nodeLength(k)
                                k = next[k]
                            }
                            removeCount--
                            strStart = position
                            strLength = p - position
                            from = matchFrom - position
                            matchLength = matchTo - matchFrom
                        } else {
                            val found = match(regex, strStart, strStart + strLength, transparent = false, lookbehind = pattern.lookbehind)
                            if (found == null) {
                                position += nodeLength(currentNode)
                                currentNode = next[currentNode]
                                continue
                            }
                            from = found.first - strStart
                            matchLength = found.last + 1 - found.first
                        }

                        val beforeLength = from
                        val afterStart = strStart + from + matchLength
                        val afterLength = strLength - from - matchLength
                        val reach = position + strLength
                        if (rematch != null && reach > rematch.reach) rematch.reach = reach

                        var removeFrom = previous[currentNode]
                        if (beforeLength > 0) {
                            removeFrom = addAfter(removeFrom, Value.Text(strStart, beforeLength))
                            position += beforeLength
                        }
                        removeRange(removeFrom, removeCount)

                        val matchStart = strStart + from
                        val content = if (pattern.inside >= 0) {
                            Tokenizer(text.substring(matchStart, matchStart + matchLength), base + matchStart).tokenize(pattern.inside)
                        } else {
                            listOf(Node.Text(base + matchStart, matchLength))
                        }
                        currentNode = addAfter(removeFrom, Value.Token(token.name, content, matchLength))
                        if (afterLength > 0) addAfter(currentNode, Value.Text(afterStart, afterLength))

                        if (removeCount > 1) {
                            // At least one token was removed: match this grammar again over what was there.
                            val nested = Rematch(tokenIndex, patternIndex, reach)
                            matchGrammar(grammarIndex, previous[currentNode], position, nested)
                            if (rematch != null && nested.reach > rematch.reach) rematch.reach = nested.reach
                        }

                        position += nodeLength(currentNode)
                        currentNode = next[currentNode]
                    }
                }
            }
        }
    }
}
