import Foundation

/// A task the person is about to start: compose opens its conversation
/// empty, and nothing exists on the computer until its first message is
/// sent, which makes the task and then goes into it. Left unsent, it never
/// existed anywhere but here.
///
/// The phone names the task, its workspace and its conversation, so the
/// conversation is the same before and after it is made; the computer
/// takes those names, and the same task ID asked for again answers the
/// same task, so a retry never makes a second one.
public actor NewTask {
    public nonisolated let identity: Identity
    /// The conversation's ID as named here, until the computer gives its own.
    public nonisolated var agentId: String { identity.agentId }

    private let client: AgentClient
    private let mutationId = ClientID.make()
    private var making: Task<String, Error>?
    /// The conversation's ID once the computer has made the task.
    public private(set) var madeAgentId: String?
    private var waiting: [UUID: CheckedContinuation<String, Error>] = [:]

    public init(client: AgentClient, identity: Identity = .make()) {
        self.client = client
        self.identity = identity
    }

    public var isMade: Bool { madeAgentId != nil }

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
        let attempt = Task<String, Error> {
            var tries = 0
            while true {
                do { return try await client.createTask(identity, mutationId: mutationId) }
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
            made(agentId)
            return agentId
        } catch {
            making = nil
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
