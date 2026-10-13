import Foundation

/// What a user message says once Claude Agent SDK's slash-command wrappers
/// are read: a caveat to hide, a command chip, a goal, or plain text. A port
/// of happy-app's `components/parseLocalCommandMessage.ts`.
///
/// When `/foo` runs, the SDK injects user messages made of tags such as
/// `<command-message>foo</command-message><command-name>/foo</command-name>`;
/// shown through markdown unchanged they would read as raw HTML.
public enum LocalCommandMessage: Equatable, Sendable {
    case caveat
    case commandRun(name: String, arguments: String?)
    case goalRun(goal: String)
    case goalConfirmation(goal: String)
    case text(String)

    public init(_ text: String) {
        typealias P = LocalCommandPatterns
        let whole = NSRange(text.startIndex..., in: text)
        if P.caveat.firstMatch(in: text, range: whole) != nil {
            self = .caveat
            return
        }
        if let match = P.stdout.firstMatch(in: text, range: whole) {
            let stdout = Self.group(match, 1, in: text)?.trimmed ?? ""
            if let goal = Self.goal(fromStdout: stdout) {
                self = .goalConfirmation(goal: goal)
            } else {
                self = .text(stdout)
            }
            return
        }
        if let raw = Self.rawSlashCommand(text) {
            if raw.name.lowercased() == "goal", let goal = raw.arguments {
                self = .goalRun(goal: goal)
            } else {
                self = .commandRun(name: raw.name, arguments: raw.arguments)
            }
            return
        }
        if let nameMatch = P.commandName.firstMatch(in: text, range: whole) {
            let name = (Self.group(nameMatch, 1, in: text) ?? "").trimmed
            let arguments = P.commandArgs.firstMatch(in: text, range: whole).flatMap { Self.group($0, 1, in: text)?.trimmed }
            var stripped = text
            for pattern in [P.commandMessageTag, P.commandNameTag, P.commandArgsTag] {
                stripped = pattern.stringByReplacingMatches(in: stripped, range: NSRange(stripped.startIndex..., in: stripped), withTemplate: "")
            }
            stripped = stripped.trimmed
            guard stripped.isEmpty else {
                self = .text(stripped)
                return
            }
            let nonEmpty = arguments.flatMap { $0.isEmpty ? nil : $0 }
            if name.lowercased() == "goal", let goal = nonEmpty {
                self = .goalRun(goal: goal)
            } else {
                self = .commandRun(name: name, arguments: nonEmpty)
            }
            return
        }
        self = .text(text)
    }

    /// The person's own `/command` as sent from this app (it has a local
    /// id). The SDK re-emits it as a wrapper chip, so the echo is hidden.
    public static func isSlashCommandEcho(_ text: String, hasLocalId: Bool) -> Bool {
        guard hasLocalId else { return false }
        let trimmed = text.trimmed
        guard rawSlashCommand(trimmed) != nil else { return false }
        switch LocalCommandMessage(trimmed) {
        case .commandRun, .goalRun: return true
        default: return false
        }
    }

    /// `/name args`, or a `/name` token anywhere with the rest as arguments.
    static func rawSlashCommand(_ text: String) -> (name: String, arguments: String?)? {
        typealias P = LocalCommandPatterns
        let whole = NSRange(text.startIndex..., in: text)
        if let match = P.rawSlashCommand.firstMatch(in: text, range: whole) {
            let name = (group(match, 1, in: text) ?? "").trimmed
            let arguments = group(match, 2, in: text)?.trimmed
            return (name, arguments.flatMap { $0.isEmpty ? nil : $0 })
        }
        guard let token = P.rawSlashToken.firstMatch(in: text, range: whole),
              let nameRange = Range(token.range(at: 2), in: text) else { return nil }
        // The slash sits just before the name.
        let commandStart = text.index(before: nameRange.lowerBound)
        let before = String(text[..<commandStart]).trimmed
        let after = String(text[nameRange.upperBound...]).trimmed
        let arguments = [before, after].filter { !$0.isEmpty }.joined(separator: " ")
        return (String(text[nameRange]).trimmed, arguments.isEmpty ? nil : arguments)
    }

    static func goal(fromStdout text: String) -> String? {
        let trimmed = text.trimmed
        guard let match = LocalCommandPatterns.goalStdout.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
              let goal = group(match, 1, in: trimmed)?.trimmed, !goal.isEmpty else { return nil }
        return goal
    }

    static func group(_ match: NSTextCheckingResult, _ index: Int, in text: String) -> String? {
        guard let range = Range(match.range(at: index), in: text) else { return nil }
        return String(text[range])
    }
}

enum LocalCommandPatterns {
    nonisolated(unsafe) static let caveat = make(#"^\s*<local-command-caveat>[\s\S]*?</local-command-caveat>\s*$"#)
    nonisolated(unsafe) static let stdout = make(#"^\s*<local-command-stdout>\s*([\s\S]*?)\s*</local-command-stdout>\s*$"#)
    nonisolated(unsafe) static let commandName = make(#"<command-name>\s*/?([^<]+?)\s*</command-name>"#)
    nonisolated(unsafe) static let commandArgs = make(#"<command-args>\s*([\s\S]*?)\s*</command-args>"#)
    nonisolated(unsafe) static let commandMessageTag = make(#"<command-message>[\s\S]*?</command-message>"#)
    nonisolated(unsafe) static let commandNameTag = make(#"<command-name>[\s\S]*?</command-name>"#)
    nonisolated(unsafe) static let commandArgsTag = make(#"<command-args>[\s\S]*?</command-args>"#)
    nonisolated(unsafe) static let rawSlashCommand = make(#"^\s*/([a-zA-Z][A-Za-z0-9_:-]*)(?:\s+([\s\S]*?))?\s*$"#)
    nonisolated(unsafe) static let rawSlashToken = make(#"(^|\s)/([a-zA-Z][A-Za-z0-9_:-]*)(?=$|\s)"#)
    nonisolated(unsafe) static let goalStdout = make(#"^Goal set:\s*([\s\S]*?)\s*$"#, options: .caseInsensitive)

    private static func make(_ pattern: String, options: NSRegularExpression.Options = []) -> NSRegularExpression {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: pattern, options: options)
    }
}
