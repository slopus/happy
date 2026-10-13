import Foundation
import HappyStore
import HappyWire

/// Machine-scoped ops.ts operations, using each stored machine's data key.
public struct MachineActions: Sendable {
    let api: HappyAPI
    let store: LocalStore
    let sync: SyncEngine
    let rpc: any RPCTransport
    let metadataTransport: any MetadataUpdateTransport

    public init(api: HappyAPI, store: LocalStore, sync: SyncEngine, rpc: any RPCTransport, metadataTransport: any MetadataUpdateTransport) {
        self.api = api
        self.store = store
        self.sync = sync
        self.rpc = rpc
        self.metadataTransport = metadataTransport
    }

    /// Ports ops.ts machineSpawnNewSession.
    public func machineSpawnNewSession(options: SpawnSessionOptions) async -> SpawnSessionResult {
        do { return Self.normalizeSpawnSessionResult(try await call(machineId: options.machineId, method: "spawn-happy-session", params: Self.spawnPayload(options))) }
        catch { return .error(errorMessage: opsError(error)) }
    }

    /// Ports ops.ts normalizeSpawnSessionResult.
    public static func normalizeSpawnSessionResult(_ result: JSONValue) -> SpawnSessionResult {
        switch result["type"]?.stringValue {
        case "success": if let id = result["sessionId"]?.stringValue { return .success(sessionId: id) }
        case "pending":
            if let id = result["clientRequestId"]?.stringValue, let delay = result["retryAfterMs"]?.numberValue,
               delay.isFinite, delay >= 0, delay < Double(Int.max) {
                return .pending(clientRequestId: id, retryAfterMs: Int(delay))
            }
        case "requestToApproveDirectoryCreation": if let path = result["directory"]?.stringValue { return .requestToApproveDirectoryCreation(directory: path) }
        case "error":
            let message = [result["errorMessage"]?.stringValue, result["message"]?.stringValue]
                .compactMap { $0 }.first { !$0.isEmpty } ?? "Failed to spawn session"
            return .error(errorMessage: message)
        default: break
        }
        return .error(errorMessage: "The machine answered with something Happy could not read.")
    }

    /// Ports ops.ts machineResumeSession, including the encrypted fallback.
    public func machineResumeSession(machineId: String, sessionId: String, model: String? = nil, permissionMode: String? = nil) async -> SpawnSessionResult {
        do {
            var params: [String: JSONValue] = ["sessionId": .string(sessionId)]
            params.set("model", model)
            params.set("permissionMode", permissionMode)
            let fallback = try await resumeFallback(sessionId: sessionId, machineId: machineId)
            params["fallbackReason"] = .string(fallback.reason)
            if let value = fallback.payload { params["fallback"] = value }
            let result = try await call(machineId: machineId, method: "resume-happy-session", params: .object(params))
            if let error = result["error"]?.stringValue { return .error(errorMessage: error) }
            return Self.normalizeSpawnSessionResult(result)
        } catch { return .error(errorMessage: opsError(error)) }
    }

    /// Ports ops.ts machineStopSession.
    public func machineStopSession(machineId: String, sessionId: String) async -> MachineOperationResult {
        do {
            let result = try await call(machineId: machineId, method: "stop-session", params: .object(["sessionId": .string(sessionId)]))
            return MachineOperationResult(success: true, message: result["message"]?.stringValue)
        } catch { return MachineOperationResult(success: false, message: opsError(error)) }
    }

    /// Ports ops.ts machineStopDaemon.
    public func machineStopDaemon(machineId: String) async throws -> MachineStopDaemonResult {
        try opsDecode(await call(machineId: machineId, method: "stop-daemon", params: .object([:])))
    }

    /// Ports ops.ts machineDelete.
    public func machineDelete(machineId: String) async -> MachineOperationResult {
        do {
            try await api.deleteMachine(id: machineId)
            try await sync.presence.deleteMachine(machineId)
            return MachineOperationResult(success: true)
        } catch { return MachineOperationResult(success: false, message: opsError(error)) }
    }

    /// Ports ops.ts machineBash.
    /// Never throws: transport failures become success=false, as in ops.ts.
    public func machineBash(machineId: String, command: String, cwd: String) async throws -> SessionBashResponse {
        do { return try opsDecode(await call(machineId: machineId, method: "bash", params: .object(["command": .string(command), "cwd": .string(cwd)]))) }
        catch { return SessionBashResponse(success: false, stdout: "", stderr: opsError(error), exitCode: -1) }
    }

    /// Ports ops.ts machineUpdateMetadata with versioned retry.
    public func machineUpdateMetadata(machineId: String, metadata: JSONValue, expectedVersion: Int, maxRetries: Int = 3) async throws -> MetadataUpdateResult {
        guard let cipher = try await sync.cipher(forMachine: machineId) else { throw SessionActionError.notDecryptable }
        var current = metadata
        var version = expectedVersion
        for _ in 0..<max(0, maxRetries) {
            let encrypted = try cipher.encrypt(current)
            let result = try await metadataTransport.updateMetadata(event: "machine-update-metadata", payload: .object([
                "machineId": .string(machineId), "metadata": .string(encrypted), "expectedVersion": .number(Double(version)),
            ]))
            guard ["success", "version-mismatch"].contains(result["result"]?.stringValue ?? "") else {
                throw SessionActionError.failed(result["message"]?.stringValue ?? "Failed to update machine metadata")
            }
            let next = try opsVersion(result["version"])
            guard let value = result["metadata"]?.stringValue else { throw SessionOpsError.malformedResponse }
            if result["result"]?.stringValue == "success" {
                guard let decoded = cipher.decrypt(base64: value) else { throw SessionOpsError.malformedResponse }
                _ = try store.applyMachineUpdate(
                    id: machineId, metadata: VersionedPayload(version: next, cipher: value, value: decoded),
                    daemonState: nil, active: nil, activeAt: nil
                )
                return MetadataUpdateResult(version: next, metadata: value)
            }
            guard result["result"]?.stringValue == "version-mismatch", var latest = cipher.decrypt(base64: value)?.objectValue else {
                throw SessionActionError.failed(result["message"]?.stringValue ?? "Failed to update machine metadata")
            }
            latest["displayName"] = metadata["displayName"]
            current = .object(latest)
            version = next
        }
        throw SessionOpsError.versionConflicts
    }

    /// Ports ops.ts claudeForkSession (machine RPC).
    public func claudeForkSession(options: ClaudeForkSessionOptions) async -> ClaudeForkSessionResult {
        await claudeCopy(options: options, cutAfterUuid: nil)
    }

    /// Ports ops.ts claudeDuplicateSession (machine RPC).
    public func claudeDuplicateSession(options: ClaudeForkSessionOptions, cutAfterUuid: String) async -> ClaudeForkSessionResult {
        await claudeCopy(options: options, cutAfterUuid: cutAfterUuid)
    }

    /// Ports ops.ts claudeListRewindPoints (machine RPC).
    public func claudeListRewindPoints(options: ClaudeForkSessionOptions) async -> ClaudeListRewindPointsResult {
        do {
            let result = try await call(machineId: options.machineId, method: "claude-list-rewind-points", params: Self.claudePayload(options))
            if result["type"]?.stringValue == "success" { return .success(points: try opsDecode(result["points"])) }
            return .error(errorMessage: result["errorMessage"]?.stringValue ?? "Failed to list rewind points")
        } catch { return .error(errorMessage: opsError(error)) }
    }

    /// Ports ops.ts codexForkThread (machine RPC).
    public func codexForkThread(options: CodexForkThreadOptions) async -> CodexForkThreadResult {
        await codexCopy(options: options, cutAfterItemId: nil)
    }

    /// Ports ops.ts codexDuplicateThread (machine RPC).
    public func codexDuplicateThread(options: CodexForkThreadOptions, cutAfterItemId: String) async -> CodexForkThreadResult {
        await codexCopy(options: options, cutAfterItemId: cutAfterItemId)
    }

    /// Ports ops.ts codexListRewindPoints (machine RPC).
    public func codexListRewindPoints(options: CodexForkThreadOptions) async -> CodexListRewindPointsResult {
        do {
            let result = try await call(machineId: options.machineId, method: "codex-list-rewind-points", params: Self.codexPayload(options))
            if result["type"]?.stringValue == "success" { return .success(points: try opsDecode(result["points"])) }
            return .error(errorMessage: result["errorMessage"]?.stringValue ?? "Failed to list Codex rewind points")
        } catch { return .error(errorMessage: opsError(error)) }
    }

    /// Ports ops.ts forkAndSpawn.
    public func forkAndSpawn(source: ForkSource, options: ForkOptions = ForkOptions()) async -> SpawnSessionResult {
        var spawn: SpawnSessionOptions
        switch source {
        case .claude(let sessionId, let origin):
            let fork = await claudeCopy(options: origin, cutAfterUuid: options.cutAfterUuid)
            guard case .success(let backendId) = fork else {
                if case .error(let error) = fork { return .error(errorMessage: error) }
                return .error(errorMessage: "Failed to fork session")
            }
            spawn = SpawnSessionOptions(machineId: origin.machineId, directory: origin.directory, agent: "claude")
            spawn.resumeClaudeSessionId = backendId
            spawn.parentSessionId = sessionId
        case .codex(let sessionId, let origin):
            let fork = await codexCopy(options: origin, cutAfterItemId: options.cutAfterItemId)
            guard case .success(let backendId) = fork else {
                if case .error(let error) = fork { return .error(errorMessage: error) }
                return .error(errorMessage: "Failed to fork Codex thread")
            }
            spawn = SpawnSessionOptions(machineId: origin.machineId, directory: origin.directory, agent: "codex")
            spawn.resumeCodexThreadId = backendId
            spawn.parentSessionId = sessionId
        }
        spawn.forkedFromMessageId = options.forkedFromMessageId
        spawn.isSideChat = options.isSideChat
        let result = await machineSpawnNewSession(options: spawn)
        if case .success = result { await sync.run(.sessions) }
        return result
    }

    /// Ports ops.ts spawnSideChat.
    public func spawnSideChat(source: ForkSource) async -> SpawnSessionResult {
        await forkAndSpawn(source: source, options: ForkOptions(isSideChat: true))
    }

    func call(machineId: String, method: String, params: JSONValue) async throws -> JSONValue {
        guard let cipher = try await sync.cipher(forMachine: machineId) else { throw SessionActionError.notDecryptable }
        let result = try await rpc.call(method: "\(machineId):\(method)", params: cipher.encrypt(params))
        guard result.ok else { throw SessionActionError.failed(result.error ?? "RPC call failed") }
        guard let sealed = result.result, let answer = cipher.decrypt(base64: sealed) else { throw SessionOpsError.malformedResponse }
        return answer
    }

    static func spawnPayload(_ options: SpawnSessionOptions) throws -> JSONValue {
        guard options.agent != "rig" || options.clientRequestId?.isEmpty == false else { throw SessionOpsError.unavailable("Rig session creation requires a client request ID") }
        guard options.happyAgentTarget == nil || options.agent == "rig" else { throw SessionOpsError.unavailable("Happy Agent catalog targets require the Happy Agent harness") }
        var params: [String: JSONValue] = [
            "type": .string("spawn-in-directory"), "directory": .string(options.directory),
            "approvedNewDirectoryCreation": .bool(options.approvedNewDirectoryCreation),
        ]
        params.set("agent", options.agent)
        params.set("permissionMode", options.permissionMode)
        if options.agent == "rig" {
            params.set("clientRequestId", options.clientRequestId)
            params.set("providerId", options.providerId)
            params.set("modelId", options.modelId)
            params.set("effort", options.effort ?? options.effortLevel)
            for key in ["clientRequestId", "permissionMode", "providerId", "modelId", "effort"] where params[key] == .string("") {
                params.removeValue(forKey: key)
            }
            if let target = options.happyAgentTarget {
                var config = params
                for key in ["type", "directory", "approvedNewDirectoryCreation", "agent", "clientRequestId"] { config.removeValue(forKey: key) }
                config["type"] = .string("happy-agent")
                return .object([
                    "type": .string("happy-agent-spawn"), "clientRequestId": .string(options.clientRequestId!),
                    "target": target, "agentConfiguration": .object(config),
                ])
            }
        } else {
            params.set("token", options.token)
            params.set("modelMode", options.modelMode)
            params.set("effortLevel", options.effortLevel)
            params.set("resumeClaudeSessionId", options.resumeClaudeSessionId)
            params.set("resumeCodexThreadId", options.resumeCodexThreadId)
            params.set("parentSessionId", options.parentSessionId)
            params.set("forkedFromMessageId", options.forkedFromMessageId)
            if let side = options.isSideChat { params["isSideChat"] = .bool(side) }
        }
        return .object(params)
    }

    func resumeFallback(sessionId: String, machineId: String) async throws -> (payload: JSONValue?, reason: String) {
        guard let session = try store.session(id: sessionId), let metadata = session.metadata else { return (nil, "client-has-no-session-row") }
        guard metadata["machineId"]?.stringValue == machineId else { return (nil, "client-session-machine-mismatch") }
        guard let key = try await sync.sessionDataKey(forSession: sessionId) else { return (nil, "client-has-no-data-key") }
        return (.object([
            "metadata": metadata, "metadataVersion": .number(Double(session.metadataVersion)),
            "agentStateVersion": .number(Double(session.agentStateVersion)), "seq": .number(Double(session.seq)),
            "encryptionKey": .string(key.base64EncodedString()), "encryptionVariant": .string("dataKey"),
        ]), "ok")
    }

    static func claudePayload(_ options: ClaudeForkSessionOptions) -> JSONValue {
        .object(["directory": .string(options.directory), "claudeSessionId": .string(options.claudeSessionId)])
    }
    static func codexPayload(_ options: CodexForkThreadOptions) -> JSONValue {
        .object(["directory": .string(options.directory), "codexThreadId": .string(options.codexThreadId)])
    }
    private func claudeCopy(options: ClaudeForkSessionOptions, cutAfterUuid: String?) async -> ClaudeForkSessionResult {
        do {
            var params = Self.claudePayload(options).objectValue!
            params.set("cutAfterUuid", cutAfterUuid)
            let result = try await call(machineId: options.machineId, method: cutAfterUuid == nil ? "claude-fork-session" : "claude-duplicate-session", params: .object(params))
            if result["type"]?.stringValue == "success", let id = result["newClaudeSessionId"]?.stringValue { return .success(newClaudeSessionId: id) }
            return .error(errorMessage: result["errorMessage"]?.stringValue ?? "Failed to fork session")
        } catch { return .error(errorMessage: opsError(error)) }
    }
    private func codexCopy(options: CodexForkThreadOptions, cutAfterItemId: String?) async -> CodexForkThreadResult {
        do {
            var params = Self.codexPayload(options).objectValue!
            params.set("cutAfterItemId", cutAfterItemId)
            let result = try await call(machineId: options.machineId, method: cutAfterItemId == nil ? "codex-fork-thread" : "codex-duplicate-thread", params: .object(params))
            if result["type"]?.stringValue == "success", let id = result["newCodexThreadId"]?.stringValue { return .success(newCodexThreadId: id) }
            return .error(errorMessage: result["errorMessage"]?.stringValue ?? "Failed to fork Codex thread")
        } catch { return .error(errorMessage: opsError(error)) }
    }
}
