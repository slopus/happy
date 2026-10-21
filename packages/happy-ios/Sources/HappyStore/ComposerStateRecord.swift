import Foundation
import GRDB
import HappyWire

/// Persistent, device-local permission, model, effort and service-tier choices.
/// Missing fields are JS undefined; JSON null is retained (notably serviceTier).
public struct ComposerStateRecord: Codable, Hashable, Sendable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "composerState"
    public var sessionId: String
    /// The composer selections; absent keys fall back to session/global defaults.
    public var values: JSONValue

    /// Creates per-session selections without replacing missing keys with null.
    public init(sessionId: String, values: JSONValue = .object([:])) {
        self.sessionId = sessionId
        self.values = values
    }
}
