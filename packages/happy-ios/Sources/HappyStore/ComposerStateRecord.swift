import Foundation
import GRDB
import HappyWire

/// Missing fields are JS undefined; JSON null is retained (notably serviceTier).
public struct ComposerStateRecord: Codable, Hashable, Sendable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "composerState"
    public var sessionId: String
    public var values: JSONValue
    public init(sessionId: String, values: JSONValue = .object([:])) {
        self.sessionId = sessionId
        self.values = values
    }
}