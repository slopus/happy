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
    /// A task lives like a bot: only its machine can stop it.
    case taskNeedsMachine
    case failed(String)
}

extension SessionActionError {
    /// The machine or server can't be reached, which may be this phone.
    var meansUnreachable: Bool {
        switch self {
        case .noAnswer, .botNeedsMachine, .taskNeedsMachine: true
        case .unknownSession, .notDecryptable, .failed: false
        }
    }

    /// As kept in an `IntentRefusal`, and read back by `init(refusal:)`.
    var refusalReason: String {
        switch self {
        case .unknownSession: "unknownSession"
        case .notDecryptable: "notDecryptable"
        case .noAnswer: "noAnswer"
        case .botNeedsMachine: "botNeedsMachine"
        case .taskNeedsMachine: "taskNeedsMachine"
        case .failed(let reason): "failed:" + reason
        }
    }

    public init(refusal reason: String) {
        switch reason {
        case "unknownSession": self = .unknownSession
        case "notDecryptable": self = .notDecryptable
        case "noAnswer": self = .noAnswer
        case "botNeedsMachine": self = .botNeedsMachine
        case "taskNeedsMachine": self = .taskNeedsMachine
        case let reason where reason.hasPrefix("failed:"): self = .failed(String(reason.dropFirst("failed:".count)))
        default: self = .failed(reason)
        }
    }
}

/// What the session list can do to a session, after happy-app's
/// useSessionQuickActions.ts and sync/ops.ts.
public struct SessionActions: Sendable {
    let api: HappyAPI
    let store: LocalStore
    let sync: LegacySyncEngine
    let rpc: RPCTransport
    let now: @Sendable () -> Int64

    public init(
        api: HappyAPI,
        store: LocalStore,
        sync: LegacySyncEngine,
        rpc: RPCTransport,
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.api = api
        self.store = store
        self.sync = sync
        self.rpc = rpc
        self.now = now
    }

    /// Archives a session (docs/offline-first.md). The row leaves the live
    /// list at once, kept so through a relaunch, and comes back only if
    /// the machine or server refuses; offline, it goes when the account is
    /// back. One try (`deliverArchive`):
    ///   1. ask the session's CLI to stop (`killSession`);
    ///   2. if it can't be reached, mark the session inactive on the server.
    /// A bot or a task can only be stopped by its machine, so step 2 is
    /// skipped for it.
    public func archive(sessionId: String) async throws {
        guard try store.session(id: sessionId) != nil else { throw SessionActionError.unknownSession }
        // Kept before it shows: killed between the two, the next launch
        // still keeps the row out (`LocalStore.removalPending`).
        let intent = try await sync.intents.enqueue(.archive, target: sessionId)
        try store.setSessionArchiving(id: sessionId, true)
        try await settle(intent)
    }

    /// Deletes a session and its messages for good: gone here at once, and
    /// from the server now or once it can be reached. A list read
    /// meanwhile doesn't bring it back (`LocalStore.deletePending`).
    public func delete(sessionId: String) async throws {
        guard let session = try store.session(id: sessionId) else { throw SessionActionError.unknownSession }
        if let refusal = Self.needsMachine(session) { throw refusal }
        let intent = try await sync.intents.enqueue(.delete, target: sessionId)
        try await sync.presence.deleteSession(sessionId)
        try await settle(intent)
    }

    /// One try now, for whoever waits on the action: nothing while it
    /// stands (taken, or kept to go later), the refusal otherwise, with
    /// the row put back.
    private func settle(_ intent: Intent) async throws {
        let verdict = await sync.intents.attempt(intent.id, through: { try await self.deliver($0) })
        guard case .refused(let reason) = verdict else { return }
        await sync.rollBack(intent)
        throw SessionActionError(refusal: reason)
    }

    /// One try of a kept archive, leave or delete, for `IntentOutbox`: a
    /// refusal is an `IntentRefusal`, anything else goes again later.
    public func deliver(_ intent: Intent) async throws {
        do {
            switch intent.kind {
            case .archive: try await deliverArchive(intent.target)
            case .leave: try await deliverLeave(intent.target)
            case .delete: try await api.deleteSession(id: intent.target)
            default: return
            }
        } catch let error as SessionActionError {
            // The machine looked unreachable because this phone is: it
            // goes once the account is back.
            if error.meansUnreachable, !(await sync.reachable) { throw URLError(.notConnectedToInternet) }
            throw IntentRefusal(error.refusalReason)
        } catch APIError.http(status: 404, _) {
            // Gone already: nothing left to do.
        } catch APIError.http(let status, _) where (400..<500).contains(status) && status != 408 && status != 429 {
            throw IntentRefusal(SessionActionError.failed("").refusalReason)
        }
    }

    private func deliverArchive(_ sessionId: String) async throws {
        guard let session = try store.session(id: sessionId) else { return }
        // A task's machine may refuse its archive (only its owner may);
        // the refusal is shown as it says it.
        let killed = try await kill(sessionId: sessionId, reportsRefusal: session.isTask)
        if !killed {
            if let refusal = Self.needsMachine(session) { throw refusal }
            try await api.archiveSession(id: sessionId)
            // The server tells every client with an `activity`
            // ephemeral; apply it here too in case the socket is down.
            try store.applySessionActivity(id: sessionId, active: false, activeAt: now())
        }
    }

    /// A bot or a task is one conversation for life: the server may neither
    /// mark it inactive nor delete it; only its machine archives it.
    static func needsMachine(_ session: SessionRecord) -> SessionActionError? {
        if session.isBot { return .botNeedsMachine }
        if session.isTask { return .taskNeedsMachine }
        return nil
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
    /// `reportsRefusal`: a machine that answered no throws its reason
    /// (`{ error }`, as Happy Agent answers a handler that threw) instead of
    /// reading as unreachable. The relay's own failures (`ok: false`: no
    /// such method registered, target gone, timeout) still mean the machine
    /// can't be reached.
    private func kill(sessionId: String, reportsRefusal: Bool = false) async throws -> Bool {
        let answer: JSONValue?
        do {
            answer = try await call(sessionId: sessionId, method: "killSession", params: .object([:]))
        } catch {
            return false
        }
        if answer?["success"]?.boolValue == true { return true }
        if reportsRefusal, let refusal = Self.refusal(answer) { throw SessionActionError.failed(refusal) }
        return false
    }

    /// What Happy Agent said when it refused: `error`, else `message`.
    static func refusal(_ answer: JSONValue?) -> String? {
        for key in ["error", "message"] {
            if let text = answer?[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty { return text }
        }
        return nil
    }

    /// Leaves a task: it goes from the paired person's list and their Happy
    /// Agent retires its session from this account; the task runs on for
    /// everyone else. Only `leaveTask`: never an archive or a delete. The
    /// row leaves at once, kept as an archive is, and comes back if the
    /// machine refuses.
    public func leaveTask(sessionId: String) async throws {
        guard let session = try store.session(id: sessionId), session.isTask else { throw SessionActionError.unknownSession }
        let intent = try await sync.intents.enqueue(.leave, target: sessionId)
        try store.setSessionArchiving(id: sessionId, true)
        try await settle(intent)
    }

    private func deliverLeave(_ sessionId: String) async throws {
        guard try store.session(id: sessionId) != nil else { return }
        let answer: JSONValue?
        do {
            answer = try await call(sessionId: sessionId, method: "leaveTask", params: .object([:]))
        } catch SessionActionError.notDecryptable {
            throw SessionActionError.notDecryptable
        } catch {
            throw SessionActionError.taskNeedsMachine
        }
        guard answer?["success"]?.boolValue == true else {
            let refusal = Self.refusal(answer)
            // An older Happy Agent that has no such method.
            throw SessionActionError.failed(refusal == "Method not found" ? Self.cannotLeaveTasks : refusal ?? "")
        }
    }

    static let cannotLeaveTasks = "Happy Agent on this computer cannot leave tasks yet. Update it and try again."

    /// A session RPC: params and result are sealed with the session's key.
    func call(sessionId: String, method: String, params: JSONValue) async throws -> JSONValue? {
        guard let cipher = try await sync.cipher(forSession: sessionId) else { throw SessionActionError.notDecryptable }
        let result = try await rpc.call(method: "\(sessionId):\(method)", params: try cipher.encrypt(params))
        guard result.ok else { throw SessionActionError.failed(result.error ?? "RPC call failed") }
        return result.result.flatMap(cipher.decrypt(base64:))
    }
}
