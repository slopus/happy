import Foundation
import GRDB
import HappyWire

/// One computer and its five most recently updated non-side-chat sessions.
/// Session records contain only the metadata the recent-session rows draw.
public struct MachineDetailSnapshot: Equatable, Sendable {
    public var machine: MachineRecord?
    public var sessions: [SessionRecord]

    public init(machine: MachineRecord?, sessions: [SessionRecord]) {
        self.machine = machine
        self.sessions = sessions
    }
}

extension LocalStore {
    private static let machineDetailQueue = DispatchQueue(label: "HappyStore.machineDetail", qos: .userInitiated)

    public func machineDetailSnapshots(machineId: String) -> AsyncStream<MachineDetailSnapshot> {
        let writer = writer
        let overlay = presenceOverlay
        let region = SQLRequest<Row>(sql: """
            SELECT id, updatedAt, metadata FROM session
            WHERE json_extract(metadata, '$.machineId') = ?
            """, arguments: [machineId])
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let cancellable = ValueObservation.tracking(
                region: region, MachineRecord.filter(Column("id") == machineId),
                fetch: { db in
                    ThreadRules.assertOffMain()
                    return try Self.fetchMachineDetail(db, machineId: machineId)
                }
            ).removeDuplicates().start(in: writer, scheduling: .async(onQueue: Self.machineDetailQueue),
                                      onError: { _ in continuation.finish() }, onChange: { snapshot in
                var value = snapshot
                value.machine = value.machine.map(overlay.machine)
                continuation.yield(value)
            })
            continuation.onTermination = { _ in cancellable.cancel() }
        }
    }

    private static func fetchMachineDetail(_ db: Database, machineId: String) throws -> MachineDetailSnapshot {
        let machine = try MachineRecord.fetchOne(db, key: machineId)
        guard machine != nil else { return MachineDetailSnapshot(machine: nil, sessions: []) }
        let rows = try Row.fetchAll(db, sql: """
            SELECT id, updatedAt,
                   json_extract(metadata, '$.bot.name', '$.summary.text', '$.path', '$.homeDir') AS details
            FROM session
            WHERE json_extract(metadata, '$.machineId') = ?
                  AND json_type(metadata, '$.isSideChat') IS NOT 'true'
            ORDER BY updatedAt DESC, rowid DESC LIMIT 5
            """, arguments: [machineId])
        let sessions = try rows.map { row -> SessionRecord in
            let details: String = row["details"]
            guard case .array(let fields) = try JSONValue.decode(Data(details.utf8)), fields.count == 4 else {
                throw DatabaseError(message: "Invalid machine session projection")
            }
            var metadata: [String: JSONValue] = ["machineId": .string(machineId)]
            if fields[0] != .null { metadata["bot"] = .object(["name": fields[0]]) }
            if fields[1] != .null { metadata["summary"] = .object(["text": fields[1]]) }
            if fields[2] != .null { metadata["path"] = fields[2] }
            if fields[3] != .null { metadata["homeDir"] = fields[3] }
            return SessionRecord(id: row["id"], seq: 0, createdAt: 0, updatedAt: row["updatedAt"],
                                 active: false, activeAt: 0, projectId: nil, metadataVersion: 0,
                                 metadataCipher: "", metadata: .object(metadata), agentStateVersion: 0,
                                 agentStateCipher: nil, agentState: nil, dataKeyCipher: nil, decryptable: true)
        }
        return MachineDetailSnapshot(machine: machine, sessions: sessions)
    }
}