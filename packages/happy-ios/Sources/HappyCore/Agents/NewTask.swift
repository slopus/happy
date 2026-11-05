import Foundation

/// A task or bot the person is about to start: compose opens its
/// conversation empty, and nothing exists on the computer until its first
/// message is sent, which makes it, as the kind and name chosen then say,
/// and then goes into it. Left unsent, it never existed anywhere but here.
///
/// The phone names the task, its workspace and its conversation, so the
/// conversation is the same before and after it is made; the computer
/// takes those names, and the same task ID asked for again answers the
/// same task, so a retry never makes a second one.
public actor NewTask {
    public enum Kind: String, Equatable, Sendable {
        case task
        case bot
    }

    /// What it will be made as: a task unless a bot was chosen, and the
    /// name given, blank for the computer to name it from its first message.
    public struct Choice: Equatable, Sendable {
        public var kind: Kind
        public var name: String

        public init(kind: Kind = .task, name: String = "") {
            self.kind = kind
            self.name = name
        }
    }

    public nonisolated let identity: Identity
    /// The conversation's ID as named here, until the computer gives its own.
    public nonisolated var agentId: String { identity.agentId }

    private let client: AgentClient
    private let mutationId = ClientID.make()
    private var making: Task<String, Error>?
    /// The conversation's ID once the computer has made the task.
    public private(set) var madeAgentId: String?
    private var waiting: [UUID: CheckedContinuation<String, Error>] = [:]
    /// Set on the main thread as it is chosen, read when it is made: kept
    /// with the unsent work, so compose again opens it as it was left.
    private nonisolated let chosen = Chosen()

    public init(client: AgentClient, identity: Identity = .make()) {
        self.client = client
        self.identity = identity
    }

    public var isMade: Bool { madeAgentId != nil }

    /// The kind and name as last chosen.
    public nonisolated var choice: Choice {
        get { chosen.value }
        set { chosen.value = newValue }
    }

    /// Makes the task on the computer, once: a second ask while the first
    /// is on its way shares it, and one after it was made answers at once.
    /// A failure is thrown to the ask that made it, and the next ask tries
    /// again under the same names.
    public func make() async throws -> String {
        if let madeAgentId { return madeAgentId }
        if let making { return try await making.value }
        let client = client
        let identity = identity
        let mutationId = mutationId
        let choice = choice
        let attempt = Task<String, Error> {
            var tries = 0
            while true {
                do {
                    switch choice.kind {
                    case .task: return try await client.createTask(identity, mutationId: mutationId, name: choice.name)
                    case .bot: return try await client.createBot(identity, mutationId: mutationId, name: choice.name)
                    }
                }
                catch let error as AgentClientError where (error.status ?? 500) < 500 { throw error }
                catch {
                    tries += 1
                    if tries == 3 { throw error }
                    try await Task.sleep(for: .milliseconds(500 * tries))
                }
            }
        }
        making = attempt
        do {
            let agentId = try await attempt.value
            // Only the first answer gets here; later sends read `madeAgentId`.
            Happenings.post(.newWorkMade(choice.kind, .made))
            made(agentId)
            return agentId
        } catch {
            making = nil
            if !(error is CancellationError) { Happenings.post(.newWorkMade(choice.kind, .failed(error))) }
            throw error
        }
    }

    /// Waits until the task is made, for the conversation to follow it.
    /// Cancelled, it throws.
    public func made() async throws -> String {
        if let madeAgentId { return madeAgentId }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()) }
                else { waiting[id] = continuation }
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    private func made(_ agentId: String) {
        guard madeAgentId == nil else { return }
        madeAgentId = agentId
        making = nil
        let waiters = waiting.values
        waiting = [:]
        for waiter in waiters { waiter.resume(returning: agentId) }
    }

    private func cancel(_ id: UUID) {
        waiting.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }
}

private final class Chosen: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = NewTask.Choice()

    var value: NewTask.Choice {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}
