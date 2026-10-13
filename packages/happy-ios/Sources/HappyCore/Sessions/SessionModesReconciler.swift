import Foundation
import HappyStore
import HappyWire

/// storage.applySessions.resolveModePick, applied atomically with session metadata.
public enum SessionModesReconciler {
    /// Pending fields keep the local pick. Otherwise an explicit metadata key
    /// wins, including null; an absent key keeps the local pick. Rig v1 owns
    /// its whole draft and is deliberately left to its separate writer.
    public static func reconcile(local: JSONValue, metadata: JSONValue?, pending: Set<String>) -> JSONValue {
        guard !SessionCapabilities.rigV1(metadata) else { return local }
        var values = local.objectValue ?? [:]
        for field in ["permissionMode", "modelMode", "effortLevel"] where !pending.contains(field) {
            if let value = metadata?[field] { values[field] = value }
        }
        return .object(values)
    }
}

/// agentModesPending.ts counters, instantiated once by each account's SyncEngine.
/// The lock lets the store sample pending fields inside its synchronous transaction.
final class SessionModePushCounters: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: [String: Int]] = [:]

    func mark(sessionId: String, fields: [String]) {
        lock.withLock {
            for field in fields { counts[sessionId, default: [:]][field, default: 0] += 1 }
        }
    }

    func clear(sessionId: String, fields: [String]) {
        lock.withLock {
            for field in fields {
                let count = counts[sessionId]?[field] ?? 0
                if count > 1 { counts[sessionId]?[field] = count - 1 }
                else { counts[sessionId]?.removeValue(forKey: field) }
            }
            if counts[sessionId]?.isEmpty == true { counts.removeValue(forKey: sessionId) }
        }
    }

    func pending(sessionId: String) -> Set<String> {
        lock.withLock { Set((counts[sessionId] ?? [:]).filter { $0.value > 0 }.keys) }
    }

    var reconciliation: SessionComposerReconciliation {
        { [self] session, composer in
            var next = composer
            next.values = SessionModesReconciler.reconcile(local: composer.values, metadata: session.metadata, pending: pending(sessionId: session.id))
            return next
        }
    }
}