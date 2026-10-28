import Foundation
import HappyStore

/// UI-neutral presentation lifecycle. AppKit renders this model; UIKit can
/// adopt it without importing AppKit. Reducers, derivation and diffing stay
/// off main; only immutable row snapshots cross to the view layer.
@MainActor
public final class NativeSessionModel {
    public enum Change { case sessions, conversation(ConversationChanges), status }
    public var onChange: ((Change) -> Void)?
    public private(set) var sessions: [SessionRow] = []
    public private(set) var machines: [MachineRecord] = []
    public private(set) var rows: [ConversationRow] = []
    public private(set) var selectedID: String?
    public private(set) var hasMore = false
    public private(set) var isLoaded = false
    private var account: AccountSession?
    private var homeTask: Task<Void, Never>?
    private var chatTask: Task<Void, Never>?
    private var historyTask: Task<Void, Never>?

    public init() {}

    public func attach(_ account: AccountSession?) {
        homeTask?.cancel(); chatTask?.cancel(); historyTask?.cancel()
        self.account = account
        sessions = []; machines = []; rows = []; selectedID = nil; isLoaded = false
        onChange?(.sessions); onChange?(.conversation(.init(previous: [], next: [])))
        guard let account else { return }
        homeTask = Task.detached { [weak self] in
            for await snapshot in account.homeFeed.snapshots() {
                guard !Task.isCancelled else { break }
                let rows = SessionList(snapshot).items.compactMap { item -> SessionRow? in
                    if case .session(let row) = item { return row }; return nil
                }
                await self?.applyHome(rows, machines: snapshot.machines.machines, account: account)
            }
        }
    }

    private func applyHome(_ rows: [SessionRow], machines: [MachineRecord], account: AccountSession) {
        guard self.account === account else { return }
        guard sessions != rows || self.machines != machines else { return }
        sessions = rows; self.machines = machines; onChange?(.sessions)
    }

    public func select(_ id: String) {
        guard let account, id != selectedID else { return }
        chatTask?.cancel(); historyTask?.cancel()
        selectedID = id; rows = []; isLoaded = false
        onChange?(.conversation(.init(previous: [], next: [])))
        historyTask = Task.detached {
            account.actions.markRead(sessionId: id)
            await account.chatHistory.ensureNewest(sessionId: id)
        }
        chatTask = Task.detached { [weak self] in
            var previous: [ConversationRow] = []
            for await snapshot in account.chatFeed.snapshots(sessionId: id) {
                guard !Task.isCancelled else { break }
                let next = ConversationRow.make(snapshot)
                let changes = ConversationChanges(previous: previous, next: next)
                previous = next
                await self?.applyChat(next, changes: changes, snapshot: snapshot, account: account)
            }
        }
    }

    private func applyChat(_ rows: [ConversationRow], changes: ConversationChanges, snapshot: ChatSnapshot, account: AccountSession) {
        guard self.account === account, selectedID == snapshot.sessionId else { return }
        self.rows = rows; hasMore = snapshot.hasMoreOlder; isLoaded = snapshot.isLoaded
        onChange?(.conversation(changes))
    }

    public func send(_ text: String) async throws {
        guard let account, let id = selectedID else { throw NativeSessionModelError.noSession }
        _ = try await account.sender.send(OutgoingMessage(text: text), sessionId: id)
    }
    public func retry(_ localID: String) async throws {
        guard let account else { throw NativeSessionModelError.noSession }
        try await account.sender.retry(localId: localID)
    }
    public func older() async {
        guard let account, let id = selectedID else { return }
        _ = await account.chatHistory.loadOlder(sessionId: id)
    }
    public func stopTurn() async throws {
        guard let account, let id = selectedID else { return }
        try await account.actions.abort(sessionId: id)
    }
    public func permission(_ id: String, allow: Bool) async throws {
        guard let account, let sessionID = selectedID else { return }
        if allow { try await account.actions.allow(sessionId: sessionID, permissionId: id) }
        else { try await account.actions.deny(sessionId: sessionID, permissionId: id) }
    }
}

public enum NativeSessionModelError: LocalizedError {
    case noSession
    public var errorDescription: String? { "Select a signed-in session before sending a message." }
}