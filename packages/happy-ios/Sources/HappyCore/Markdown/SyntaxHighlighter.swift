import Foundation

// A port of happy-app's components/SimpleSyntaxHighlighter.tsx tokenizer,
// which colours markdown code blocks. Each line is matched against every
// pattern, matches are sorted by start, overlaps are dropped first-come, and
// brackets get their nesting depth across the whole block. Offsets are
// UTF-16, as in JavaScript.

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
    public static func tokenize(_ code: String, language: String?) -> [SyntaxToken] {
        guard let language else { return [SyntaxToken(code, .plain)] }
        let patterns = Self.patterns(for: language.lowercased())
        let nesting = bracketNesting(code)
        var tokens: [SyntaxToken] = []
        var globalOffset = 0

        for (lineIndex, line) in code.jsSplit("\n").enumerated() {
            if lineIndex > 0 {
                tokens.append(SyntaxToken("\n", .plain))
                globalOffset += 1
            }
            let source = line as NSString
            var found: [(start: Int, end: Int, kind: SyntaxToken.Kind, order: Int)] = []
            for pattern in patterns {
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
                    tokens.append(SyntaxToken(text, .bracket, nestLevel: nesting[globalOffset + token.start] ?? 1))
                } else {
                    tokens.append(SyntaxToken(text, token.kind))
                }
                current = token.end
            }
            if current < source.length {
                tokens.append(SyntaxToken(source.substring(from: current), .plain))
            }
            globalOffset += source.length
        }
        return tokens
    }

    struct Pattern {
        var regex: NSRegularExpression
        var kind: SyntaxToken.Kind
        var captureGroup: Int?
    }

    static func patterns(for lang: String) -> [Pattern] {
        let controlFlow = ["if", "else", "elif", "for", "while", "do", "switch", "case", "break", "continue", "return", "yield", "try", "catch", "finally", "throw", "with"]
        var keywords = ["function", "const", "let", "var", "def", "class", "interface", "enum", "struct", "union", "namespace", "module"]
        var types = ["int", "string", "bool", "float", "double", "char", "void", "any", "unknown", "never", "object", "array", "number", "boolean"]
        var modifiers = ["public", "private", "protected", "static", "final", "abstract", "virtual", "override", "async", "await", "export", "default"]
        let boolean = ["true", "false", "null", "undefined", "None", "True", "False", "nil"]
        let imports = ["import", "from", "export", "require", "include", "using", "package"]

        if lang == "python" || lang == "py" {
            keywords += ["def", "lambda", "pass", "global", "nonlocal", "as", "in", "is", "not", "and", "or"]
            types += ["str", "list", "dict", "tuple", "set"]
        } else if lang == "typescript" || lang == "ts" {
            types += ["Record", "Partial", "Required", "Readonly", "Pick", "Omit"]
            keywords += ["type", "interface", "extends", "implements", "keyof", "typeof"]
        } else if lang == "java" {
            keywords += ["package", "extends", "implements", "super", "this"]
            modifiers += ["synchronized", "transient", "volatile", "native", "strictfp"]
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

    /// Depth of each matched bracket, by UTF-16 offset in the whole block.
    /// `<` and `>` count as brackets here but are never tokenized as one.
    static func bracketNesting(_ code: String) -> [Int: Int] {
        let pairs: [UInt16: UInt16] = [40: 41, 91: 93, 123: 125, 60: 62]
        let closers = Set(pairs.values)
        var map: [Int: Int] = [:]
        var stack: [UInt16] = []
        for (index, unit) in code.utf16.enumerated() {
            if pairs[unit] != nil {
                stack.append(unit)
                map[index] = stack.count
            } else if closers.contains(unit), let open = stack.popLast() {
                if pairs[open] == unit {
                    map[index] = stack.count + 1
                }
            }
        }
        return map
    }
}
