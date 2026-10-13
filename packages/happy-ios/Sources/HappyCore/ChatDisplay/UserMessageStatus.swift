import Foundation

/// MessageView's UserMessageFrame: the line under a user's message, and
/// whether the message is dimmed.
///
/// A message queued behind a busy turn says so at once. Any other message
/// still waiting stays quiet for two seconds from when it was made, so a
/// quick acknowledgement never flashes a status (PENDING_STATUS_GRACE_MS);
/// timing from `createdAt` means a row that comes back on screen already
/// late shows its state straight away. A refusal says so at once.
public struct UserMessageStatus: Equatable, Sendable {
    public enum Line: Equatable, Sendable {
        case none
        case sending
        case sendsAfterThisTurn
        case failed(String)
    }

    public static let graceMilliseconds: Int64 = 2_000

    public var line: Line
    public var dimmed: Bool

    public init(line: Line, dimmed: Bool) {
        self.line = line
        self.dimmed = dimmed
    }

    /// `pending`: the agent hasn't taken the message in yet.
    /// `undelivered`: it hasn't left this device's outbox yet.
    public init(pending: Bool, undelivered: Bool, queuedWhileBusy: Bool, createdAt: Int64, failure: String?, now: Int64) {
        let visible = (pending || undelivered) && (queuedWhileBusy || now - createdAt >= Self.graceMilliseconds)
        if let failure {
            line = .failed(failure)
        } else if visible {
            line = queuedWhileBusy ? .sendsAfterThisTurn : .sending
        } else {
            line = .none
        }
        dimmed = visible && pending && failure == nil
    }

    /// When a waiting message's grace runs out, while it hasn't yet.
    public static func graceEnds(pending: Bool, undelivered: Bool, queuedWhileBusy: Bool, createdAt: Int64, now: Int64) -> Int64? {
        guard pending || undelivered, !queuedWhileBusy else { return nil }
        let end = createdAt + graceMilliseconds
        return end > now ? end : nil
    }
}
