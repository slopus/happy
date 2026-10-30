#if canImport(UIKit)
import HappyCore
import UIKit

/// The Chief of Staff's conversation, opened with an ask already typed in
/// for the person: Settings' "change this connection's name" and "change
/// its avatar" are a sentence the Chief of Staff can answer, so they are
/// asked for in the conversation rather than in a form.
///
/// The words are unsent. The person finishes the sentence, or deletes it,
/// and sends it themselves (`ChatPrefill`).
@MainActor
enum ChiefOfStaffAsk {
    /// The conversation to push, or nil where this account has no Chief of
    /// Staff running: the action is not offered then, rather than opening
    /// something that cannot answer.
    static func chat(session: Session, snapshot: Snapshot, ask: ChatPrefill) -> UIViewController? {
        guard let agentId = snapshot.happyAgentId else { return nil }
        let row = snapshot.rows.first { $0.agentId == agentId } ?? snapshot.allRows.first { $0.agentId == agentId }
        session.warm.tap(agentId)
        return ChatViewController(
            session: session,
            agentId: agentId,
            title: row?.label ?? Strings.Start.logo,
            spaceId: row?.spaceId,
            seedling: nil,
            prefill: ask
        )
    }
}
#endif
