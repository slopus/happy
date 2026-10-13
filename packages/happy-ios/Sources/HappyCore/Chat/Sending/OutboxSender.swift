import Foundation
import HappyStore
import HappyWire

public enum SendingError: Error, Equatable, Sendable {
    case inactiveAccount
    case unknownSession
    case missingAttachment
    case missingAcknowledgement
    case unsupportedAttachments
}

/// The composer facade. Acceptance is local and atomic; SyncEngine owns delivery.
public struct OutboxSender: ChatSending {
    public let store: LocalStore
    public let sync: SyncEngine
    public let filesDirectory: URL

    public init(store: LocalStore, sync: SyncEngine, filesDirectory: URL) {
        self.store = store
        self.sync = sync
        self.filesDirectory = filesDirectory
    }

    public func send(_ message: OutgoingMessage, sessionId: String) async throws -> String {
        try await sync.accept(message, sessionId: sessionId, filesDirectory: filesDirectory)
    }

    public func retry(localId: String) async throws { try await sync.retrySend(localId: localId) }
    public func discard(localId: String) async throws { try await sync.discardSend(localId: localId, filesDirectory: filesDirectory) }
    public func draft(sessionId: String) throws -> String { try store.draft(sessionId: sessionId)?.text ?? "" }
    public func saveDraft(sessionId: String, text: String) throws {
        try store.saveDraft(sessionId: sessionId, text: text, at: Int64(Date().timeIntervalSince1970 * 1000))
    }
    public func composerState(sessionId: String) throws -> ComposerStateRecord { try store.composerState(sessionId: sessionId) }
    public func saveComposerState(_ state: ComposerStateRecord) throws { try store.saveComposerState(state) }

    /// The UI can observe the outbox and display happy-app's upload-failed alert count.
    public func failedAttachmentCount(sessionId: String) throws -> Int {
        try store.pendingOutbox(limit: Int.max).filter { $0.sessionId == sessionId && $0.kind == .file && $0.state == .failed }.count
    }
}