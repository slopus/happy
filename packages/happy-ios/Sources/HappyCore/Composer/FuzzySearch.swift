import Foundation

/// Fuse.js 7.1 as the composer's suggestion lists configure it: extended
/// search, `ignoreLocation`, case-insensitive, the field-length norm on,
/// sorted by score then by position, `limit` applied last.
///
/// Every plain token is Fuse's Bitap fuzzy match. With the location
/// ignored, Bitap's score is the fewest edits that turn the token into
/// some stretch of the text, over the token's length (0.001 at best); it
/// matches while that stays within `threshold`, and a text equal to the
/// token scores 0. Tokens longer than 32 are searched in 32-unit chunks and
/// their scores averaged. The extended operators (`=exact`, `'include`,
/// `^prefix`, `suffix$`, `!not`, `!^`, `!…$`, quotes, `|` for or) score 0
/// or miss. An item's score is the product over its matching keys of
/// score^(weight × norm), the weights summing to one and the norm being
/// 1/√(words in the value) to three places.
public struct FuzzySearch<Item> {
    public struct Key {
        public var weight: Double
        public var value: (Item) -> String?

        public init(weight: Double, value: @escaping (Item) -> String?) {
            self.weight = weight
            self.value = value
        }
    }

    private struct Field: Sendable {
        var key: Int
        /// Lowercased, in UTF-16 units as JavaScript compares them.
        var text: [UInt16]
        var norm: Double
    }

    private let items: [Item]
    private let fields: [[Field]]
    private let weights: [Double]
    public let threshold: Double

    public init(_ items: [Item], keys: [Key], threshold: Double = 0.3) {
        self.items = items
        self.threshold = threshold
        let total = keys.reduce(0) { $0 + $1.weight }
        weights = keys.map { total > 0 ? $0.weight / total : 0 }
        fields = items.map { item in
            keys.enumerated().compactMap { index, key in
                // Fuse indexes neither undefined nor blank values.
                guard let value = key.value(item),
                      !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                return Field(key: index, text: Array(value.lowercased().utf16), norm: Self.norm(value))
            }
        }
    }

    public var isEmpty: Bool { items.isEmpty }

    public func search(_ query: String, limit: Int = -1) -> [Item] {
        let groups = ExtendedQuery.parse(query.lowercased())
        var results: [(index: Int, score: Double)] = []
        for (index, fields) in fields.enumerated() {
            var score = 1.0
            var matched = false
            for field in fields {
                guard let fieldScore = ExtendedQuery.score(groups, field.text, threshold: threshold) else { continue }
                matched = true
                let weight = weights[field.key]
                let base = fieldScore == 0 && weight != 0 ? Double.ulpOfOne : fieldScore
                score *= pow(base, (weight == 0 ? 1 : weight) * field.norm)
            }
            if matched {
                results.append((index, score))
            }
        }
        results.sort { $0.score == $1.score ? $0.index < $1.index : $0.score < $1.score }
        if limit > -1, results.count > limit {
            results.removeSubrange(limit...)
        }
        return results.map { items[$0.index] }
    }

    /// `norm.get`: 1/√(runs of non-spaces), rounded to three places.
    static func norm(_ value: String) -> Double {
        var tokens = 0
        var inToken = false
        for unit in value.utf16 {
            if unit == 0x20 {
                inToken = false
            } else if !inToken {
                inToken = true
                tokens += 1
            }
        }
        let norm = 1 / pow(Double(max(1, tokens)), 0.5)
        return (norm * 1000).rounded() / 1000
    }
}

/// Fuse's ExtendedSearch: `|`-separated groups of space-separated tokens.
enum ExtendedQuery {
    enum Matcher: Equatable {
        case exact([UInt16])
        case include([UInt16])
        case prefix([UInt16])
        case inversePrefix([UInt16])
        case inverseSuffix([UInt16])
        case suffix([UInt16])
        case inverseExact([UInt16])
        case fuzzy([UInt16])
    }

    /// `parseQuery`, on an already lowercased pattern.
    static func parse(_ pattern: String) -> [[Matcher]] {
        pattern.components(separatedBy: "|").map { group in
            tokens(group.trimmingCharacters(in: .whitespacesAndNewlines)).compactMap(matcher)
        }
    }

    /// `split(SPACE_RE)`: at runs of spaces with an even number of quotes
    /// after them; blanks dropped.
    static func tokens(_ text: String) -> [String] {
        let units = Array(text.utf16)
        var tokens: [String] = []
        var start = 0
        var index = 0
        while index < units.count {
            guard units[index] == 0x20 else {
                index += 1
                continue
            }
            var end = index
            while end < units.count, units[end] == 0x20 { end += 1 }
            let quotes = units[end...].filter { $0 == 0x22 }.count
            // The regex can also split inside the run, at a later space
            // whose remainder balances; the run's spaces share one
            // remainder, so it splits at the first or not at all.
            if quotes % 2 == 0 {
                tokens.append(String(decoding: units[start..<index], as: UTF16.self))
                start = end
            }
            index = end
        }
        tokens.append(String(decoding: units[start...], as: UTF16.self))
        return tokens.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    /// The first searcher whose quoted form, then whose plain form, takes
    /// the token with something left (an empty capture doesn't count).
    static func matcher(_ token: String) -> Matcher? {
        let kinds: [(quoted: String, plain: String, make: ([UInt16]) -> Matcher)] = [
            (#"^="(.*)"$"#, #"^=(.*)$"#, Matcher.exact),
            (#"^'"(.*)"$"#, #"^'(.*)$"#, Matcher.include),
            (#"^\^"(.*)"$"#, #"^\^(.*)$"#, Matcher.prefix),
            (#"^!\^"(.*)"$"#, #"^!\^(.*)$"#, Matcher.inversePrefix),
            (#"^!"(.*)"\$$"#, #"^!(.*)\$$"#, Matcher.inverseSuffix),
            (#"^"(.*)"\$$"#, #"^(.*)\$$"#, Matcher.suffix),
            (#"^!"(.*)"$"#, #"^!(.*)$"#, Matcher.inverseExact),
            (#"^"(.*)"$"#, #"^(.*)$"#, Matcher.fuzzy),
        ]
        for pass in 0..<2 {
            for kind in kinds {
                if let captured = capture(pass == 0 ? kind.quoted : kind.plain, in: token), !captured.isEmpty {
                    return kind.make(Array(captured.utf16))
                }
            }
        }
        return nil
    }

    private static func capture(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []),
              let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }

    /// `searchIn`: the first group whose every token matches, scored by
    /// their average; nil when none does.
    static func score(_ groups: [[Matcher]], _ text: [UInt16], threshold: Double) -> Double? {
        for group in groups where !group.isEmpty {
            var total = 0.0
            var matched = true
            for matcher in group {
                guard let score = score(matcher, text, threshold: threshold) else {
                    matched = false
                    break
                }
                total += score
            }
            if matched {
                return total / Double(group.count)
            }
        }
        return nil
    }

    static func score(_ matcher: Matcher, _ text: [UInt16], threshold: Double) -> Double? {
        switch matcher {
        case .exact(let pattern): return text == pattern ? 0 : nil
        case .include(let pattern): return contains(text, pattern) ? 0 : nil
        case .prefix(let pattern): return text.starts(with: pattern) ? 0 : nil
        case .inversePrefix(let pattern): return text.starts(with: pattern) ? nil : 0
        case .inverseSuffix(let pattern): return text.reversed().starts(with: pattern.reversed()) ? nil : 0
        case .suffix(let pattern): return text.reversed().starts(with: pattern.reversed()) ? 0 : nil
        case .inverseExact(let pattern): return contains(text, pattern) ? nil : 0
        case .fuzzy(let pattern): return Bitap.score(pattern, in: text, threshold: threshold)
        }
    }

    private static func contains(_ text: [UInt16], _ pattern: [UInt16]) -> Bool {
        guard !pattern.isEmpty else { return true }
        guard pattern.count <= text.count else { return false }
        for start in 0...(text.count - pattern.count) where text[start..<(start + pattern.count)].elementsEqual(pattern) {
            return true
        }
        return false
    }
}

/// Fuse's BitapSearch with the location ignored.
enum Bitap {
    static let maxBits = 32

    static func score(_ pattern: [UInt16], in text: [UInt16], threshold: Double) -> Double? {
        if pattern == text {
            return 0
        }
        guard !pattern.isEmpty else { return nil }
        var chunks: [ArraySlice<UInt16>] = []
        if pattern.count > maxBits {
            let remainder = pattern.count % maxBits
            var start = 0
            while start < pattern.count - remainder {
                chunks.append(pattern[start..<(start + maxBits)])
                start += maxBits
            }
            if remainder > 0 {
                chunks.append(pattern[(pattern.count - maxBits)...])
            }
        } else {
            chunks = [pattern[...]]
        }
        var total = 0.0
        var matched = false
        for chunk in chunks {
            if let score = chunkScore(Array(chunk), text, threshold: threshold) {
                matched = true
                total += score
            } else {
                total += 1
            }
        }
        return matched ? total / Double(chunks.count) : nil
    }

    /// The fewest edits from `pattern` to any stretch of `text`, tried one
    /// more error at a time while errors/length stays within `threshold`.
    static func chunkScore(_ pattern: [UInt16], _ text: [UInt16], threshold: Double) -> Double? {
        let length = pattern.count
        var maxErrors = 0
        while maxErrors + 1 < length, Double(maxErrors + 1) / Double(length) <= threshold {
            maxErrors += 1
        }
        guard let errors = fewestEdits(pattern, text, limit: maxErrors) else { return nil }
        return max(0.001, Double(errors) / Double(length))
    }

    /// Sellers' approximate substring distance, or nil past `limit`.
    static func fewestEdits(_ pattern: [UInt16], _ text: [UInt16], limit: Int) -> Int? {
        let m = pattern.count
        // column[i]: edits matching pattern[0..<i] to a stretch ending here.
        var column = Array(0...m)
        var best = column[m]
        for unit in text {
            var diagonal = column[0]
            column[0] = 0
            for i in 1...m {
                let above = column[i]
                let substitution = diagonal + (pattern[i - 1] == unit ? 0 : 1)
                column[i] = min(substitution, above + 1, column[i - 1] + 1)
                diagonal = above
            }
            best = min(best, column[m])
            if best == 0 { break }
        }
        return best <= limit ? best : nil
    }
}

extension FuzzySearch: Sendable where Item: Sendable {}
