import Foundation

/// What Siri says to "What are my agents doing?": home's conversations, as
/// the sidebar lists them (`CallTarget.list`), in three groups and a few
/// words: which need the person, which are working, which finished
/// recently. Names only, cleaned for speech (`spoken`): never code, paths
/// or IDs, as the voice prompt asks.
public enum AgentsSummary {
    /// How many names a group says before "and N more".
    static let named = 3
    /// A conversation idle since this long ago, or one with a reply the
    /// person hasn't read since `unreadWindow`, finished recently.
    static let recentWindow: Double = 60 * 60 * 1000
    static let unreadWindow: Double = 24 * 60 * 60 * 1000

    /// `rows` are home's; `now` and the rows' times are ms since 1970.
    /// `live` is false while Happy can't reach the computer: the answer
    /// says it is what the phone last saw.
    public static func text(rows: [Row], now: Double, live: Bool = true) -> String {
        let unread = Set(rows.filter(\.unread).compactMap(\.agentId))
        let targets = CallTarget.list(rows)
        let needs = targets.filter { $0.status == .needsInput }
        let working = targets.filter { $0.status == .running }
        let finished = targets
            .filter { target in
                guard target.status == .idle, let at = target.activityAt else { return false }
                let age = now - at
                return age <= recentWindow || (unread.contains(target.agentId) && age <= unreadWindow)
            }
            .sorted { ($0.activityAt ?? 0) > ($1.activityAt ?? 0) }
        var sentences: [String] = []
        if let line = group(needs, one: "needs you", many: "need you") { sentences.append(line) }
        if let line = group(working, one: "is working", many: "are working") { sentences.append(line) }
        if let line = group(finished, one: "finished recently", many: "finished recently") { sentences.append(line) }
        if sentences.isEmpty {
            sentences.append(targets.isEmpty ? "You have no agents yet." : "Nothing is working, and nothing needs you.")
        }
        if !live { sentences.insert("Happy can't reach your computer, so this is from when it last could.", at: 0) }
        return sentences.joined(separator: " ")
    }

    /// One group as a sentence: "Docs review needs you.", "Release notes
    /// and Cache fix are working.", "5 are working: A, B, C and 2 more."
    static func group(_ targets: [CallTarget], one: String, many: String) -> String? {
        guard !targets.isEmpty else { return nil }
        let names = targets.map(name)
        let lead = { (text: String) in text.prefix(1).uppercased() + text.dropFirst() }
        if names.count == 1 { return lead("\(names[0]) \(one).") }
        if names.count <= named { return lead("\(list(names)) \(many).") }
        let shown = Array(names.prefix(named)) + ["\(names.count - named) more"]
        return "\(names.count) \(many): \(list(shown))."
    }

    /// "A", "A and B", "A, B and C".
    static func list(_ names: [String]) -> String {
        guard names.count > 1 else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
    }

    /// A conversation as it is said: its title for speech, or, for work
    /// nobody named yet, "a new task" or "a new bot", with what it is
    /// under when that says more.
    public static func name(_ target: CallTarget) -> String {
        let title = spoken(target.title)
        guard CallTarget.placeholders.contains(target.title) || title.isEmpty else { return title }
        let kind = target.kind == .bot ? "a new bot" : target.kind == .subtask ? "a new subtask" : "a new task"
        guard let parent = target.parents.last(where: { !CallTarget.placeholders.contains($0.title) }) else { return kind }
        let under = spoken(parent.title)
        return under.isEmpty ? kind : "\(kind) under \(under)"
    }

    /// A title as it can be said: markdown marks gone, a path said as its
    /// last part, and anything that reads as an ID or a hash left out.
    public static func spoken(_ title: String) -> String {
        let plain = title.unicodeScalars.filter { !"`*_#<>[]{}|\\".unicodeScalars.contains($0) }
        let words = String(String.UnicodeScalarView(plain)).split(whereSeparator: \.isWhitespace).compactMap { word -> String? in
            var word = String(word)
            if word.contains("/") {
                let parts = word.split(separator: "/").filter { !$0.isEmpty }
                guard let last = parts.last else { return nil }
                word = String(last)
            }
            if word.allSatisfy({ $0.isPunctuation || $0.isSymbol }) { return nil }
            return looksLikeID(word) ? nil : word
        }
        return words.joined(separator: " ")
    }

    /// Seven or more hex digits with a digit among them (a commit, a UUID's
    /// part), or a long run of letters and digits mixed with no vowel
    /// pattern a word has: said as nothing.
    static func looksLikeID(_ word: String) -> Bool {
        let core = word.trimmingCharacters(in: .punctuationCharacters)
        guard core.count >= 7 else { return false }
        let hex = core.allSatisfy { $0.isHexDigit || $0 == "-" }
        if hex, core.contains(where: \.isNumber) { return true }
        let digits = core.filter(\.isNumber).count
        return core.count >= 12 && digits >= 3 && core.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }
}

/// Which of home's conversations Siri means by a name the person said:
/// the best matches first. A title said whole wins, then one it starts,
/// then one holding every word said, each as a word's start; case,
/// accents and punctuation never matter.
public enum AgentNameMatch {
    public static func matches(_ said: String, in targets: [CallTarget]) -> [CallTarget] {
        let words = Self.words(said)
        guard !words.isEmpty else { return [] }
        let scored = targets.enumerated().compactMap { index, target -> (Int, Int, CallTarget)? in
            let title = Self.words(AgentsSummary.name(target))
            let score: Int
            if title == words { score = 3 }
            else if title.starts(with: words) { score = 2 }
            else if words.allSatisfy({ word in title.contains { $0.hasPrefix(word) } }) { score = 1 }
            else { return nil }
            return (score, index, target)
        }
        return scored.sorted { $0.0 != $1.0 ? $0.0 > $1.0 : $0.1 < $1.1 }.map(\.2)
    }

    /// Lowercased, without accents, split on anything not a letter or digit.
    static func words(_ text: String) -> [String] {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .lowercased()
            .split { !($0.isLetter || $0.isNumber) }
            .map(String.init)
    }
}

/// "Read me ‹agent›'s last reply": the agent's last finished answer, made
/// fit to hear. Code blocks and inline code are left out, a path is said
/// as its last part, and it stops after a few sentences.
public enum SpokenReply {
    static let sentences = 4
    static let limit = 600

    /// The newest finished answer in `state`, said; nil when it has none yet.
    public static func last(in state: CallTargetState) -> String? {
        let reply = state.turns.last(where: { !($0.reply ?? "").isEmpty })?.reply
            ?? state.messages.last(where: { $0.role == .assistant && $0.final && !$0.text.isEmpty })?.text
        guard let reply else { return nil }
        let said = text(reply)
        return said.isEmpty ? nil : said
    }

    public static func text(_ markdown: String) -> String {
        var lines: [String] = []
        var fenced = false
        for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") { fenced.toggle(); continue }
            if fenced { continue }
            // Inline code goes whole: what it names isn't for reading out.
            let parts = line.split(separator: "`", omittingEmptySubsequences: false)
            let prose = parts.enumerated().filter { $0.offset % 2 == 0 }.map(\.element).joined(separator: " ")
            var said = AgentsSummary.spoken(prose)
            guard !said.isEmpty else { continue }
            // A line is a pause: one that ends unfinished, or on what was left out, ends there.
            if let last = said.last, !".!?".contains(last) { said = said.trimmingCharacters(in: CharacterSet(charactersIn: ":;,")) + "." }
            lines.append(said)
        }
        // A sentence ends at a stop followed by a space or the end, never
        // inside a name or a number ("Store.swift", "2.4").
        var result = ""
        var count = 0
        let said = Array(lines.joined(separator: " "))
        for (index, character) in said.enumerated() {
            result.append(character)
            if ".!?".contains(character), index + 1 == said.count || said[index + 1] == " " {
                count += 1
                if count >= sentences { break }
            }
        }
        if result.count > limit {
            let cut = result.prefix(limit)
            result = (cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? String(cut)) + "…"
        }
        return result.trimmingCharacters(in: .whitespaces)
    }
}
