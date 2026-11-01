import Foundation
@testable import HappyCore
import HappyStore
import HappyWire

/// A Happy CLI account's home, as the derivations read it.
enum LegacyHomeFixtures {
    static let now = ApplyPerfFixtures.now
    static let minute: Int64 = 60_000
    static let hour: Int64 = 60 * minute
    static let day: Int64 = 24 * hour

    static func machine(_ id: String, active: Bool, name: String) -> MachineRecord {
        MachineRecord(
            id: id, seq: 1, createdAt: now, updatedAt: now, active: active, activeAt: now,
            metadataVersion: 1, metadataCipher: "c", metadata: .object(["displayName": .string(name)]),
            daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "k", decryptable: true
        )
    }

    static func session(
        _ id: String,
        machine: String?,
        path: String?,
        active: Bool = true,
        at: Int64 = now - minute,
        title: String? = nil,
        metadata extra: [String: JSONValue] = [:],
        agentState: JSONValue? = nil,
        thinking: Bool = false,
        unread: Bool = false
    ) -> SessionRecord {
        var metadata: [String: JSONValue] = ["homeDir": .string("/work"), "lastMeaningfulMessageAt": .number(Double(at))]
        if let machine { metadata["machineId"] = .string(machine) }
        if let path { metadata["path"] = .string(path) }
        if let title { metadata["summary"] = .object(["text": .string(title)]) }
        metadata.merge(extra) { _, new in new }
        return SessionRecord(
            id: id, seq: 1, createdAt: at, updatedAt: at, active: active, activeAt: at, projectId: nil,
            metadataVersion: 1, metadataCipher: "c", metadata: .object(metadata),
            agentStateVersion: 0, agentStateCipher: nil, agentState: agentState,
            dataKeyCipher: "k", decryptable: true, thinking: thinking, unread: unread
        )
    }

    static let worktreePath = "/work/happy/.dev/worktree/fix-x"

    /// Two computers (one offline), a bot, two projects with a worktree,
    /// a chat that names no computer, and two archived chats.
    static func snapshot(hidesArchive: Bool = false, grouping: String = "project", presenceNow: Int64? = nil) -> LegacyHomeSnapshot {
        let bot: [String: JSONValue] = ["bot": .object([
            "id": .string("bot1"), "name": .string("Helper"), "username": .string("helper"), "orderKey": .string("a"),
        ])]
        var snapshot = LegacyHomeSnapshot(
            machines: MachinesSnapshot(synced: true, machines: [
                machine("m1", active: true, name: "Studio"),
                machine("m2", active: false, name: "Laptop"),
            ]),
            sessions: [
                session("b1", machine: "m1", path: "/work/helper", metadata: bot),
                session("s1", machine: "m1", path: "/work/happy", title: "Primary"),
                session("s2", machine: "m1", path: worktreePath, at: now - 2 * minute, title: "Worktree", thinking: true),
                session("s3", machine: "m1", path: "/work/alpha", title: "Alpha",
                        agentState: .object(["requests": .object(["r1": .object(["tool": .string("Bash")])])])),
                session("s4", machine: "m2", path: "/home/u/proj", title: "Away"),
                session("s5", machine: nil, path: nil, title: "Nowhere"),
                session("a1", machine: "m1", path: "/work/old", active: false, at: now - 2 * hour, title: "Old"),
                session("a2", machine: "m1", path: "/work/older", active: false, at: now - day, title: "Older"),
            ],
            settings: SettingsSnapshot(pending: [
                "sessionListGrouping": .string(grouping),
                "hideInactiveSessions": .bool(hidesArchive),
            ]),
            sessionsSynced: true
        )
        snapshot.presenceNow = presenceNow
        return snapshot
    }
}
