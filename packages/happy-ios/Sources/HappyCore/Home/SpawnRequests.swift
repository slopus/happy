import Foundation
import HappyWire

/// The idempotency key of the session being started (sync/spawnRequestId.ts).
///
/// Happy Agent's `spawn-happy-session` dedupes on `clientRequestId`, which
/// is what makes a retry safe: pressing Start again for the same request
/// gets the session the first press made, not a second one. So the key is
/// kept for as long as the request is the same, and replaced once the
/// session is open with its first message, or the request changes.
///
/// In memory only: a key restored days later means nothing to the machine.
@MainActor
public final class SpawnRequests {
    /// The queued starts from chat are independent of the shared Home draft.
    public enum Role: Hashable, Sendable {
        case pendingChats
    }

    /// What the person asked for, as `buildSpawnRequestSignature` spells it.
    public struct Signature: Equatable, Sendable {
        public var machineId: String?
        public var agent: String
        /// The directory, or the project key when only the catalog knows
        /// its folder.
        public var place: String
        public var worktree: String?
        public var modelKey: String?
        public var permissionMode: String?
        public var effort: String?
        /// The bot being made: its name and the face it will wear.
        public var bot: (name: String, faceSeed: String)?

        public init(machineId: String?, agent: String, place: String, worktree: String?, modelKey: String?, permissionMode: String?, effort: String?, bot: (name: String, faceSeed: String)? = nil) {
            self.machineId = machineId
            self.agent = agent
            self.place = place
            self.worktree = worktree
            self.modelKey = modelKey
            self.permissionMode = permissionMode
            self.effort = effort
            self.bot = bot
        }

        public static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.key == rhs.key
        }

        /// The JSON array happy-app compares.
        var key: String {
            let value = JSONValue.array([
                .string(machineId ?? ""),
                .string(agent),
                .string(place),
                .string(worktree ?? ""),
                .string(modelKey ?? ""),
                .string(permissionMode ?? ""),
                .string(effort ?? ""),
                bot.map { .array([.string($0.name), .string($0.faceSeed)]) } ?? .string(""),
            ])
            return (try? value.encodedString()) ?? ""
        }
    }

    private struct Pending {
        var signature: String
        var clientRequestId: String
        var sessionId: String?
        var abandon: (() -> Void)?
        var release: (() -> Void)?
    }

    private var pending: Pending?
    private let makeId: @MainActor @Sendable () -> String
    private let role: Role?
    private var children: [Role: SpawnRequests] = [:]
    private var attempts: [UUID: () -> Void] = [:]
    public private(set) var isClosed = false

    public nonisolated init(makeId: @escaping @MainActor @Sendable () -> String = { UUID().uuidString.lowercased() }) {
        self.makeId = makeId
        role = nil
    }

    private nonisolated init(role: Role, makeId: @escaping @MainActor @Sendable () -> String) {
        self.role = role
        self.makeId = makeId
    }

    /// One persistent slot per role, owned by this account's root. A child
    /// closed independently remains closed; looking it up cannot resurrect it.
    /// UI teardown cancels its starter; only the account root closes this slot.
    public func child(_ role: Role) -> SpawnRequests {
        if self.role == role { return self }
        if let existing = children[role] { return existing }
        let child = SpawnRequests(role: role, makeId: makeId)
        guard !isClosed else { child.close(); return child }
        children[role] = child
        return child
    }

    /// Cancels starts before they have a session to remember. The starter
    /// removes its registration when the attempt unwinds.
    func registerAttempt(_ cancel: @escaping () -> Void) -> UUID? {
        guard !isClosed else { return nil }
        let id = UUID()
        attempts[id] = cancel
        return id
    }

    func removeAttempt(_ id: UUID) {
        attempts.removeValue(forKey: id)
    }

    /// An account session never reopens this scope. Late spawn replies can
    /// clean up through their original account, but cannot restore its state.
    public func close() {
        guard !isClosed else { return }
        isClosed = true
        let previous = pending
        pending = nil
        let cancellations = Array(attempts.values)
        attempts.removeAll()
        let descendants = Array(children.values)
        children.removeAll()
        for child in descendants { child.close() }
        for cancel in cancellations { cancel() }
        previous?.abandon?()
    }

    /// `resolveSpawnRequestId`: the same request keeps its key; a changed
    /// one gets a new key and lets the old attempt's session go.
    public func requestId(for signature: Signature) -> String {
        // Preserve the API for late callers without retaining private state.
        // SessionStarter refuses closed scopes before requesting a key.
        guard !isClosed else { return makeId() }
        let key = signature.key
        if let pending, pending.signature == key { return pending.clientRequestId }
        let previous = pending
        let id = makeId()
        pending = Pending(signature: key, clientRequestId: id)
        previous?.abandon?()
        return id
    }

    /// The session an earlier press of this request already made, so a
    /// failed first message retries it rather than spawning again.
    public func spawnedSessionId(_ clientRequestId: String) -> String? {
        pending?.clientRequestId == clientRequestId ? pending?.sessionId : nil
    }

    /// `rememberSpawnedSession`; `abandon` runs if the request is replaced
    /// before it completes.
    public func remember(_ clientRequestId: String, sessionId: String, abandon: @escaping () -> Void, release: (() -> Void)? = nil) {
        guard !isClosed, pending?.clientRequestId == clientRequestId else {
            abandon()
            return
        }
        pending?.sessionId = sessionId
        pending?.abandon = abandon
        pending?.release = release
    }

    /// The session is open with its message, or the person stopped: the
    /// next press starts afresh. Without an id, whatever is pending ends.
    public func complete(_ clientRequestId: String? = nil) {
        if clientRequestId == nil || pending?.clientRequestId == clientRequestId { pending = nil }
    }

    /// `releaseSpawnedSession`: a session opened or written to elsewhere is
    /// no longer an abandoned attempt.
    public func release(sessionId: String) {
        let descendants = Array(children.values)
        if let pending, pending.sessionId == sessionId {
            pending.release?()
            self.pending = nil
        }
        for child in descendants { child.release(sessionId: sessionId) }
    }
}
