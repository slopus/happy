#if canImport(UIKit)
import HappyCore
import UIKit

/// The Chief of Staff's conversation, opened with an ask already typed in
/// for the person: Settings' "Change agent name" and "Change agent avatar"
/// are a sentence the Chief of Staff can answer, so they are asked for in
/// the conversation rather than in a form.
///
/// The words are unsent. The person finishes the sentence, or deletes it,
/// and sends it themselves (`ChatPrefill`).
@MainActor
enum ChiefOfStaffAsk {
    /// The conversation to push, or nil where this account has no Chief of
    /// Staff to be found: the active `chief_of_staff` bot's, else the
    /// sidebar's Happy row's.
    static func chat(session: Session, snapshot: Snapshot, ask: ChatPrefill) -> UIViewController? {
        let happy = snapshot.rows.first { $0.isHappy && $0.agentId != nil } ?? snapshot.allRows.first { $0.isHappy && $0.agentId != nil }
        guard let agentId = snapshot.happyAgentId ?? happy?.agentId else { return nil }
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

    /// Pushes the Chief of Staff's conversation over `controller` with
    /// `ask` typed in. With none to be found, the same words open a new
    /// task instead, as home's compose opens it.
    static func open(_ ask: ChatPrefill, session: Session, from controller: UIViewController) {
        guard !opening, let navigation = controller.navigationController else { return }
        if let chat = chat(session: session, snapshot: session.snapshot, ask: ask) {
            navigation.pushViewController(chat, animated: true)
            return
        }
        opening = true
        let store = session.store
        Task { @MainActor in
            defer { opening = false }
            let task = await store.newTask()
            // Gone from the screen meanwhile: nothing is pushed over another.
            guard navigation.topViewController === controller else { return }
            Haptics.play(.newWork)
            navigation.pushViewController(NewWork.chat(session, task: task, prefill: ask), animated: true)
        }
    }

    /// A new task on its way for an ask: a second tap meanwhile opens none.
    private static var opening = false
}
#endif
