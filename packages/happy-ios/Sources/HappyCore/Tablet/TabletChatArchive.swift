import Foundation

/// The grouped sidebar's swipe on a chat (ActiveSessionsGroupCompact.tsx
/// `CompactSessionRow`'s `performArchive`): it only asks the CLI to stop
/// the session (`sessionKill`); there is no server archive after it, unlike
/// the flat row's swipe.
public enum TabletChatArchive {
    public enum Outcome: Equatable, Sendable {
        case killed
        /// The CLI said no: its message, or nil for "Failed to archive
        /// session" (`result.message || t(...)`).
        case refused(String?)
        /// Anything else went wrong: useHappyAction's "Unknown error".
        case failed
    }

    public static func run(_ ops: any HomeSessionOps, sessionId: String) async -> Outcome {
        do {
            let result = try await ops.sessionKill(sessionId: sessionId)
            if result.success { return .killed }
            return .refused(result.message.isEmpty ? nil : result.message)
        } catch {
            return .failed
        }
    }
}
