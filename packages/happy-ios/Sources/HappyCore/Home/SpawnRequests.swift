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
    public static let shared = SpawnRequests()

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
    private let makeId: () -> String

    public init(makeId: @escaping () -> String = { UUID().uuidString.lowercased() }) {
        self.makeId = makeId
    }

    /// `resolveSpawnRequestId`: the same request keeps its key; a changed
    /// one gets a new key and lets the old attempt's session go.
    public func requestId(for signature: Signature) -> String {
        let key = signature.key
        if let pending, pending.signature == key { return pending.clientRequestId }
        let previous = pending
        pending = Pending(signature: key, clientRequestId: makeId())
        previous?.abandon?()
        return pending!.clientRequestId
    }

    /// The session an earlier press of this request already made, so a
    /// failed first message retries it rather than spawning again.
    public func spawnedSessionId(_ clientRequestId: String) -> String? {
        pending?.clientRequestId == clientRequestId ? pending?.sessionId : nil
    }

    /// `rememberSpawnedSession`; `abandon` runs if the request is replaced
    /// before it completes.
    public func remember(_ clientRequestId: String, sessionId: String, abandon: @escaping () -> Void, release: (() -> Void)? = nil) {
        guard pending?.clientRequestId == clientRequestId else {
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
        guard let pending, pending.sessionId == sessionId else { return }
        pending.release?()
        self.pending = nil
    }
}
