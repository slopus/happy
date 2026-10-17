import Foundation
import HappyStore
import HappyWire

/// Refusals before acceptance and errors encountered during outbox delivery.
public enum SendingError: Error, Equatable, Sendable {
    /// The account stopped or the caller cancelled before acceptance.
    case inactiveAccount
    /// The session is absent or its encryption key changed during delivery.
    case unknownSession
    /// A queued file or its session blob key is unavailable.
    case missingAttachment
    /// The server response did not acknowledge the submitted localId.
    case missingAcknowledgement
    /// All picked attachments were rejected and there is no text to send.
    case unsupportedAttachments
}

/// Attachment selection after applying flavor support and the Rig media policy.
public struct AttachmentSendPlan: Equatable, Sendable {
    public let accepted: [OutgoingAttachment]
    public let rejected: [OutgoingAttachment]
    public let shouldShowUnsupportedAlert: Bool
    public let shouldSendText: Bool
}

/// The composer facade. Acceptance is local and atomic; SyncEngine owns delivery.
public struct OutboxSender: ChatSending {
    public let store: LocalStore
    public let sync: SyncEngine
    public let filesDirectory: URL
    public let spawnRequests: SpawnRequests

    /// Uses this account's store, active sync engine and private files directory.
    public init(store: LocalStore, sync: SyncEngine, filesDirectory: URL, spawnRequests: SpawnRequests = SpawnRequests()) {
        self.store = store
        self.sync = sync
        self.filesDirectory = filesDirectory
        self.spawnRequests = spawnRequests
    }

    /// Checks support without copying, enqueuing or performing network work.
    /// The composer uses the rejected list to show imageUpload.notSupported first.
    public func attachmentPlan(_ message: OutgoingMessage, sessionId: String) throws -> AttachmentSendPlan {
        guard let session = try store.session(id: sessionId) else {
            throw SendingError.unknownSession
        }
        return Self.attachmentPlan(message, session: session)
    }

    /// `attachmentPlan(_:sessionId:)` with the session read on a background
    /// task, never on the caller's executor, so the main thread can await it.
    public func attachmentPlan(for message: OutgoingMessage, sessionId: String) async throws -> AttachmentSendPlan {
        let store = self.store
        return try await Task.detached(priority: .userInitiated) {
            guard let session = try store.session(id: sessionId) else {
                throw SendingError.unknownSession
            }
            return Self.attachmentPlan(message, session: session)
        }.value
    }

    /// Pure port of getImageAttachmentSendPlan and isAttachmentAllowedByPolicy.
    public static func attachmentPlan(_ message: OutgoingMessage, session: SessionRecord) -> AttachmentSendPlan {
        let metadata = session.metadata ?? .object([:])
        let rig = UserMessageEncoder.isRig(metadata)
        let policy = metadata["capabilities"]?["attachments"]
        let flavor = metadata["flavor"]?.stringValue
        let supportsAttachments: Bool
        if rig {
            supportsAttachments = policy?["enabled"]?.boolValue == true
        } else {
            supportsAttachments = flavor == nil || flavor == "" || flavor == "claude" || flavor == "codex"
        }
        func allowed(_ attachment: OutgoingAttachment) -> Bool {
            guard supportsAttachments else {
                return false
            }
            guard rig, let policy else {
                return true
            }
            let maxBytes = policy["maxBytes"]?.numberValue ?? 0
            let sizeAllowed = attachment.size <= 0 || Double(attachment.size) <= maxBytes
            let mediaAllowed = (policy["mediaTypes"]?.arrayValue ?? []).contains { value in
                guard let mediaType = value.stringValue else {
                    return false
                }
                return mediaType == attachment.mimeType
                    || (mediaType.hasSuffix("/*") && attachment.mimeType.hasPrefix(String(mediaType.dropLast())))
            }
            return sizeAllowed && mediaAllowed
        }
        let accepted = message.attachments.filter(allowed)
        let rejected = message.attachments.filter { !allowed($0) }
        let unsupported = !message.attachments.isEmpty && !supportsAttachments
        return AttachmentSendPlan(
            accepted: accepted,
            rejected: rejected,
            shouldShowUnsupportedAlert: !rejected.isEmpty,
            shouldSendText: !unsupported || !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        )
    }

    /// Atomically accepts supported files and encoded text into the local outbox.
    public func send(_ message: OutgoingMessage, sessionId: String) async throws -> String {
        let draftStamp = try store.composerState(sessionId: sessionId).values["draftUpdatedAt"]
        let id = try await sync.accept(message, sessionId: sessionId, filesDirectory: filesDirectory)
        // sync.ts `releaseSpawnedSession`: a session written to is no longer
        // an abandoned start.
        await spawnRequests.release(sessionId: sessionId)
        // Once accepted, a cache failure must not report a failed send and invite a duplicate.
        if message.source != .voice {
            try? sync.rigComposer.clearAfterSend(sessionId: sessionId, expectedStamp: draftStamp)
        }
        return id
    }

    /// Clears a failed item's attempts and schedules another delivery.
    public func retry(localId: String) async throws {
        try await sync.retrySend(localId: localId)
    }

    /// Removes an unsent item, its dependency chain and their copied files.
    public func discard(localId: String) async throws {
        try await sync.discardSend(localId: localId, filesDirectory: filesDirectory)
    }

    /// Reads this session's unsent composer text from disk.
    public func draft(sessionId: String) throws -> String {
        try store.draft(sessionId: sessionId)?.text ?? ""
    }

    /// Saves unsent text; an empty string clears the stored draft.
    public func saveDraft(sessionId: String, text: String) throws {
        if try store.session(id: sessionId)?.isRigV1 == true {
            try sync.rigComposer.setText(sessionId: sessionId, text: text)
            return
        }
        try store.saveDraft(sessionId: sessionId, text: text, at: Int64(Date().timeIntervalSince1970 * 1000))
    }
    /// Reads the local permission, model, effort and service-tier selections.
    public func composerState(sessionId: String) throws -> ComposerStateRecord {
        try store.composerState(sessionId: sessionId)
    }

    /// Persists composer selections, retaining explicit JSON null values.
    public func saveComposerState(_ state: ComposerStateRecord) throws {
        try store.saveComposerState(state)
    }

    /// The UI can observe the outbox and display happy-app's upload-failed alert count.
    public func failedAttachmentCount(sessionId: String) throws -> Int {
        try store.pendingOutbox(limit: Int.max).filter {
            $0.sessionId == sessionId && $0.kind == .file && $0.state == .failed
        }.count
    }
}
