import Foundation

/// A Happy Cloud bot's `kind`. A `shared` bot is one conversation the
/// team's owners use in common, the only ones who receive it; home lists it
/// last in its first group, after Activity and Artifacts, as desktop does,
/// not among the bots. A `personal` bot is a definition every member talks
/// to in a conversation of their own, its `agent` the reader's. A daemon
/// sends no kind, and its bots are drawn as they always were; a kind this
/// build doesn't know is drawn as a personal one. Where a bot goes is its
/// kind's alone, never `isAdmin` or `systemKey`.
public enum BotKind: String, Equatable, Sendable {
    case shared
    case personal

    /// Nil for a daemon's bot.
    public init?(wire kind: String?) {
        guard let kind else { return nil }
        self = BotKind(rawValue: kind) ?? .personal
    }
}

extension AgentWire.Bot {
    public var botKind: BotKind? { BotKind(wire: kind) }

    /// A field this build can't read is none, never a lost bot list.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        systemKey = try container.decodeIfPresent(String.self, forKey: .systemKey)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        avatar = try container.decodeIfPresent(AgentWire.Avatar.self, forKey: .avatar)
        version = try container.decodeIfPresent(String.self, forKey: .version)
        agent = try container.decodeIfPresent(AgentWire.Agent.self, forKey: .agent)
        kind = (try? container.decodeIfPresent(String.self, forKey: .kind)) ?? nil
        isAdmin = (try? container.decodeIfPresent(Bool.self, forKey: .isAdmin)) ?? nil
        editable = (try? container.decodeIfPresent(Bool.self, forKey: .editable)) ?? nil
        instructions = (try? container.decodeIfPresent(String.self, forKey: .instructions)) ?? nil
        revision = (try? container.decodeIfPresent(Int.self, forKey: .revision)) ?? nil
    }
}

extension DesktopSnapshot.Owner {
    /// A bot's kind; nil for a task and for a daemon's bot.
    public var botKind: BotKind? { BotKind(wire: kind) }
}
