import Foundation
import HappyWire

/// The people an `@` in the agent composer offers (desktop's
/// `happyAgentMentionPlaces`, its people): the reader's teammates, from
/// the bootstrap's `teammates`, whose names hold what follows the `@`, in
/// the team's name order, five at most. A pick writes the person as the
/// Happy link that names them, `[Name](happy://users/<id>)`, which a
/// message reads as "@" and their live name and Happy Agent reads as a
/// mention that loops them into a task. Outside a team there is no one.
///
/// The composer shows a mention as desktop's does, "@" and the name, and
/// the draft is saved and sent as the Markdown (desktop's
/// `composerDraftParse` and `composerDraftMarkdown`, for people's links
/// only). What the composer shows is plain text, so a mention is known by
/// its words: two teammates of one name are the one picked last.
public enum Mentions {
    public static let prefixes: [Character] = ["@"]
    public static let limit = 5

    /// The `@` word at the caret, read in place from the text view's storage.
    public static func word(units: NSString, selection: NSRange) -> ActiveWord? {
        ComposerAutocomplete.findActiveWord(units: units, selection: selection, prefixes: prefixes)
    }

    /// The teammates for `activeWord` ("@ste"): every one whose name holds
    /// what follows the `@`, ignoring case and accents, the reader left out.
    public static func people(_ activeWord: String, in teammates: [TeamUser], me: String?) -> [TeamUser] {
        let needle = activeWord.hasPrefix("@") ? String(activeWord.dropFirst()) : activeWord
        let trimmed = needle.trimmingCharacters(in: .whitespaces)
        let ordered = teammates.sorted {
            let order = $0.name.localizedStandardCompare($1.name)
            return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
        }
        var found: [TeamUser] = []
        for teammate in ordered where teammate.id != me && link(teammate) != nil {
            guard trimmed.isEmpty || teammate.name.range(of: trimmed, options: [.caseInsensitive, .diacriticInsensitive]) != nil else { continue }
            found.append(teammate)
            if found.count == limit { break }
        }
        return found
    }

    /// What a pick writes: the person's Happy link under their name. Nil
    /// for an ID no link can hold, or a name that reads as nothing.
    public static func link(_ teammate: TeamUser) -> String? {
        let name = HappyReferences.label(teammate.name)
        guard !name.isEmpty, let url = HappyLink(.reference(.init(kind: .user, id: teammate.id))).url else { return nil }
        return "[\(name)](\(url))"
    }

    /// What the composer shows for the person a pick names: "@" and their
    /// name, and the link it stands for.
    public static func shown(_ suggestion: ComposerSuggestion) -> (text: String, link: String) {
        guard case .person(let teammate) = suggestion.kind else { return (suggestion.text, suggestion.text) }
        return ("@" + HappyReferences.label(teammate.name), suggestion.text)
    }

    /// A saved or sent draft as the composer shows it: each person's Happy
    /// link with words as "@" and those words, and the links by what shows.
    public static func shown(_ markdown: String) -> (text: String, links: [String: String]) {
        var links: [String: String] = [:]
        let text = HappyMarkdownLinks.replace(markdown) { match in
            guard !match.source.hasPrefix("!"), case .reference(let reference)? = match.link?.target, reference.kind == .user,
                  match.link?.instanceId == nil else { return nil }
            let name = HappyReferences.label(match.label).replacingOccurrences(of: "^@", with: "", options: .regularExpression)
            guard !name.isEmpty else { return nil }
            links["@" + name] = match.source
            return "@" + name
        }
        return (text, links)
    }

    /// The draft as it is saved and sent: each mention the composer shows
    /// (`links`' "@Name", not part of a longer word) as its link.
    public static func markdown(_ text: String, links: [String: String]) -> String {
        guard !links.isEmpty, text.contains("@") else { return text }
        let units = Array(text.utf16)
        // The longest first, so "@Ada Lovelace" is not read as "@Ada".
        let shown = links.keys.sorted { $0.utf16.count > $1.utf16.count }.map { ($0, Array($0.utf16)) }
        func isWord(_ unit: UInt16) -> Bool {
            guard let scalar = Unicode.Scalar(unit) else { return false }
            return CharacterSet.alphanumerics.contains(scalar) || scalar == "_"
        }
        var out: [UInt16] = []
        var index = 0
        outer: while index < units.count {
            if units[index] == 0x40, index == 0 || !isWord(units[index - 1]) {
                for (key, keyUnits) in shown {
                    let end = index + keyUnits.count
                    guard end <= units.count, Array(units[index..<end]) == keyUnits, end == units.count || !isWord(units[end]),
                          let link = links[key] else { continue }
                    out += link.utf16
                    index = end
                    continue outer
                }
            }
            out.append(units[index])
            index += 1
        }
        return String(decoding: out, as: UTF16.self)
    }

    /// The palette's rows for `activeWord`.
    public static func suggestions(_ activeWord: String, in teammates: [TeamUser], me: String?) -> [ComposerSuggestion] {
        people(activeWord, in: teammates, me: me).compactMap { teammate in
            link(teammate).map { ComposerSuggestion(key: "user-\(teammate.id)", text: $0, kind: .person(teammate)) }
        }
    }

    /// The composer once `suggestion` is picked for the `@` word at the
    /// caret: the word becomes "@Name" and a space, the caret after it.
    public static func apply(_ suggestion: ComposerSuggestion, to text: String, selection: NSRange) -> (text: String, cursor: Int) {
        ComposerAutocomplete.applySuggestion(text, selection: selection, suggestion: shown(suggestion).text, prefixes: prefixes, addSpace: true)
    }
}
