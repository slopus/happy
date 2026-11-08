import Foundation
import HappyWire

/// How the agent composer reads a draft against the agent's slash commands
/// (desktop's composerState.ts `commandQueryOf` and `commandInvocationOf`,
/// ConversationDock.tsx's filter).
public enum SlashCommands {
    /// What the palette is filtering by, without the slash: only while the
    /// whole draft is `/` and one command word that some command still
    /// starts with. A pasted path, `/ two words` or `/nonsense` is ordinary
    /// text that sends as it is.
    public static func query(_ draft: String, in catalog: [AgentWire.SlashCommand]) -> String? {
        guard !catalog.isEmpty, draft.hasPrefix("/") else { return nil }
        let word = draft.dropFirst()
        guard word.unicodeScalars.allSatisfy(isWordScalar) else { return nil }
        let query = String(word)
        return matches(query, in: catalog).isEmpty ? nil : query
    }

    /// The commands whose names start with `query`, ignoring case, in the
    /// agent's order.
    public static func matches(_ query: String, in catalog: [AgentWire.SlashCommand]) -> [AgentWire.SlashCommand] {
        let needle = query.lowercased()
        guard !needle.isEmpty else { return catalog }
        return catalog.filter { $0.name.lowercased().hasPrefix(needle) }
    }

    /// A sent draft that is one of the commands: `/name`, or `/name` and
    /// its arguments after a space or a new line. Arguments that are only
    /// whitespace are none. A command that takes none, followed by words,
    /// is not a command but a message.
    public static func invocation(_ draft: String, in catalog: [AgentWire.SlashCommand]) -> (command: AgentWire.SlashCommand, arguments: String?)? {
        guard draft.hasPrefix("/") else { return nil }
        let rest = draft.dropFirst()
        let name = rest.prefix { !$0.isWhitespace }
        guard let command = catalog.first(where: { $0.name == name }) else { return nil }
        let tail = rest.dropFirst(name.count)
        // `\s([\s\S]*)`: one separator, the rest exactly as typed.
        let arguments = tail.isEmpty ? nil : String(tail.dropFirst())
        guard let arguments, !arguments.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return (command, nil) }
        return command.hasArguments ? (command, arguments) : nil
    }

    /// What a pick from the palette leaves in the composer: a command that
    /// takes arguments waits for them after its name; one that doesn't
    /// runs at once.
    public enum Pick: Equatable, Sendable {
        case fill(String)
        case run
    }

    public static func pick(_ command: AgentWire.SlashCommand) -> Pick {
        command.hasArguments ? .fill("/\(command.name) ") : .run
    }

    /// The message a skill command sends (desktop aa8a2529): its text as
    /// typed, carrying a `read_skill` request Happy Agent runs before the
    /// model reads it.
    public static func skillMessage(_ command: AgentWire.SlashCommand, arguments: String?) -> (text: String, toolRequest: AgentWire.ToolCallRequest) {
        (text(command, arguments: arguments), .readSkill(command.name))
    }

    /// The command as typed: `/name`, then its arguments after a space.
    public static func text(_ command: AgentWire.SlashCommand, arguments: String?) -> String {
        arguments.map { "/\(command.name) \($0)" } ?? "/\(command.name)"
    }

    /// New work's commands, before it has an agent (`GET /v0/skills`): each
    /// enabled, ready global skill as the skill command an agent offers for
    /// it, in the catalog's order, the first of a repeated name only.
    /// Disabled, broken and unreadable skills are not offered.
    public static func globalSkills(_ summaries: [JSONValue]) -> [AgentWire.SlashCommand] {
        var seen = Set<String>()
        return summaries.compactMap { summary in
            guard summary["enabled"] == .bool(true), summary["status"]?.stringValue == "ready",
                  let name = summary["name"]?.stringValue, !name.isEmpty, seen.insert(name).inserted else { return nil }
            return AgentWire.SlashCommand(name: name, hasArguments: true, description: summary["description"]?.stringValue ?? "", kind: "skill")
        }
    }

    /// `[A-Za-z0-9._:-]`.
    private static func isWordScalar(_ scalar: Unicode.Scalar) -> Bool {
        scalar.isASCII && (CharacterSet.alphanumerics.contains(scalar) || "._:-".unicodeScalars.contains(scalar))
    }
}

extension SlashCommands {
    /// The palette's rows for `query`: each matching command with its
    /// picture's path on `agentId`'s computer.
    public static func suggestions(_ query: String, in catalog: [AgentWire.SlashCommand], agentId: String) -> [ComposerSuggestion] {
        matches(query, in: catalog).map {
            ComposerSuggestion(key: "slash-\($0.name)", text: "/\($0.name)", kind: .agentCommand($0, imagePath: $0.imagePath(agentId: agentId)))
        }
    }
}
