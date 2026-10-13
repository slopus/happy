#if canImport(UIKit)
import HappyCore
import HappyStore
import UIKit

/// The worktree strip's starts for one account (`PendingChatLauncher`): a
/// starter of their own, so the dock's or the new-session screen's start
/// is never refused for being busy, and errors shown over whatever is on
/// screen when they land, as `Modal.alert` does. Kept with the account, not
/// with a screen: a start outlives the tab that asked for it.
@MainActor
final class ChatPendingStarts: NSObject {
    private static let table = NSMapTable<AccountSession, ChatPendingStarts>.weakToStrongObjects()

    static func of(_ account: AccountSession) -> ChatPendingStarts {
        if let existing = table.object(forKey: account) { return existing }
        let starts = ChatPendingStarts(account)
        table.setObject(starts, forKey: account)
        return starts
    }

    private(set) var launcher: PendingChatLauncher!
    private let starter: SessionStarter

    /// Holds what it needs from the account, never the account itself: the
    /// table keys on it weakly.
    private init(_ account: AccountSession) {
        starter = SessionStarter.make(for: account)
        super.init()
        starter.presenter = self
        let store = account.store
        let sender = account.sender
        launcher = PendingChatLauncher(environment: .init(
            chats: account.pendingChats,
            start: { [weak self] chat in
                await self?.start(chat, store: store) ?? nil
            },
            send: { sessionId, text in
                _ = try await sender.send(OutgoingMessage(text: text, source: .newSession), sessionId: sessionId)
                return true
            },
            readDraft: { sessionId in
                guard try store.session(id: sessionId) != nil else { return nil }
                return try sender.composerValue(sessionId: sessionId).draft
            },
            writeDraft: { sessionId, text in
                try sender.saveDraft(sessionId: sessionId, text: text)
            },
            reportSendFailure: { [weak self] error in
                self?.showStartError((error as? LocalizedError)?.errorDescription ?? Strings.Chat.firstMessageFailed)
            }
        ))
    }

    /// `newSessionLikeSession` for the chat the stand-in was opened beside,
    /// resolved against the computers as they are now, then started.
    private func start(_ chat: PendingChat, store: LocalStore) async -> String? {
        let anchorId = chat.anchorSessionId
        let read = await Task.detached(priority: .userInitiated) { () -> (HomeSnapshot, SessionRecord, ComposerPicks)? in
            guard let snapshot = try? store.homeSnapshot(),
                  let anchor = snapshot.sessions.first(where: { $0.id == anchorId })
            else { return nil }
            let picks = ComposerPicks(values: (try? store.composerState(sessionId: anchorId))?.values)
            return (snapshot, anchor, picks)
        }.value
        guard let (snapshot, anchor, picks) = read else {
            showStartError(Strings.SessionDetail.sessionDeleted)
            return nil
        }
        let like = NewSessionDraft.like(anchor, picks: picks)
        let resolved = NewSessionLaunch.resolve(
            draft: like.draft,
            pickedAgent: like.draft.agentType,
            machines: snapshot.machines.machines,
            sessions: snapshot.sessions,
            agentDefaultOverrides: AccountSettings(snapshot.settings).agentDefaultOverrides,
            prompt: "",
            attachments: [],
            target: like.target.map { .some($0) }
        )
        switch resolved {
        case .failure(let refusal):
            showStartError(refusal.errorDescription ?? Strings.Chat.firstMessageFailed)
            return nil
        case .success(let launch):
            return await starter.start(launch, isCurrentTarget: { true })
        }
    }

    /// The topmost screen of the app's window.
    private var presenting: UIViewController? {
        let window = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first
        guard var top = window?.rootViewController else { return nil }
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        return top
    }
}

extension ChatPendingStarts: SessionStarterPresenter {
    func showStartError(_ message: String) {
        guard let controller = presenting else { return }
        Alerts.show(Strings.Common.error, message, on: controller)
    }

    /// The chat's own directory exists; if it has gone, nothing is created
    /// behind the person's back.
    func confirmDirectoryCreation(_ directory: String) async -> Bool {
        guard let controller = presenting else { return false }
        return await Alerts.confirm(
            Strings.Home.createDirectoryTitle,
            Strings.Home.createDirectoryMessage(directory),
            confirmTitle: Strings.Home.create,
            on: controller
        )
    }

    /// Never asked: the strip starts no bots.
    func offerBotFaceRetry(_ message: String) async -> Bool { false }

    /// Never asked: the strip's starts carry no pictures.
    func showAttachmentsNotSupported() {}
}
#endif
