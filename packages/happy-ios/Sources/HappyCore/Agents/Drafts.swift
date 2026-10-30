import Foundation
import HappyWire

/// One conversation's draft as this phone last had it: the text, when it
/// was touched (the computer's clock of record, desktop's `updatedAt`), and
/// whether the computer has it yet. Empty text is a cleared draft, kept
/// for its stamp.
public struct Draft: Codable, Equatable, Sendable {
    public var text: String
    public var updatedAt: Double
    public var synced: Bool

    public init(text: String, updatedAt: Double, synced: Bool) {
        self.text = text
        self.updatedAt = updatedAt
        self.synced = synced
    }
}

/// The drafts kept on this phone for one computer, by agent, beside what
/// else it keeps of that computer (`drafts.json` in its folder), so a
/// draft opens at once, offline too, and one the computer never got is
/// sent when it can be. The computer's copy is the one shared with the
/// person's other devices (`Conversation`).
public actor Drafts {
    private let offline: OfflineFile?
    private var drafts: [String: Draft]?
    private var saving: Task<Void, Never>?
    private var observer: (@Sendable (String, Draft?) -> Void)?

    static let fileName = "drafts.json"

    public init(offline: OfflineFile?) {
        self.offline = offline
    }

    public func draft(_ agentId: String) -> Draft? {
        loaded()[agentId]
    }

    /// Every draft kept, by agent.
    public func all() -> [String: Draft] {
        loaded()
    }

    /// Hears every draft kept or forgotten from now on.
    public func observe(_ observer: @escaping @Sendable (String, Draft?) -> Void) {
        self.observer = observer
    }

    /// Keeps `draft` for the agent, or forgets it with nil, and writes the
    /// file off this actor after any write before it.
    public func keep(_ agentId: String, _ draft: Draft?) {
        var all = loaded()
        guard all[agentId] != draft else { return }
        all[agentId] = draft
        drafts = all
        observer?(agentId, draft)
        guard let offline else { return }
        let previous = saving
        saving = Task.detached(priority: .utility) {
            await previous?.value
            guard let data = try? JSONEncoder().encode(all) else { return }
            offline.writeExtra(Self.fileName, data: data)
        }
    }

    /// Waits for the writes already asked for.
    public func flush() async {
        await saving?.value
    }

    private func loaded() -> [String: Draft] {
        if let drafts { return drafts }
        let read = offline?.readExtra(Self.fileName).flatMap { try? JSONDecoder().decode([String: Draft].self, from: $0) } ?? [:]
        drafts = read
        return read
    }
}
