import Foundation
import HappyWire

/// newSessionProgress.NewSessionStartPhase; stop returns the composer immediately.
public enum NewSessionStartPhase: String, Sendable {
    case worktree
    case spawning
    case opening
    case avatar
}

/// newSessionProgress.NewSessionPrimaryAction.
public enum NewSessionPrimaryAction: String, Sendable {
    case send
    case stop
    case busy
    case idle
}

/// Pure labels and button states used while starting a session.
public enum NewSessionProgress {
    /// Ports newSessionProgress.resolveNewSessionProgressLabel.
    public static func label(phase: NewSessionStartPhase?, agentName: String, picksWorkspaces: Bool, createsBot: Bool = false) -> String? {
        switch phase {
        case nil: return nil
        case .worktree: return picksWorkspaces ? "Creating workspace…" : "Creating worktree…"
        case .spawning: return createsBot ? "Creating bot…" : "Starting \(agentName)…"
        case .avatar: return "Putting on a face…"
        case .opening: return createsBot ? "Opening bot…" : "Opening session…"
        }
    }

    /// Ports newSessionProgress.resolveNewSessionPrimaryAction.
    public static func primaryAction(canSubmit: Bool, phase: NewSessionStartPhase?, canCancel: Bool) -> NewSessionPrimaryAction {
        if phase != nil { return canCancel ? .stop : .busy }
        return canSubmit ? .send : .idle
    }
}

/// New sessions reuse the same account overrides and CLI gates as Settings.
public enum NewSessionDefaults {
    /// Ports new/index.tsx default picks through shared AgentDefaults.resolve.
    public static func resolve(agent: AgentDefaults.Agent, settings: AccountSettings, cliVersion: String?) -> AgentDefaults.Config {
        AgentDefaults.resolve(settings["agentDefaultOverrides"]?.objectValue ?? [:], agent, cliVersion: cliVersion)
    }
}

/// pendingChats.PendingChat, intentionally memory-only for a start in flight.
public struct PendingChat: Equatable, Sendable {
    /// A failed placeholder retains the anchor to return its screen to.
    public enum Status: Sendable {
        case starting
        case failed
    }
    public var id: String
    public var anchorSessionId: String
    public var sessionId: String?
    public var knownSessionIds: [String]
    public var status: Status
    public var draft: String
    public var queued: [String]
    public var createdAt: Int64
}

/// Per-account placeholder chats; text survives switching away during a spawn.
public actor PendingChats {
    private var chats: [String: PendingChat] = [:]
    private var observers: [UUID: AsyncStream<[String: PendingChat]>.Continuation] = [:]
    private var handovers: Set<String> = []

    public init() {}

    /// Ports pendingChats.isPendingChatId.
    public nonisolated static func isPendingChatId(_ id: String) -> Bool {
        id.hasPrefix("pending-chat:")
    }

    /// Ports pendingChats.openPendingChat.
    public func open(anchorSessionId: String, knownSessionIds: [String]) -> PendingChat {
        let chat = PendingChat(
            id: "pending-chat:\(UUID())", anchorSessionId: anchorSessionId, knownSessionIds: knownSessionIds,
            status: .starting, draft: "", queued: [], createdAt: Int64(Date().timeIntervalSince1970 * 1000)
        )
        chats = chats.filter { $0.value.status != .failed }
        chats[chat.id] = chat
        publish()
        return chat
    }

    /// Ports pendingChats.getPendingChat.
    public func get(id: String) -> PendingChat? {
        chats[id]
    }

    /// Ports pendingChats.usePendingChatRecords.
    public func observe() -> AsyncStream<[String: PendingChat]> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<[String: PendingChat]>.makeStream(bufferingPolicy: .bufferingNewest(1))
        observers[id] = continuation
        continuation.yield(chats)
        continuation.onTermination = { [weak self] _ in Task { await self?.removeObserver(id) } }
        return stream
    }

    /// Ports pendingChats.setPendingChatDraft.
    public func setDraft(id: String, draft: String) {
        guard var chat = chats[id], chat.sessionId == nil, chat.draft != draft else { return }
        chat.draft = draft
        chats[id] = chat
        publish()
    }

    /// Ports pendingChats.submitPendingChat. False when nothing was queued:
    /// the chat has settled (its sends go to the session now), is gone, or
    /// the message is blank.
    @discardableResult
    public func submit(id: String, message: String) -> Bool {
        guard var chat = chats[id], chat.sessionId == nil, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        chat.queued.append(message)
        chat.draft = ""
        chats[id] = chat
        publish()
        return true
    }

    /// Ports pendingChats.settlePendingChat.
    public func settle(id: String, sessionId: String) {
        guard var chat = chats[id], chat.sessionId == nil else { return }
        chat.sessionId = sessionId
        chats[id] = chat
        publish()
    }

    /// Ports pendingChats.failPendingChat.
    public func fail(id: String) {
        guard var chat = chats[id], chat.sessionId == nil else { return }
        chat.status = .failed
        chats[id] = chat
        publish()
    }

    /// Ports pendingChats.dismissPendingChat.
    public func dismiss(id: String) {
        chats.removeValue(forKey: id)
        publish()
    }

    /// Ports pendingChatHandover.handOverPendingChat; send returns true on acceptance.
    public func handOver(
        id: String, sessionId: String, send: @Sendable (String, String) async throws -> Bool,
        writeDraft: @Sendable (String, String) async throws -> Void
    ) async throws {
        guard chats[id]?.sessionId == nil, !handovers.contains(id) else { return }
        handovers.insert(id)
        defer { handovers.remove(id) }
        var sendError: Error?
        var refused = false
        while true {
            while !refused, let message = chats[id]?.queued.first {
                do {
                    if !(try await send(sessionId, message.trimmingCharacters(in: .whitespacesAndNewlines))) {
                        refused = true
                        break
                    }
                } catch {
                    sendError = error
                    refused = true
                    break
                }
                chats[id]?.queued.removeFirst()
            }
            guard let chat = chats[id] else { return }
            let text = Self.join(chat.queued + [chat.draft])
            if !text.isEmpty { try await writeDraft(sessionId, text) }
            // Async persistence may yield to another keystroke or send. Write
            // the newest draft before exposing the real session to observers.
            guard chats[id]?.queued == chat.queued, chats[id]?.draft == chat.draft else { continue }
            settle(id: id, sessionId: sessionId)
            break
        }
        if let sendError { throw sendError }
    }

    /// Ports pendingChatHandover.retirePendingChat and returnPendingChatDraft.
    /// readDraft returns nil only if the anchor session is absent; an existing
    /// anchor with no draft returns "", so its pending writing is preserved.
    public func retire(id: String, readDraft: @Sendable (String) async throws -> String?, writeDraft: @Sendable (String, String) async throws -> Void) async throws {
        guard let chat = chats[id], chat.status != .failed, chat.sessionId == nil, !handovers.contains(id) else { return }
        handovers.insert(id)
        defer { handovers.remove(id) }
        let existing = try await readDraft(chat.anchorSessionId)
        while let latest = chats[id] {
            let text = Self.join(latest.queued + [latest.draft])
            if !text.isEmpty, let existing { try await writeDraft(chat.anchorSessionId, Self.join([text, existing])) }
            if chats[id]?.draft == latest.draft, chats[id]?.queued == latest.queued { break }
        }
        fail(id: id)
    }

    private static func join(_ text: [String]) -> String {
        text.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.joined(separator: "\n\n")
    }

    private func publish() {
        for observer in observers.values { observer.yield(chats) }
    }

    private func removeObserver(_ id: UUID) {
        observers.removeValue(forKey: id)
    }
}
