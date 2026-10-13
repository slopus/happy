import Foundation
import HappyStore
import HappyWire

/// storage.applySessions.resolveModePick, applied atomically with session metadata.
public enum SessionModesReconciler {
    /// Pending fields keep the local pick. Otherwise an explicit metadata key
    /// wins, including null; an absent key keeps the local pick. Rig v1 owns
    /// its whole draft and is deliberately left to its separate writer.
    public static func reconcile(local: JSONValue, metadata: JSONValue?, pending: Set<String>) -> JSONValue {
        guard !SessionMetadata.isRigV1(metadata) else { return local }
        var values = local.objectValue ?? [:]
        for field in ["permissionMode", "modelMode", "effortLevel"] where !pending.contains(field) {
            if let value = metadata?[field] { values[field] = value }
        }
        return .object(values)
    }

    /// storage.applySessions' whole Rig draft rule, including equal-stamp adoption
    /// and preserving captured picks when a clear echoes before lastMode changes.
    public static func state(
        session: SessionRecord, previous: SessionRecord?, composer: ComposerStateRecord,
        draft: DraftRecord?, pending: Set<String>
    ) -> SessionComposerState {
        var result = SessionComposerState(composer: composer, draft: draft)
        guard session.isRigV1 else {
            result.composer.values = reconcile(local: composer.values, metadata: session.metadata, pending: pending)
            return result
        }
        let remote = session.metadata?["draftUpdatedAt"]?.numberValue
        let local = composer.values["draftUpdatedAt"]?.numberValue
        if let local {
            guard let remote, remote >= local else { return result }
        }
        let mode = session.metadata?["draft"]?.objectValue ?? session.metadata?["lastMode"]?.objectValue
        let text = session.metadata?["draft"]?["text"]?.stringValue
        let keepCleared = composer.values["draftIsNull"]?.boolValue == true && text == nil
            && remote == local && previous?.metadata?["lastMode"] == session.metadata?["lastMode"]
        var values = composer.values.objectValue ?? [:]
        values["draftUpdatedAt"] = remote.map(JSONValue.number) ?? .null
        values["draftIsNull"] = .bool(text == nil)
        if !keepCleared {
            if let provider = mode?["providerId"]?.stringValue, let model = mode?["modelId"]?.stringValue {
                values["modelMode"] = .string("\(provider):\(model)")
            } else { values["modelMode"] = .null }
            values["effortLevel"] = mode?["effort"] ?? .null
            values["permissionMode"] = mode?["permissionMode"] ?? .null
            values["serviceTier"] = mode?["serviceTier"]
        }
        result.composer.values = .object(values)
        if let text, !text.isEmpty {
            let time = remote.flatMap { $0 >= 0 && $0 < Double(Int64.max) ? Int64($0) : nil } ?? session.updatedAt
            result.draft = DraftRecord(sessionId: session.id, text: text, updatedAt: time)
        } else { result.draft = nil }
        return result
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
        { [self] session, previous, composer, draft in
            SessionModesReconciler.state(
                session: session, previous: previous, composer: composer, draft: draft,
                pending: pending(sessionId: session.id)
            )
        }
    }
}
