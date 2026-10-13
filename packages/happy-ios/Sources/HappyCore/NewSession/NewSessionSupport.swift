import Foundation
import HappyWire

public enum NewSessionStartPhase: String, Sendable { case worktree, spawning, opening, avatar }
public enum NewSessionPrimaryAction: String, Sendable { case send, stop, busy, idle }
public enum NewSessionProgress {
    /// Ports newSessionProgress.resolveNewSessionProgressLabel.
    public static func label(phase: NewSessionStartPhase?, agentName: String, picksWorkspaces: Bool, createsBot: Bool = false) -> String? { nil }
    /// Ports newSessionProgress.resolveNewSessionPrimaryAction.
    public static func primaryAction(canSubmit: Bool, phase: NewSessionStartPhase?, canCancel: Bool) -> NewSessionPrimaryAction { .idle }
}
public enum NewSessionDefaults {
    /// Ports new/index.tsx default picks through shared AgentDefaults.resolve.
    public static func resolve(agent: AgentDefaults.Agent, settings: AccountSettings, cliVersion: String?) -> AgentDefaults.Config {
        AgentDefaults.resolve([:], agent, cliVersion: cliVersion)
    }
}
public struct PendingChat: Equatable, Sendable {
    public enum Status: Sendable { case starting, failed }
    public var id: String
    public var anchorSessionId: String
    public var sessionId: String?
    public var knownSessionIds: [String]
    public var status: Status
    public var draft: String
    public var queued: [String]
    public var createdAt: Int64
}
public actor PendingChats {
    public init() {}
    /// Ports pendingChats.isPendingChatId.
    public nonisolated static func isPendingChatId(_ id: String) -> Bool { id.hasPrefix("pending-chat:") }
    /// Ports pendingChats.openPendingChat.
    public func open(anchorSessionId: String, knownSessionIds: [String]) -> PendingChat {
        PendingChat(id: "pending-chat:\(UUID())", anchorSessionId: anchorSessionId, knownSessionIds: knownSessionIds, status: .starting, draft: "", queued: [], createdAt: 0)
    }
    /// Ports pendingChats.getPendingChat.
    public func get(id: String) -> PendingChat? { nil }
    /// Ports pendingChats.usePendingChatRecords.
    public func observe() -> AsyncStream<[String: PendingChat]> { AsyncStream { $0.yield([:]); $0.finish() } }
    /// Ports pendingChats.setPendingChatDraft.
    public func setDraft(id: String, draft: String) {}
    /// Ports pendingChats.submitPendingChat.
    public func submit(id: String, message: String) {}
    /// Ports pendingChats.settlePendingChat.
    public func settle(id: String, sessionId: String) {}
    /// Ports pendingChats.failPendingChat.
    public func fail(id: String) {}
    /// Ports pendingChats.dismissPendingChat.
    public func dismiss(id: String) {}
    /// Ports pendingChatHandover.handOverPendingChat; send returns true on acceptance.
    public func handOver(id: String, sessionId: String, send: @Sendable (String, String) async throws -> Bool, writeDraft: @Sendable (String, String) async throws -> Void) async throws { throw SessionOpsError.notImplemented }
    /// Ports pendingChatHandover.retirePendingChat and returnPendingChatDraft.
    public func retire(id: String, readDraft: @Sendable (String) async throws -> String?, writeDraft: @Sendable (String, String) async throws -> Void) async throws { throw SessionOpsError.notImplemented }
}