import Foundation

// A port of happy-app's components/SimpleSyntaxHighlighter.tsx tokenizer,
// which colours markdown code blocks. Each line is matched against every
// pattern, matches are sorted by start, overlaps are dropped first-come, and
// brackets get their nesting depth across the whole block. Offsets are
// UTF-16, as in JavaScript.
//
// No pattern reaches past its line, so a line's tokens depend only on its
// text, its grammar and the brackets open when it starts: `tokenizeLine`
// takes those and returns the brackets still open after it, and a block is
// its lines chained (`CodeSyntaxService` caches them by exactly that).

public struct SyntaxToken: Equatable, Sendable {
    public enum Kind: String, Equatable, Sendable {
        case comment, docstring, string, regex, number, decorator
        case function, method, property
        case `import`, controlFlow, keyword, type, modifier, boolean
        case comparison, logical, assignment, `operator`
        case bracket, punctuation
        case plain = "default"
    }

    public var text: String
    public var kind: Kind
    /// For brackets: 1 for the outermost pair.
    public var nestLevel: Int?

    public init(_ text: String, _ kind: Kind, nestLevel: Int? = nil) {
        self.text = text
        self.kind = kind
        self.nestLevel = nestLevel
    }

    /// Keywords, control flow, types and functions are drawn semibold.
    public var isBold: Bool {
        kind == .keyword || kind == .controlFlow || kind == .type || kind == .function
    }
}

public enum SyntaxHighlighter {
    /// The pattern sets a fence's language picks. happy-app adds words for
    /// Python, TypeScript and Java and gives every other language the base
    /// sets, so these four are all the grammars there are, and a fence's
    /// own text is never kept to name one.
    public enum Grammar: String, Hashable, Sendable, CaseIterable {
        case base, python, typescript, java

        public init(language: String) {
            switch language.lowercased() {
            case "python", "py": self = .python
            case "typescript", "ts": self = .typescript
            case "java": self = .java
            default: self = .base
            }
        }

        /// Compiled once per grammar, for every block and every thread.
        var patterns: [Pattern] {
            switch self {
            case .base: Compiled.base
            case .python: Compiled.python
            case .typescript: Compiled.typescript
            case .java: Compiled.java
            }
        }
    }

    /// The brackets open where a line starts, innermost last, as UTF-16
    /// units: `(`, `[`, `{` and also `<`, which the nesting counts though it
    /// is never coloured as a bracket.
    public struct BracketStack: Hashable, Sendable {
        public var openers: [UInt16]

        public init(_ openers: [UInt16] = []) {
            self.openers = openers
        }
    }

    /// One line's tokens, and the brackets still open after it.
    public struct Line: Equatable, Sendable {
        public var tokens: [SyntaxToken]
        public var stack: BracketStack

        public init(tokens: [SyntaxToken], stack: BracketStack) {
            self.tokens = tokens
            self.stack = stack
        }
    }

    public static func tokenize(_ code: String, language: String?) -> [SyntaxToken] {
        guard let language else { return [SyntaxToken(code, .plain)] }
        let grammar = Grammar(language: language)
        var tokens: [SyntaxToken] = []
        var stack = BracketStack()
        for (lineIndex, text) in code.jsSplit("\n").enumerated() {
            if lineIndex > 0 {
                tokens.append(SyntaxToken("\n", .plain))
            }
            let line = tokenizeLine(text, grammar: grammar, stack: stack)
            tokens += line.tokens
            stack = line.stack
        }
        return tokens
    }

    /// One line of a block whose earlier lines left `stack` open.
    public static func tokenizeLine(_ line: String, grammar: Grammar, stack: BracketStack) -> Line {
        let (nesting, after) = bracketNesting(line, from: stack)
        let source = line as NSString
        var tokens: [SyntaxToken] = []
        var found: [(start: Int, end: Int, kind: SyntaxToken.Kind, order: Int)] = []
        for pattern in grammar.patterns {
            for match in pattern.regex.matches(in: line) {
                let start: Int
                let length: Int
                if let group = pattern.captureGroup {
                    let text = match.group(group, in: line) ?? ""
                    // The capture's first occurrence in the whole match,
                    // as `match[0].indexOf(tokenText)` finds it.
                    let whole = source.substring(with: match.range) as NSString
                    let offset = whole.range(of: text).location
                    start = match.range.location + (offset == NSNotFound ? 0 : offset)
                    length = (text as NSString).length
                } else {
                    start = match.range.location
                    length = match.range.length
                }
                found.append((start, start + length, pattern.kind, found.count))
            }
        }
        found.sort { $0.start != $1.start ? $0.start < $1.start : $0.order < $1.order }

        var current = 0
        var lastEnd = 0
        for token in found where token.start >= lastEnd {
            lastEnd = token.end
            if token.start > current {
                tokens.append(SyntaxToken(source.substring(with: NSRange(location: current, length: token.start - current)), .plain))
            }
            let text = source.substring(with: NSRange(location: token.start, length: token.end - token.start))
            if token.kind == .bracket {
                tokens.append(SyntaxToken(text, .bracket, nestLevel: nesting[token.start] ?? 1))
            } else {
                tokens.append(SyntaxToken(text, token.kind))
            }
            current = token.end
        }
        if current < source.length {
            tokens.append(SyntaxToken(source.substring(from: current), .plain))
        }
        return Line(tokens: tokens, stack: after)
    }

    struct Pattern {
        var regex: NSRegularExpression
        var kind: SyntaxToken.Kind
        var captureGroup: Int?
    }

    /// The four grammars' patterns, built once.
    enum Compiled {
        nonisolated(unsafe) static let base = patterns(for: .base)
        nonisolated(unsafe) static let python = patterns(for: .python)
        nonisolated(unsafe) static let typescript = patterns(for: .typescript)
        nonisolated(unsafe) static let java = patterns(for: .java)
    }

    static func patterns(for grammar: Grammar) -> [Pattern] {
        let controlFlow = ["if", "else", "elif", "for", "while", "do", "switch", "case", "break", "continue", "return", "yield", "try", "catch", "finally", "throw", "with"]
        var keywords = ["function", "const", "let", "var", "def", "class", "interface", "enum", "struct", "union", "namespace", "module"]
        var types = ["int", "string", "bool", "float", "double", "char", "void", "any", "unknown", "never", "object", "array", "number", "boolean"]
        var modifiers = ["public", "private", "protected", "static", "final", "abstract", "virtual", "override", "async", "await", "export", "default"]
        let boolean = ["true", "false", "null", "undefined", "None", "True", "False", "nil"]
        let imports = ["import", "from", "export", "require", "include", "using", "package"]

        switch grammar {
        case .python:
            keywords += ["def", "lambda", "pass", "global", "nonlocal", "as", "in", "is", "not", "and", "or"]
            types += ["str", "list", "dict", "tuple", "set"]
        case .typescript:
            types += ["Record", "Partial", "Required", "Readonly", "Pick", "Omit"]
            keywords += ["type", "interface", "extends", "implements", "keyof", "typeof"]
        case .java:
            keywords += ["package", "extends", "implements", "super", "this"]
            modifiers += ["synchronized", "transient", "volatile", "native", "strictfp"]
        case .base:
            break
        }

        func words(_ list: [String]) -> NSRegularExpression {
            Patterns.regex("\\b(\(list.joined(separator: "|")))\\b")
        }

        return [
            Pattern(regex: Fixed.blockComment, kind: .comment),
            Pattern(regex: Fixed.lineComment, kind: .comment),
            Pattern(regex: Fixed.hashComment, kind: .comment),
            Pattern(regex: Fixed.docstring, kind: .docstring),
            Pattern(regex: Fixed.string, kind: .string),
            Pattern(regex: Fixed.regex, kind: .regex),
            Pattern(regex: Fixed.number, kind: .number),
            Pattern(regex: Fixed.decorator, kind: .decorator),
            Pattern(regex: Fixed.functionDefinition, kind: .function, captureGroup: 2),
            Pattern(regex: Fixed.functionCall, kind: .function),
            Pattern(regex: Fixed.methodCall, kind: .method, captureGroup: 1),
            Pattern(regex: Fixed.property, kind: .property, captureGroup: 1),
            Pattern(regex: words(imports), kind: .import),
            Pattern(regex: words(controlFlow), kind: .controlFlow),
            Pattern(regex: words(keywords), kind: .keyword),
            Pattern(regex: words(types), kind: .type),
            Pattern(regex: words(modifiers), kind: .modifier),
            Pattern(regex: words(boolean), kind: .boolean),
            Pattern(regex: Fixed.comparison, kind: .comparison),
            Pattern(regex: Fixed.logical, kind: .logical),
            Pattern(regex: Fixed.assignment, kind: .assignment),
            Pattern(regex: Fixed.arithmetic, kind: .operator),
            Pattern(regex: Fixed.ternary, kind: .operator),
            Pattern(regex: Fixed.bracket, kind: .bracket),
            Pattern(regex: Fixed.punctuation, kind: .punctuation),
        ]
    }

    enum Fixed {
        nonisolated(unsafe) static let blockComment = Patterns.regex(#"(/\*[\s\S]*?\*/)"#)
        nonisolated(unsafe) static let lineComment = Patterns.regex(#"(//.*$)"#, options: .anchorsMatchLines)
        nonisolated(unsafe) static let hashComment = Patterns.regex(#"(#.*$)"#, options: .anchorsMatchLines)
        nonisolated(unsafe) static let docstring = Patterns.regex(#"("""[\s\S]*?"""|'''[\s\S]*?''')"#)
        nonisolated(unsafe) static let string = Patterns.regex(#"(r?["'`])((?:(?!\1)[^\\]|\\.)*)(\1)"#)
        nonisolated(unsafe) static let regex = Patterns.regex(#"(/(?:[^/\\\n]|\\.)+/[gimuy]*)"#)
        nonisolated(unsafe) static let number = Patterns.regex(#"\b(0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b"#)
        nonisolated(unsafe) static let decorator = Patterns.regex(#"@\w+"#)
        nonisolated(unsafe) static let functionDefinition = Patterns.regex(#"\b(function|def|async function)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)"#)
        nonisolated(unsafe) static let functionCall = Patterns.regex(#"\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()"#)
        nonisolated(unsafe) static let methodCall = Patterns.regex(#"\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()"#)
        nonisolated(unsafe) static let property = Patterns.regex(#"\.([a-zA-Z_$][a-zA-Z0-9_$]*)"#)
        nonisolated(unsafe) static let comparison = Patterns.regex(#"(===|!==|==|!=|<=|>=|<|>)"#)
        nonisolated(unsafe) static let logical = Patterns.regex(#"(&&|\|\||!)"#)
        nonisolated(unsafe) static let assignment = Patterns.regex(#"(=|\+=|\-=|\*=|/=|%=|\|=|&=|\^=)"#)
        nonisolated(unsafe) static let arithmetic = Patterns.regex(#"(\+|\-|\*|/|%|\*\*)"#)
        nonisolated(unsafe) static let ternary = Patterns.regex(#"(\?|:)"#)
        nonisolated(unsafe) static let bracket = Patterns.regex(#"([()\[\]{}])"#)
        nonisolated(unsafe) static let punctuation = Patterns.regex(#"([.,;])"#)
    }

    /// Depth of each matched bracket in `line`, by UTF-16 offset, given the
    /// brackets open before it, and the ones open after. A closer pops
    /// whatever is innermost, and has a depth only if it matches.
    static func bracketNesting(_ line: String, from start: BracketStack) -> (levels: [Int: Int], stack: BracketStack) {
        let pairs: [UInt16: UInt16] = [40: 41, 91: 93, 123: 125, 60: 62]
        let closers = Set(pairs.values)
        var map: [Int: Int] = [:]
        var stack = start.openers
        for (index, unit) in line.utf16.enumerated() {
            if pairs[unit] != nil {
                stack.append(unit)
                map[index] = stack.count
            } else if closers.contains(unit), let open = stack.popLast() {
                if pairs[open] == unit {
                    map[index] = stack.count + 1
                }
            }
        }
        return (map, BracketStack(stack))
    }
}
