import Foundation

/// prism-core's `Prism.tokenize`, over the grammars
/// scripts/generate-prism-grammars.cjs writes out with their patterns
/// rewritten for ICU. Offsets are UTF-16, as in JavaScript.
public enum Prism {
    /// What `Prism.tokenize` returns: plain text, or a named token over
    /// its content. Ranges are into the text that was tokenized.
    public indirect enum Node: Equatable, Sendable {
        case text(location: Int, length: Int)
        case token(String, [Node])
    }

    /// Whether a grammar exists for a language id.
    public static func hasGrammar(_ language: String?) -> Bool {
        guard let language else { return false }
        return PrismGrammarTable.languages[language] != nil
    }

    /// The text's tokens in `language`'s grammar; nil without one. Throws
    /// only if a pattern fails to compile, which the tests rule out.
    public static func tokenize(_ text: String, language: String) throws -> [Node]? {
        guard let index = PrismGrammarTable.languages[language] else { return nil }
        let source = text as NSString
        return try Tokenizer(text: source, base: 0).tokenize(grammar: index)
    }

    // MARK: Grammars

    struct Pattern {
        var source: Int
        var ignoreCase: Bool
        var lookbehind: Bool
        var greedy: Bool
        /// A grammar index, or -1.
        var inside: Int
    }

    struct Token {
        var name: String
        var patterns: [Pattern]
    }

    /// The parsed table: grammars, and pattern sources with their macros
    /// expanded. Patterns compile on first use.
    final class Table: @unchecked Sendable {
        let grammars: [[Token]]
        let sources: [String]
        private let lock = NSLock()
        private var compiled: [Int: NSRegularExpression] = [:]

        init() {
            // A multi-line literal drops its last newline: one line each.
            sources = PrismGrammarTable.patterns.split(separator: "\n", omittingEmptySubsequences: false).map { line in
                var source = String(line)
                for (name, value) in PrismGrammarTable.macros {
                    source = source.replacingOccurrences(of: name, with: value)
                }
                return source
            }
            var grammars: [[Token]] = []
            for line in PrismGrammarTable.grammars.split(separator: "\n") {
                switch line.first {
                case "@":
                    grammars.append([])
                case "=":
                    grammars[grammars.count - 1].append(Token(name: String(line.dropFirst()), patterns: []))
                case "~":
                    let fields = line.dropFirst().split(separator: " ")
                    let flags = Array(fields[0])
                    let pattern = Pattern(
                        source: Int(fields[2])!,
                        ignoreCase: flags[0] == "i",
                        lookbehind: flags[1] == "l",
                        greedy: flags[2] == "g",
                        inside: Int(fields[1])!
                    )
                    let last = grammars.count - 1
                    grammars[last][grammars[last].count - 1].patterns.append(pattern)
                default:
                    break
                }
            }
            self.grammars = grammars
        }

        func regex(_ pattern: Pattern) throws -> NSRegularExpression {
            let key = pattern.source * 2 + (pattern.ignoreCase ? 1 : 0)
            lock.lock()
            defer { lock.unlock() }
            if let regex = compiled[key] { return regex }
            let regex = try NSRegularExpression(pattern: sources[pattern.source], options: pattern.ignoreCase ? [.caseInsensitive] : [])
            compiled[key] = regex
            return regex
        }
    }

    static let table = Table()

    // MARK: Tokenizing

    /// Prism's LinkedList, matchGrammar and matchPattern over one text.
    /// Nodes live in arrays; index 0 is the head and 1 the tail.
    private final class Tokenizer {
        private enum Value {
            /// Text from `location` in this tokenizer's text.
            case text(Int, Int)
            case token(name: String, content: [Node], length: Int)

            var length: Int {
                switch self {
                case .text(_, let length): length
                case .token(_, _, let length): length
                }
            }
        }

        /// matchGrammar's `rematch`: which pattern caused the re-match, and
        /// how far it has to look.
        private final class Rematch {
            let token: Int
            let pattern: Int
            var reach: Int

            init(token: Int, pattern: Int, reach: Int) {
                self.token = token
                self.pattern = pattern
                self.reach = reach
            }
        }

        private let text: NSString
        /// The same text as a String bridged from it, which is what
        /// NSRegularExpression takes; on Apple platforms it hands the
        /// NSString straight back.
        private let string: String
        private let length: Int
        /// Where this text starts in the text first tokenized.
        private let base: Int
        private var values: [Value?] = [nil, nil]
        private var next: [Int] = [1, -1]
        private var previous: [Int] = [-1, 0]
        private var count = 0
        private struct NodeKey: Hashable {
            let location: Int
            let length: Int
        }
        private var nodeTexts: [NodeKey: String] = [:]
        private let head = 0
        private let tail = 1

        init(text: NSString, base: Int) {
            self.text = text
            string = text as String
            length = text.length
            self.base = base
        }

        func tokenize(grammar: Int) throws -> [Node] {
            _ = addAfter(head, .text(0, length))
            try matchGrammar(grammar, startNode: head, startPosition: 0, rematch: nil)
            var nodes: [Node] = []
            var node = next[head]
            while node != tail {
                switch values[node]! {
                case .text(let location, let length): nodes.append(.text(location: base + location, length: length))
                case .token(let name, let content, _): nodes.append(.token(name, content))
                }
                node = next[node]
            }
            return nodes
        }

        private func addAfter(_ node: Int, _ value: Value) -> Int {
            let after = next[node]
            let index = values.count
            values.append(value)
            next.append(after)
            previous.append(node)
            next[node] = index
            previous[after] = index
            count += 1
            return index
        }

        private func removeRange(_ node: Int, _ removeCount: Int) {
            var after = next[node]
            var removed = 0
            while removed < removeCount, after != tail {
                after = next[after]
                removed += 1
            }
            next[node] = after
            previous[after] = node
            count -= removed
        }

        private func nodeLength(_ node: Int) -> Int {
            values[node]?.length ?? 0
        }

        private func isText(_ node: Int) -> Bool {
            if case .text? = values[node] { return true }
            return false
        }

        /// matchPattern: the first match from `range`, less its lookbehind
        /// group. Greedy patterns search the rest of the whole text and
        /// may look behind their start, as `exec` from `lastIndex` does;
        /// the others search one text node alone, as `exec` on its `value`
        /// does. That search runs on the node's own text, not on a range of
        /// the whole: the generated `^`, `$` and `\b` are lookarounds, and
        /// Darwin's NSRegularExpression lets a lookbehind see before the
        /// range even without transparent bounds (Linux's doesn't), so `^`
        /// never matched at a node that doesn't start the text.
        private func match(_ regex: NSRegularExpression, in range: NSRange, transparent: Bool, lookbehind: Bool) -> NSRange? {
            let result: NSTextCheckingResult
            let offset: Int
            if transparent {
                guard let found = regex.firstMatch(in: string, options: [.withTransparentBounds, .withoutAnchoringBounds], range: range) else { return nil }
                result = found
                offset = 0
            } else {
                let node = nodeText(range)
                guard let found = regex.firstMatch(in: node, options: [], range: NSRange(location: 0, length: range.length)) else { return nil }
                result = found
                offset = range.location
            }
            var matched = result.range
            matched.location += offset
            if lookbehind, result.numberOfRanges > 1 {
                let group = result.range(at: 1)
                if group.location != NSNotFound, group.length > 0 {
                    matched.location += group.length
                    matched.length -= group.length
                }
            }
            return matched
        }

        /// A text node's own text, made once for all the patterns tried on it.
        private func nodeText(_ range: NSRange) -> String {
            if range.location == 0, range.length == length { return string }
            let key = NodeKey(location: range.location, length: range.length)
            if let cached = nodeTexts[key] { return cached }
            let node = text.substring(with: range)
            nodeTexts[key] = node
            return node
        }

        private func matchGrammar(_ grammarIndex: Int, startNode: Int, startPosition: Int, rematch: Rematch?) throws {
            let grammar = Prism.table.grammars[grammarIndex]
            for (tokenIndex, token) in grammar.enumerated() {
                for (patternIndex, pattern) in token.patterns.enumerated() {
                    if let rematch, rematch.token == tokenIndex, rematch.pattern == patternIndex { return }
                    let regex = try Prism.table.regex(pattern)

                    var currentNode = next[startNode]
                    var position = startPosition
                    while currentNode != tail {
                        defer {
                            position += nodeLength(currentNode)
                            currentNode = next[currentNode]
                        }
                        if let rematch, position >= rematch.reach { break }
                        // "Something went terribly wrong."
                        if count > length { return }
                        guard case .text(var strStart, var strLength)? = values[currentNode] else { continue }

                        var removeCount = 1
                        let from: Int
                        let matchLength: Int
                        if pattern.greedy {
                            guard let found = match(regex, in: NSRange(location: position, length: length - position), transparent: true, lookbehind: pattern.lookbehind),
                                  found.location < length else { break }
                            let matchFrom = found.location
                            let matchTo = found.location + found.length
                            var p = position + nodeLength(currentNode)
                            while matchFrom >= p {
                                currentNode = next[currentNode]
                                p += nodeLength(currentNode)
                            }
                            p -= nodeLength(currentNode)
                            position = p
                            if !isText(currentNode) { continue }
                            var k = currentNode
                            while k != tail, p < matchTo || isText(k) {
                                removeCount += 1
                                p += nodeLength(k)
                                k = next[k]
                            }
                            removeCount -= 1
                            strStart = position
                            strLength = p - position
                            from = matchFrom - position
                            matchLength = found.length
                        } else {
                            guard let found = match(regex, in: NSRange(location: strStart, length: strLength), transparent: false, lookbehind: pattern.lookbehind) else { continue }
                            from = found.location - strStart
                            matchLength = found.length
                        }

                        let beforeLength = from
                        let afterStart = strStart + from + matchLength
                        let afterLength = strLength - from - matchLength
                        let reach = position + strLength
                        if let rematch, reach > rematch.reach { rematch.reach = reach }

                        var removeFrom = previous[currentNode]
                        if beforeLength > 0 {
                            removeFrom = addAfter(removeFrom, .text(strStart, beforeLength))
                            position += beforeLength
                        }
                        removeRange(removeFrom, removeCount)

                        let matchStart = strStart + from
                        let content: [Node]
                        if pattern.inside >= 0 {
                            let inner = text.substring(with: NSRange(location: matchStart, length: matchLength)) as NSString
                            content = try Tokenizer(text: inner, base: base + matchStart).tokenize(grammar: pattern.inside)
                        } else {
                            content = [.text(location: base + matchStart, length: matchLength)]
                        }
                        currentNode = addAfter(removeFrom, .token(name: token.name, content: content, length: matchLength))
                        if afterLength > 0 { _ = addAfter(currentNode, .text(afterStart, afterLength)) }

                        if removeCount > 1 {
                            // At least one Token was removed: match this
                            // grammar again over what was there.
                            let nested = Rematch(token: tokenIndex, pattern: patternIndex, reach: reach)
                            try matchGrammar(grammarIndex, startNode: previous[currentNode], startPosition: position, rematch: nested)
                            if let rematch, nested.reach > rematch.reach { rematch.reach = nested.reach }
                        }
                    }
                }
            }
        }
    }
}
