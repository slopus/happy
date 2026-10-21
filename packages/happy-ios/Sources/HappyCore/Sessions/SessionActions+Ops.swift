import Foundation
import HappyStore
import HappyWire

extension SessionActions {
    /// Ports ops.ts sessionSwitch.
    public func sessionSwitch(sessionId: String, to: SessionControlMode) async throws -> Bool {
        try opsDecode(await call(sessionId: sessionId, method: "switch", params: .object(["to": .string(to.rawValue)])))
    }

    /// Ports ops.ts sessionGoalAction.
    public func sessionGoalAction(sessionId: String, action: SessionGoalAction, objective: String? = nil) async throws {
        var params: [String: JSONValue] = ["action": .string(action.rawValue)]
        params.set("objective", objective)
        _ = try await call(sessionId: sessionId, method: "goal-action", params: .object(params))
    }

    /// Ports ops.ts sessionBash.
    public func sessionBash(sessionId: String, request: SessionBashRequest) async throws -> SessionBashResponse {
        do { return try await decodedCall(sessionId: sessionId, method: "bash", params: opsJSON(request)) }
        catch { return SessionBashResponse(success: false, stdout: "", stderr: opsError(error), exitCode: -1, error: opsError(error)) }
    }

    /// Ports ops.ts sessionReadFile.
    public func sessionReadFile(sessionId: String, path: String) async throws -> SessionReadFileResponse {
        do { return try await decodedCall(sessionId: sessionId, method: "readFile", params: .object(["path": .string(path)])) }
        catch { return SessionReadFileResponse(success: false, error: opsError(error)) }
    }

    /// Ports ops.ts sessionWriteFile. expectedHash nil omits the field; .null requests creation.
    public func sessionWriteFile(sessionId: String, path: String, content: String, expectedHash: JSONValue? = nil) async throws -> SessionWriteFileResponse {
        var params: [String: JSONValue] = ["path": .string(path), "content": .string(content)]
        guard expectedHash == nil || expectedHash == .null || expectedHash?.stringValue != nil else { throw SessionOpsError.malformedResponse }
        if let expectedHash { params["expectedHash"] = expectedHash }
        do { return try await decodedCall(sessionId: sessionId, method: "writeFile", params: .object(params)) }
        catch { return SessionWriteFileResponse(success: false, error: opsError(error)) }
    }

    /// Ports ops.ts sessionListDirectory.
    public func sessionListDirectory(sessionId: String, path: String) async throws -> SessionListDirectoryResponse {
        do { return try await decodedCall(sessionId: sessionId, method: "listDirectory", params: .object(["path": .string(path)])) }
        catch { return SessionListDirectoryResponse(success: false, error: opsError(error)) }
    }

    /// Ports ops.ts sessionGetDirectoryTree.
    public func sessionGetDirectoryTree(sessionId: String, path: String, maxDepth: Int) async throws -> SessionGetDirectoryTreeResponse {
        do { return try await decodedCall(sessionId: sessionId, method: "getDirectoryTree", params: .object(["path": .string(path), "maxDepth": .number(Double(maxDepth))])) }
        catch { return SessionGetDirectoryTreeResponse(success: false, error: opsError(error)) }
    }

    /// Ports ops.ts sessionRipgrep.
    public func sessionRipgrep(sessionId: String, args: [String], cwd: String? = nil) async throws -> SessionRipgrepResponse {
        var params: [String: JSONValue] = ["args": .array(args.map(JSONValue.string))]
        params.set("cwd", cwd)
        do { return try await decodedCall(sessionId: sessionId, method: "ripgrep", params: .object(params)) }
        catch { return SessionRipgrepResponse(success: false, error: opsError(error)) }
    }

    /// Ports ops.ts sessionKill.
    public func sessionKill(sessionId: String) async throws -> SessionKillResponse {
        do { return try opsDecode(await call(sessionId: sessionId, method: "killSession", params: .object([:]))) }
        catch { return SessionKillResponse(success: false, message: opsError(error)) }
    }

    /// Ports ops.ts sessionSetAgentModes and sessionUpdateAgentModesMetadata.
    public func sessionSetAgentModes(sessionId: String, patch: SessionAgentModesPatch, transport: any MetadataUpdateTransport) async throws {
        var changes: [String: JSONValue] = [:]
        if let value = patch.permissionMode { changes["permissionMode"] = value }
        if let value = patch.modelMode { changes["modelMode"] = value }
        if let value = patch.effortLevel { changes["effortLevel"] = value }
        guard changes.values.allSatisfy({ $0 == .null || $0.stringValue != nil }) else { throw SessionOpsError.malformedResponse }
        if SessionMetadata.isRigV1(try store.session(id: sessionId)?.metadata) {
            try await sync.rigComposer.setModes(sessionId: sessionId, changes: changes, transport: transport)
            return
        }
        let fields = Array(changes.keys)
        sync.modePushes.mark(sessionId: sessionId, fields: fields)
        defer { sync.modePushes.clear(sessionId: sessionId, fields: fields) }
        var composer = try store.composerState(sessionId: sessionId)
        var values = composer.values.objectValue ?? [:]
        values.merge(changes) { _, value in value }
        composer.values = .object(values)
        try store.saveComposerState(composer)
        try await updateMetadata(sessionId: sessionId, changes: changes, transport: transport)
    }
    /// Ports ops.ts sessionSetAvatar.
    public func sessionSetAvatar(sessionId: String, picture: SessionAvatarPicture) async throws {
        let result = try await call(sessionId: sessionId, method: "setAvatar", params: opsJSON(picture))
        guard result?["success"]?.boolValue == true else { throw SessionActionError.failed(result?["error"]?.stringValue ?? "The picture could not be set.") }
    }
    private func decodedCall<T: Decodable>(sessionId: String, method: String, params: JSONValue) async throws -> T {
        let metadata = try store.session(id: sessionId)?.metadata
        guard SessionCapabilities.permits(metadata, method: method) else { throw SessionOpsError.unavailable("\(method) is not available for this session") }
        return try opsDecode(await call(sessionId: sessionId, method: method, params: params))
    }

    func updateMetadata(sessionId: String, changes: [String: JSONValue], transport: any MetadataUpdateTransport) async throws {
        guard let session = try store.session(id: sessionId), var metadata = session.metadata?.objectValue,
              let cipher = try await sync.cipher(forSession: sessionId) else { throw SessionActionError.notDecryptable }
        var pending = changes.filter { (metadata[$0.key] ?? .null) != $0.value }
        guard !pending.isEmpty else { return }
        var version = session.metadataVersion
        for _ in 0..<3 {
            metadata.merge(pending) { _, value in value }
            let sealed = try cipher.encrypt(.object(metadata))
            let result = try await transport.updateMetadata(event: "update-metadata", payload: .object([
                "sid": .string(sessionId), "metadata": .string(sealed), "expectedVersion": .number(Double(version)),
            ]))
            guard ["success", "version-mismatch"].contains(result["result"]?.stringValue ?? "") else {
                throw SessionActionError.failed(result["message"]?.stringValue ?? "Failed to update session metadata")
            }
            let next = try opsVersion(result["version"])
            guard let returned = result["metadata"]?.stringValue else { throw SessionOpsError.malformedResponse }
            if result["result"]?.stringValue == "success" {
                guard let value = cipher.decrypt(base64: returned) else { throw SessionOpsError.malformedResponse }
                _ = try store.applySessionUpdate(id: sessionId, metadata: VersionedPayload(version: next, cipher: returned, value: value), agentState: nil, projectId: nil)
                return
            }
            guard result["result"]?.stringValue == "version-mismatch", let latest = cipher.decrypt(base64: returned)?.objectValue else {
                throw SessionActionError.failed("Failed to update session metadata")
            }
            // Another local action may have replaced a mode while this request was in flight.
            let live = try store.session(id: sessionId)?.metadata?.objectValue ?? [:]
            let picks = try store.composerState(sessionId: sessionId).values
            pending = pending.filter { item in
                if ["permissionMode", "modelMode", "effortLevel"].contains(item.key) {
                    return (picks[item.key] ?? .null) == item.value
                }
                return (live[item.key] ?? .null) == (session.metadata?[item.key] ?? .null)
            }
            if pending.isEmpty { return }
            version = next
            metadata = latest
        }
        throw SessionOpsError.versionConflicts
    }

}
