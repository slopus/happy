#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
// The fixtures: in Debug, and in builds that ask for them (HAPPY_FIXTURES,
// the hosted tests in Preview). Never in the shipped app.
import Foundation
import HappyStore
import HappyWire

/// Debug only: what a store holds after a sync, with no computer to talk
/// to, for the chat harness's `-seeded` launch and the hosted tests. One
/// computer, and on it the project `happy` with a worktree checkout of four
/// chats (the strip's tabs, oldest first) and a chat on the project's own
/// checkout. The tabs' conversations are short; the main checkout's is
/// long, 300 messages. The home list is grouped
/// by project, so a chat in the worktree shows the strip under its header.
public enum SeededAccount {
    public static let machineId = "harness-mac"
    public static let home = "/Users/harness"
    public static let project = "/Users/harness/happy"
    public static let worktree = "/Users/harness/happy/.dev/worktree/chat-nav"

    public struct Chat: Sendable {
        public let id: String
        public let title: String
        public let path: String
        public let createdAt: Int64
        /// Questions and answers in its conversation.
        public var rounds = 6
    }

    /// The worktree's chats, oldest first, then the main checkout's.
    public static let chats: [Chat] = [
        Chat(id: "seeded-tab-1", title: "Tab strip layout", path: worktree, createdAt: base),
        Chat(id: "seeded-tab-2", title: "Session info screen", path: worktree, createdAt: base + 60_000),
        Chat(id: "seeded-tab-3", title: "Opening a chat", path: worktree, createdAt: base + 120_000),
        Chat(id: "seeded-tab-4", title: "Scroll indicator", path: worktree, createdAt: base + 180_000),
        Chat(id: "seeded-main", title: "Release notes", path: project, createdAt: base + 240_000, rounds: 150),
    ]

    /// 2026-10-16 09:00 UTC.
    public static let base: Int64 = 1_792_141_200_000

    public static func seed(_ store: LocalStore) throws {
        try store.upsertMachine(machine())
        try store.upsertSessions(chats.map(session))
        for chat in chats {
            let messages = conversation(chat)
            try store.applyMessagePage(sessionId: chat.id, messages: messages, syncedThrough: messages.count)
        }
        try store.addPendingSettings(["sessionListGrouping": .string("project")])
        try store.setCursor(.sessionsChangedSince, base + 300_000)
        try store.setCursor(.machinesLastSync, base + 300_000)
    }

    private static func machine() -> MachineRecord {
        MachineRecord(
            id: machineId, seq: 1, createdAt: base, updatedAt: base, active: true, activeAt: Int64(Date().timeIntervalSince1970 * 1000),
            metadataVersion: 1, metadataCipher: "harness",
            metadata: .object([
                "host": .string("harness-mac"), "platform": .string("darwin"), "happyCliVersion": .string("1.0.0"),
                "homeDir": .string(home), "happyHomeDir": .string(home + "/.happy"), "displayName": .string("Harness Mac"),
            ]),
            daemonStateVersion: 1, daemonStateCipher: nil, daemonState: .object(["status": .string("running")]),
            dataKeyCipher: nil, decryptable: true
        )
    }

    private static func session(_ chat: Chat) -> SessionRecord {
        let count = conversation(chat).count
        return SessionRecord(
            id: chat.id, seq: count, createdAt: chat.createdAt, updatedAt: chat.createdAt + 30_000,
            active: true, activeAt: Int64(Date().timeIntervalSince1970 * 1000), projectId: nil,
            metadataVersion: 1, metadataCipher: "harness",
            metadata: .object([
                "path": .string(chat.path), "host": .string("harness-mac"), "homeDir": .string(home),
                "machineId": .string(machineId), "flavor": .string("claude"), "version": .string("1.0.0"),
                "os": .string("darwin"), "summary": .object(["text": .string(chat.title), "updatedAt": .number(Double(chat.createdAt))]),
                "lastMeaningfulMessageAt": .number(Double(chat.createdAt + 30_000)),
                "claudeSessionId": .string("claude-\(chat.id)"),
            ]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: .object(["controlledByUser": .bool(false)]),
            dataKeyCipher: nil, decryptable: true
        )
    }

    /// Questions and answers, enough to scroll.
    private static func conversation(_ chat: Chat) -> [MessageRecord] {
        var records: [MessageRecord] = []
        func add(_ content: JSONValue) {
            let seq = records.count + 1
            let at = chat.createdAt + Int64(seq) * 1000
            records.append(MessageRecord(
                id: "\(chat.id)-m\(seq)", sessionId: chat.id, seq: seq, localId: nil,
                createdAt: at, updatedAt: at, contentCipher: "harness", content: content
            ))
        }
        func user(_ text: String) {
            add(.object([
                "role": .string("user"),
                "content": .object(["type": .string("text"), "text": .string(text)]),
                "meta": .object(["sentFrom": .string("ios")]),
            ]))
        }
        func agent(_ text: String) {
            let seq = records.count + 1
            add(.object([
                "role": .string("session"),
                "content": .object([
                    "id": .string("\(chat.id)-e\(seq)"), "time": .number(Double(chat.createdAt + Int64(seq) * 1000)),
                    "role": .string("agent"), "turn": .string("\(chat.id)-turn"),
                    "ev": .object(["t": .string("text"), "text": .string(text)]),
                ]),
            ]))
        }
        for round in 1...chat.rounds {
            user("\(chat.title): question \(round). What moves, and where does it go?")
            agent("""
            Round \(round) on **\(chat.title)**. The header, the strip under it, the list and the composer each keep \
            their own frame; nothing here should move once the screen is on.

            - The list runs from the header to the dock.
            - The dock sits on the safe area until the keyboard comes up.
            - The strip hangs under the header while the list is grouped by project.
            """)
        }
        return records
    }
}
#endif
