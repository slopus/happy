import Foundation
import HappyStore

/// A voice start's first message against the call's End: whichever comes
/// first wins, decided where the message is kept (`enqueueAcceptedSend`'s
/// `admitting`). Kept first, the session is the person's and End leaves
/// it; ended first, the message is refused and the start is put down.
public final class VoiceStartGate: @unchecked Sendable {
    public static let ended = "The call ended before it went."

    private let lock = NSLock()
    private var isEnded = false
    private var accepted = false

    public init() {}

    /// Where the first message is kept: true, and the start the person's
    /// from now, unless the call ended first.
    public func admit() -> Bool {
        lock.withLock {
            guard !isEnded else { return false }
            accepted = true
            return true
        }
    }

    /// The call ended. Unless the first message was kept already, the
    /// start's scope closes, which stops it and puts down what it made.
    @MainActor
    public func end(closing scope: SpawnRequests) {
        let kept = lock.withLock {
            isEnded = true
            return accepted
        }
        if !kept { scope.close() }
    }
}

/// The sender a voice start's `SessionStarter` uses: its first message is
/// kept only through `gate`. `keep` is the outbox's send with an
/// `admitting` check (`OutboxSender.send(_:sessionId:admitting:)`).
public struct VoiceStartSender: ChatSending {
    public typealias Keep = @Sendable (OutgoingMessage, String, @escaping @Sendable (SessionRecord?) -> String?) async throws -> String

    private let gate: VoiceStartGate
    private let base: any ChatSending
    private let keep: Keep

    public init(gate: VoiceStartGate, base: any ChatSending, keep: @escaping Keep) {
        self.gate = gate
        self.base = base
        self.keep = keep
    }

    public func send(_ message: OutgoingMessage, sessionId: String) async throws -> String {
        try await keep(message, sessionId) { [gate] _ in gate.admit() ? nil : VoiceStartGate.ended }
    }

    public func retry(localId: String) async throws { try await base.retry(localId: localId) }
    public func discard(localId: String) async throws { try await base.discard(localId: localId) }
}
