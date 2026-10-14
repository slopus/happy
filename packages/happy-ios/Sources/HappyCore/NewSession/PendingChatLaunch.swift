import Foundation
import HappyStore
import HappyWire

// A chat opened from the worktree strip's `+` (WorktreeTabStrip.tsx
// `newTab`, pendingChatHandover.ts, newSessionCheckout.ts): the tab and its
// screen are the person's on the press, the start runs underneath, and the
// chat takes its real identity when the machine answers.

/// Where a `pending-chat:` screen's composer keeps its draft: the record
/// standing in for the chat (`setPendingChatDraft` on every keystroke).
/// Once the chat has settled the record takes no more writes; the composer
/// is retargeted at the session by then.
public struct PendingChatComposerStorage: ComposerStorage {
    private let chats: PendingChats

    public init(_ chats: PendingChats) {
        self.chats = chats
    }

    public func composerValue(sessionId: String) async throws -> ComposerStoreValue {
        ComposerStoreValue(draft: await chats.get(id: sessionId)?.draft ?? "")
    }

    public func saveDraft(sessionId: String, text: String) async throws {
        await chats.setDraft(id: sessionId, draft: text)
    }

    public func composerValues(sessionId: String) -> AsyncThrowingStream<ComposerStoreValue, any Error> {
        let chats = self.chats
        return AsyncThrowingStream { continuation in
            let task = Task {
                var last: String?
                for await records in await chats.observe() {
                    guard !Task.isCancelled else { break }
                    let draft = records[sessionId]?.draft ?? ""
                    guard draft != last else { continue }
                    last = draft
                    continuation.yield(ComposerStoreValue(draft: draft))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// What a `pending-chat:` screen's composer sends through: `submitPendingChat`,
/// which queues the message on the record for the handover to deliver. A
/// submit the record refuses (the chat has settled, or is gone) throws, so
/// the composer keeps the text.
public struct PendingChatSender: ChatSending {
    public struct Refused: Error, Equatable, LocalizedError {
        public init() {}
        public var errorDescription: String? { "This chat is no longer waiting to start" }
    }

    private let chats: PendingChats

    public init(_ chats: PendingChats) {
        self.chats = chats
    }

    public func send(_ message: OutgoingMessage, sessionId: String) async throws -> String {
        guard message.attachments.isEmpty, await chats.submit(id: sessionId, message: message.text) else { throw Refused() }
        return "pending:\(UUID().uuidString.lowercased())"
    }

    /// Queued messages are delivered by the handover, never retried here.
    public func retry(localId: String) async throws {}
    public func discard(localId: String) async throws {}
}

extension NewSessionDraft {
    /// `newSessionLikeSession`: another chat exactly where `session` runs,
    /// started the same way. The directory is the chat's own, so a chat in a
    /// worktree gets a sibling in that worktree; Happy Agent is told its
    /// catalog workspace or project instead. The modes are the chat's own
    /// picks (`picks`, its composer state), and for Happy Agent the ones its
    /// metadata holds; the start falls back to defaults for any the machine
    /// no longer offers. Nothing is typed for it.
    public static func like(_ session: SessionRecord, picks: ComposerPicks) -> (draft: NewSessionDraft, target: HappyAgentSpawnTarget?) {
        let metadata = session.metadata
        let path = (metadata?["path"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let rig = session.isRig
        let flavor = metadata?["flavor"]?.stringValue
        let agent: Agent = rig ? .rig : Agent.allCases.first { $0 != .rig && $0.rawValue == flavor } ?? .claude
        let modelMode = picks.modelMode ?? (rig ? RigCatalog.selectedModelKey(metadata) : nil)
        let permissionMode = picks.permissionMode ?? (rig
            ? metadata?["currentOperatingModeCode"]?.stringValue
                ?? metadata?["permissionMode"]?.stringValue
                ?? metadata?["session"]?["permissionMode"]?.stringValue
            : nil)
        let effortLevel = picks.effortLevel ?? (rig ? RigCatalog.reasoningSelection(metadata, modelKey: modelMode) : nil)
        var target: HappyAgentSpawnTarget?
        if rig {
            if let workspace = metadata?["workspace"]?["id"]?.stringValue {
                target = .workspace(id: workspace)
            } else if let project = metadata?["project"]?["id"]?.stringValue {
                target = .project(id: project)
            }
        }
        let draft = NewSessionDraft(
            selectedMachineId: metadata?["machineId"]?.stringValue,
            selectedPath: path.isEmpty ? nil : NewSessionChoices.relativeToHome(path, homeDir: metadata?["homeDir"]?.stringValue),
            agentType: agent,
            pickedAgentType: agent,
            permissionMode: permissionMode,
            modelMode: modelMode,
            effortLevel: effortLevel,
            sessionType: .simple
        )
        return (draft, target)
    }
}

/// The strip's starts, one at a time and never blocking `+`
/// (WorktreeTabStrip.tsx `enqueueStart`): pressing twice opens two tabs at
/// once and runs the second start behind the first. Kept per account, so a
/// start outlives the screen that asked for it.
///
/// A start that opens its session hands the stand-in over: messages sent
/// meanwhile go out in order, what is left is written as the session's
/// draft, and only then does the record name the session. One that fails,
/// declines or stops gives the writing back to the chat it was opened beside
/// and retires the record, whose screen then goes back there.
@MainActor
public final class PendingChatLauncher {
    public struct Environment {
        public var chats: PendingChats
        /// Starts the chat; its session's id once it is open, nil when the
        /// start failed (and said so) or was declined.
        public var start: @MainActor (PendingChat) async -> String?
        /// `sync.sendMessage`: true when the session took the message.
        public var send: @Sendable (_ sessionId: String, _ text: String) async throws -> Bool
        /// A session's draft; nil when the session is gone.
        public var readDraft: @Sendable (_ sessionId: String) async throws -> String?
        public var writeDraft: @Sendable (_ sessionId: String, _ text: String) async throws -> Void
        /// A message the new session wouldn't take: `Modal.alert`.
        public var reportSendFailure: @MainActor (any Error) -> Void
        /// Stops the start running now (`SessionStarter.cancel`): whatever
        /// the machine hands back later is put down.
        public var cancelStart: @MainActor () -> Void

        public init(
            chats: PendingChats,
            start: @escaping @MainActor (PendingChat) async -> String?,
            send: @escaping @Sendable (String, String) async throws -> Bool,
            readDraft: @escaping @Sendable (String) async throws -> String?,
            writeDraft: @escaping @Sendable (String, String) async throws -> Void,
            reportSendFailure: @escaping @MainActor (any Error) -> Void,
            cancelStart: @escaping @MainActor () -> Void = {}
        ) {
            self.chats = chats
            self.start = start
            self.send = send
            self.readDraft = readDraft
            self.writeDraft = writeDraft
            self.reportSendFailure = reportSendFailure
            self.cancelStart = cancelStart
        }
    }

    private let environment: Environment
    private var queue: Task<Void, Never>?
    private var closed = false

    public init(environment: Environment) {
        self.environment = environment
    }

    /// `openPendingChat` beside `anchorSessionId`, whose checkout holds
    /// `knownSessionIds` right now, with its start queued behind any other.
    public func open(anchorSessionId: String, knownSessionIds: [String]) async -> PendingChat {
        let chat = await environment.chats.open(anchorSessionId: anchorSessionId, knownSessionIds: knownSessionIds)
        enqueue(chat)
        return chat
    }

    /// Resolves once every start asked for so far has settled or failed.
    public func idle() async {
        await queue?.value
    }

    /// The account has stopped. The start running is stopped, and the ones
    /// behind it never begin. Nothing more is written for any of them: the
    /// records go with the account.
    public func close() {
        guard !closed else { return }
        closed = true
        environment.cancelStart()
    }

    private func enqueue(_ chat: PendingChat) {
        let previous = queue
        let environment = self.environment
        queue = Task { @MainActor [weak self] in
            // Settled either way: a start that failed has said so, and must
            // not take the ones behind it down with it.
            await previous?.value
            guard let self, !self.closed else { return }
            let started = await environment.start(chat)
            guard !self.closed else { return }
            if let sessionId = started {
                do {
                    try await environment.chats.handOver(id: chat.id, sessionId: sessionId, send: environment.send, writeDraft: environment.writeDraft)
                } catch {
                    // A send the session declined, or a draft that couldn't
                    // be written: the chat is real all the same, and the
                    // screen standing on it holds what was typed.
                    await environment.chats.settle(id: chat.id, sessionId: sessionId)
                    environment.reportSendFailure(error)
                }
            } else {
                do {
                    try await environment.chats.retire(id: chat.id, readDraft: environment.readDraft, writeDraft: environment.writeDraft)
                } catch {
                    // The writing stays on the record; the tab still has
                    // to stop waiting for a chat that is not coming.
                    await environment.chats.fail(id: chat.id)
                }
            }
        }
    }
}
