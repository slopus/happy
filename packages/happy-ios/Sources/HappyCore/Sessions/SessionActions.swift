import Foundation
import HappyStore
import HappyWire

/// Calls a method on whatever answers for a session or machine (its CLI or
/// daemon), relayed by the server over the socket as `rpc-call`.
public protocol RPCTransport: Sendable {
    func call(method: String, params: String) async throws -> RPCCallResult
}

extension SocketIOClient: RPCTransport {
    public func call(method: String, params: String) async throws -> RPCCallResult {
        // The server allows a reconnecting daemon a grace period before the
        // call itself, so this waits as long as happy-app does.
        let arguments = try await emitWithAck("rpc-call", .object([
            "method": .string(method),
            "params": .string(params),
        ]), timeout: .seconds(50))
        guard let first = arguments.first else { throw SessionActionError.noAnswer }
        return try first.decode(as: RPCCallResult.self)
    }
}

public enum SessionActionError: Error, Equatable, Sendable {
    /// The session is not in the local store.
    case unknownSession
    /// The session's key cannot be opened, so nothing can be encrypted to it.
    case notDecryptable
    /// The computer never answered the call.
    case noAnswer
    /// A bot is one continuous conversation: only its machine can stop it.
    case botNeedsMachine
    case failed(String)
}

/// What the session list can do to a session, after happy-app's
/// useSessionQuickActions.ts and sync/ops.ts.
public struct SessionActions: Sendable {
    let api: HappyAPI
    let store: LocalStore
    let sync: SyncEngine
    let rpc: RPCTransport
    let now: @Sendable () -> Int64

    public init(
        api: HappyAPI,
        store: LocalStore,
        sync: SyncEngine,
        rpc: RPCTransport,
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.api = api
        self.store = store
        self.sync = sync
        self.rpc = rpc
        self.now = now
    }

    /// Archives a session. The row leaves the live list at once and only
    /// comes back if the archive fails:
    ///   1. ask the session's CLI to stop (`killSession`);
    ///   2. if it can't be reached, mark the session inactive on the server.
    /// A bot can only be stopped by its machine, so step 2 is skipped for it.
    public func archive(sessionId: String) async throws {
        guard let session = try store.session(id: sessionId) else { throw SessionActionError.unknownSession }
        try store.setSessionArchiving(id: sessionId, true)
        do {
            let killed = await kill(sessionId: sessionId)
            if !killed {
                if session.isBot { throw SessionActionError.botNeedsMachine }
                try await api.archiveSession(id: sessionId)
                // The server tells every client with an `activity`
                // ephemeral; apply it here too in case the socket is down.
                try store.applySessionActivity(id: sessionId, active: false, activeAt: now())
            }
        } catch {
            try? store.setSessionArchiving(id: sessionId, false)
            throw error
        }
    }

    /// Deletes a session and its messages for good.
    public func delete(sessionId: String) async throws {
        guard let session = try store.session(id: sessionId) else { throw SessionActionError.unknownSession }
        if session.isBot { throw SessionActionError.botNeedsMachine }
        try await api.deleteSession(id: sessionId)
        try await sync.presence.deleteSession(sessionId)
    }

    public func markRead(sessionId: String) {
        try? store.markSessionRead(id: sessionId)
    }

    // MARK: Chat controls (sync/ops.ts)

    /// Approves a permission request (`sessionAllow`). `mode` is one of
    /// default, acceptEdits, bypassPermissions or plan.
    public func allow(
        sessionId: String,
        permissionId: String,
        mode: String? = nil,
        allowedTools: [String]? = nil,
        decision: ToolPermission.Decision? = nil,
        updatedInput: JSONValue? = nil
    ) async throws {
        _ = try await call(sessionId: sessionId, method: "permission", params: Self.permission(
            id: permissionId, approved: true, mode: mode, allowedTools: allowedTools, decision: decision, updatedInput: updatedInput
        ))
    }

    /// Denies a permission request (`sessionDeny`); `decision` is denied or abort.
    public func deny(
        sessionId: String,
        permissionId: String,
        mode: String? = nil,
        allowedTools: [String]? = nil,
        decision: ToolPermission.Decision? = nil
    ) async throws {
        _ = try await call(sessionId: sessionId, method: "permission", params: Self.permission(
            id: permissionId, approved: false, mode: mode, allowedTools: allowedTools, decision: decision, updatedInput: nil
        ))
    }

    /// Answers a question the agent asked (`sessionAnswerQuestion`), echoing
    /// the `kind` the agent published.
    public func answerQuestion(sessionId: String, id: String, answers: JSONValue, kind: String = "form") async throws {
        _ = try await call(sessionId: sessionId, method: "communication", params: .object([
            "id": .string(id),
            "kind": .string(kind),
            "status": .string("answered"),
            "answers": answers,
        ]))
    }

    /// Dismisses a question without answering (`sessionCancelCommunication`).
    public func cancelQuestion(sessionId: String, id: String, kind: String = "form") async throws {
        _ = try await call(sessionId: sessionId, method: "communication", params: .object([
            "id": .string(id),
            "kind": .string(kind),
            "status": .string("cancelled"),
        ]))
    }

    /// Stops the agent's current turn (`sessionAbort`). Rig sessions take no
    /// reason.
    public func abort(sessionId: String) async throws {
        guard let session = try store.session(id: sessionId) else { throw SessionActionError.unknownSession }
        guard SessionCapabilities.permits(session.metadata, method: "abort") else { throw SessionOpsError.unavailable("Abort is not available for this session") }
        let params: JSONValue = session.isRig ? .object([:]) : .object(["reason": .string(Self.abortReason)])
        _ = try await call(sessionId: sessionId, method: "abort", params: params)
    }

    static let abortReason = "The user doesn't want to proceed with this tool use. "
        + "The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). "
        + "STOP what you are doing and wait for the user to tell you how to proceed."

    /// `SessionPermissionRequest`; absent options are left out, as
    /// JSON.stringify leaves out undefined.
    static func permission(id: String, approved: Bool, mode: String?, allowedTools: [String]?, decision: ToolPermission.Decision?, updatedInput: JSONValue?) -> JSONValue {
        var request: [String: JSONValue] = ["id": .string(id), "approved": .bool(approved)]
        if let mode { request["mode"] = .string(mode) }
        if let allowedTools { request["allowTools"] = .array(allowedTools.map(JSONValue.string)) }
        if let decision { request["decision"] = .string(decision.rawValue) }
        if let updatedInput { request["updatedInput"] = updatedInput }
        return .object(request)
    }

    /// True when the CLI confirmed it stopped.
    private func kill(sessionId: String) async -> Bool {
        do {
            let answer = try await call(sessionId: sessionId, method: "killSession", params: .object([:]))
            return answer?["success"]?.boolValue ?? false
        } catch {
            return false
        }
    }

    /// A session RPC: params and result are sealed with the session's key.
    func call(sessionId: String, method: String, params: JSONValue) async throws -> JSONValue? {
        guard let cipher = try await sync.cipher(forSession: sessionId) else { throw SessionActionError.notDecryptable }
        let result = try await rpc.call(method: "\(sessionId):\(method)", params: try cipher.encrypt(params))
        guard result.ok else { throw SessionActionError.failed(result.error ?? "RPC call failed") }
        return result.result.flatMap(cipher.decrypt(base64:))
    }
}
