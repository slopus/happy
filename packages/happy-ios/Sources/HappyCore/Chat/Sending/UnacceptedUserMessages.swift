import Foundation
import HappyStore

/// The second half of sync.ts's `hasPendingUserMessage`: a user message the
/// chat reducer still holds (`pending`), delivered but not yet accepted or
/// rejected by the daemon. The first half is this device's outbox.
enum UnacceptedUserMessages {
    /// Folds `records` as the chat does for a session that reports
    /// acceptance, and looks for a user row no receipt has settled.
    /// `records` need only be the session's user text and receipts
    /// (`LocalStore.acceptanceRecords`): nothing else settles a user row.
    static func contains(_ records: [MessageRecord]) -> Bool {
        var reducer = ChatReducer()
        _ = reducer.reduce(records.compactMap(ChatNormalizer.normalize), holdUserMessagesUntilAccepted: true)
        return reducer.messages.contains {
            if case .userText(let row) = $0 { return row.pending }
            return false
        }
    }
}
