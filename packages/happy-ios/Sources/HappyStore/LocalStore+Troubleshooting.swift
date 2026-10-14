import Foundation
import GRDB
import HappyWire

/// Only the fields needed to group computers and choose the prompt's project.
/// Ciphertexts, daemon state and the account's full session JSON stay in SQLite.
public struct TroubleshootingSnapshot: Equatable, Sendable {
    public var machines: [MachineRecord]
    public var recentSession: TroubleshootingSession?
}

public struct TroubleshootingSession: Equatable, Sendable {
    public var machineId: String
    public var projectName: String?
    public var path: String?
    public var happyHomeDir: String?
}

extension LocalStore {
    public func troubleshootingSnapshots() -> AsyncStream<TroubleshootingSnapshot> { troubleshootingHub.snapshots() }

    static func fetchTroubleshootingSnapshot(_ db: Database) throws -> TroubleshootingSnapshot {
        let rows = try Row.fetchAll(db, sql: """
            SELECT id, createdAt, active, activeAt,
                   json_extract(metadata, '$.displayName', '$.host', '$.siblingMachineId',
                       '$.machineKind', '$.rigOnly', '$.client.id', '$.cliAvailability.rig', '$.happyHomeDir') AS details
            FROM machine ORDER BY createdAt DESC, id
            """)
        let machines = try rows.map { row -> MachineRecord in
            let details: String? = row["details"]
            let fields = try details.map { try JSONValue.decode(Data($0.utf8)) }
            var metadata: [String: JSONValue] = [:]
            if case .array(let values) = fields {
                for (index, key) in ["displayName", "host", "siblingMachineId", "machineKind", "rigOnly", "client", "cliAvailability", "happyHomeDir"].enumerated() {
                    guard values[index] != .null else { continue }
                    switch key {
                    case "client": metadata[key] = .object(["id": values[index]])
                    case "cliAvailability": metadata[key] = .object(["rig": values[index]])
                    default: metadata[key] = values[index]
                    }
                }
            }
            return MachineRecord(id: row["id"], seq: 0, createdAt: row["createdAt"], updatedAt: 0,
                                 active: row["active"], activeAt: row["activeAt"], metadataVersion: 0,
                                 metadataCipher: "", metadata: .object(metadata), daemonStateVersion: 0,
                                 daemonStateCipher: nil, daemonState: nil, dataKeyCipher: nil, decryptable: true)
        }
        let recent = try Row.fetchOne(db, sql: """
            SELECT json_extract(s.metadata, '$.machineId', '$.project.name', '$.path', '$.happyHomeDir') AS details
            FROM session s JOIN machine m ON m.id = json_extract(s.metadata, '$.machineId')
            WHERE json_type(s.metadata, '$.isSideChat') IS NOT 'true'
                  AND json_type(s.metadata, '$.machineId') = 'text'
            ORDER BY s.updatedAt DESC, s.active DESC,
                     coalesce(CASE WHEN json_type(s.metadata, '$.lastMeaningfulMessageAt') IN ('integer', 'real')
                                   THEN json_extract(s.metadata, '$.lastMeaningfulMessageAt') END,
                              s.lastMessageSentAt, s.createdAt) DESC, s.id
            LIMIT 1
            """)
        return TroubleshootingSnapshot(machines: machines, recentSession: try recent.map {
            guard let details: String = $0["details"],
                  case .array(let values) = try JSONValue.decode(Data(details.utf8)), values.count == 4 else {
                throw DatabaseError(message: "Invalid troubleshooting session projection")
            }
            return TroubleshootingSession(machineId: values[0].stringValue ?? "", projectName: values[1].stringValue,
                                          path: values[2].stringValue, happyHomeDir: values[3].stringValue)
        })
    }
}