import Foundation
import HappyWire

/// A personal bot's settings as its page edits them: its name, its
/// instructions (kept by the server, never a file) and a new picture.
/// Saving is `PATCH /v0/bots/:id` naming the version read (`If-Match`)
/// with only what changed, then the picture on its own route; the server
/// deploys the change to every member's conversation at its next turn.
/// A bot whose `editable` isn't true has no such page.
public struct BotEdit: Equatable, Sendable {
    /// What the server keeps at most: 256 characters of name, 32 KiB of
    /// instructions in UTF-8.
    public static let nameLimit = 256
    public static let instructionsLimit = 32 * 1024

    public enum Problem: Equatable, Sendable {
        case nameMissing
        case nameTooLong
        case instructionsTooLong
    }

    /// The bot as last read: what the fields began as, and the version a
    /// save names.
    public private(set) var base: AgentWire.Bot
    public var name: String
    public var instructions: String
    /// A picture picked here (JPEG), saved with the rest; nil for none.
    public var photo: Data?

    public init(_ bot: AgentWire.Bot) {
        base = bot
        name = bot.name
        instructions = bot.instructions ?? ""
    }

    public var botId: String { base.id }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var baseInstructions: String { base.instructions ?? "" }

    public var nameChanged: Bool { trimmedName != base.name }
    public var instructionsChanged: Bool { instructions != baseInstructions }
    public var isDirty: Bool { nameChanged || instructionsChanged || photo != nil }

    /// What stops a save, the name's first.
    public var problem: Problem? {
        if trimmedName.isEmpty { return .nameMissing }
        if trimmedName.count > Self.nameLimit || trimmedName.contains(where: { $0.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) } }) { return .nameTooLong }
        if instructions.utf8.count > Self.instructionsLimit { return .instructionsTooLong }
        return nil
    }

    public var canSave: Bool { isDirty && problem == nil }

    /// The PATCH's fields: only what changed; nil when only the picture did.
    public func changes(mutationId: String) -> JSONValue? {
        var fields: [String: JSONValue] = [:]
        if nameChanged { fields["name"] = .string(trimmedName) }
        if instructionsChanged { fields["instructions"] = .string(instructions) }
        guard !fields.isEmpty else { return nil }
        fields["mutationId"] = .string(mutationId)
        return .object(fields)
    }

    /// Whether `newer` changed a field the person changed here, to
    /// something else: saving over it would lose that change.
    public func collides(with newer: AgentWire.Bot) -> Bool {
        (nameChanged && newer.name != base.name && newer.name != trimmedName)
            || (instructionsChanged && (newer.instructions ?? "") != baseInstructions && (newer.instructions ?? "") != instructions)
    }

    /// Over a newer read of the bot: what the person didn't change here
    /// takes the newer value, what they did stays as typed.
    public mutating func rebase(on newer: AgentWire.Bot) {
        if !nameChanged { name = newer.name }
        if !instructionsChanged { instructions = newer.instructions ?? "" }
        base = newer
    }

    public enum SaveError: Error, Equatable {
        /// Someone else changed what the person changed, meanwhile: the
        /// bot as it now is, for the page to rebase on.
        case conflict(AgentWire.Bot)
    }

    /// Saves what changed, then the picture. A save that lost a race to a
    /// change elsewhere reads the bot again and saves over that once,
    /// unless the two collide (`SaveError.conflict`). The bot as the server
    /// last answered it.
    public func save(with client: AgentClient, mutationId: String = ClientID.make()) async throws -> AgentWire.Bot {
        var saved = base
        if let changes = changes(mutationId: mutationId) {
            if let first = try await client.updateBot(botId, version: base.version ?? "", changes: changes) {
                saved = first
            } else {
                let newer = try await client.bot(botId)
                guard !collides(with: newer) else { throw SaveError.conflict(newer) }
                guard let again = try await client.updateBot(botId, version: newer.version ?? "", changes: changes) else { throw Self.stale }
                saved = again
            }
        }
        if let photo {
            if let first = try await client.setBotAvatar(botId, version: saved.version ?? "", jpeg: photo) {
                saved = first
            } else {
                let newer = try await client.bot(botId)
                guard let again = try await client.setBotAvatar(botId, version: newer.version ?? "", jpeg: photo) else { throw Self.stale }
                saved = again
            }
        }
        return saved
    }

    /// Refused as stale twice running.
    static let stale = AgentClientError.status(409, code: "version_conflict", message: nil)
}

extension AgentClient {
    /// `GET /v0/bots/:id`: for a personal bot, the reader's own conversation.
    public func bot(_ botId: String) async throws -> AgentWire.Bot {
        try Self.bot(from: await send("GET", "/v0/bots/\(Self.escape(botId))"))
    }

    /// `PATCH /v0/bots/:id` over `version`: the bot as saved, or nil when
    /// the version was stale (409).
    public func updateBot(_ botId: String, version: String, changes: JSONValue) async throws -> AgentWire.Bot? {
        do {
            return try Self.bot(from: await send("PATCH", "/v0/bots/\(Self.escape(botId))", json: changes, headers: ["If-Match": version]))
        } catch AgentClientError.status(409, _, _) {
            return nil
        }
    }

    /// `PUT /v0/bots/:id/avatar` over `version`, the picture's own bytes:
    /// the bot as saved, or nil when the version was stale (409).
    public func setBotAvatar(_ botId: String, version: String, jpeg: Data) async throws -> AgentWire.Bot? {
        do {
            return try Self.bot(from: await send("PUT", "/v0/bots/\(Self.escape(botId))/avatar", raw: jpeg,
                                                 headers: ["If-Match": version, "Content-Type": "image/jpeg"], category: .file))
        } catch AgentClientError.status(409, _, _) {
            return nil
        }
    }

    private static func bot(from response: HTTP1Response) throws -> AgentWire.Bot {
        guard let value = try? JSONValue.decode(response.body), let bot = value["bot"],
              let decoded = try? JSONDecoder().decode(AgentWire.Bot.self, from: JSONEncoder().encode(bot)) else { throw AgentClientError.invalidResponse }
        return decoded
    }
}
