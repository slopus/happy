import Foundation
import HappyStore
import HappyWire

public struct MachineActions: Sendable {
    let api: HappyAPI
    let store: LocalStore
    let sync: SyncEngine
    let rpc: any RPCTransport
    let metadataTransport: any MetadataUpdateTransport
    public init(api: HappyAPI, store: LocalStore, sync: SyncEngine, rpc: any RPCTransport, metadataTransport: any MetadataUpdateTransport) {
        self.api = api; self.store = store; self.sync = sync; self.rpc = rpc; self.metadataTransport = metadataTransport
    }
    /// Ports ops.ts machineSpawnNewSession.
    public func machineSpawnNewSession(options: SpawnSessionOptions) async -> SpawnSessionResult { .error(errorMessage: "Not implemented") }
    /// Ports ops.ts normalizeSpawnSessionResult.
    public static func normalizeSpawnSessionResult(_ result: JSONValue) -> SpawnSessionResult { .error(errorMessage: "Not implemented") }
    /// Ports ops.ts machineResumeSession, including the encrypted fallback.
    public func machineResumeSession(machineId: String, sessionId: String, model: String? = nil, permissionMode: String? = nil) async -> SpawnSessionResult { .error(errorMessage: "Not implemented") }
    /// Ports ops.ts machineStopSession.
    public func machineStopSession(machineId: String, sessionId: String) async -> MachineOperationResult { MachineOperationResult(success: false, message: "Not implemented") }
    /// Ports ops.ts machineStopDaemon.
    public func machineStopDaemon(machineId: String) async throws -> MachineStopDaemonResult { throw SessionOpsError.notImplemented }
    /// Ports ops.ts machineDelete.
    public func machineDelete(machineId: String) async -> MachineOperationResult { MachineOperationResult(success: false, message: "Not implemented") }
    /// Ports ops.ts machineBash.
    public func machineBash(machineId: String, command: String, cwd: String) async throws -> SessionBashResponse { throw SessionOpsError.notImplemented }
    /// Ports ops.ts machineUpdateMetadata with versioned retry.
    public func machineUpdateMetadata(machineId: String, metadata: JSONValue, expectedVersion: Int, maxRetries: Int = 3) async throws -> MetadataUpdateResult { throw SessionOpsError.notImplemented }
    /// Ports ops.ts claudeForkSession (machine RPC).
    public func claudeForkSession(options: ClaudeForkSessionOptions) async -> ClaudeForkSessionResult { .error(errorMessage: "Not implemented") }
    /// Ports ops.ts claudeDuplicateSession (machine RPC).
    public func claudeDuplicateSession(options: ClaudeForkSessionOptions, cutAfterUuid: String) async -> ClaudeForkSessionResult { .error(errorMessage: "Not implemented") }
    /// Ports ops.ts claudeListRewindPoints (machine RPC).
    public func claudeListRewindPoints(options: ClaudeForkSessionOptions) async -> ClaudeListRewindPointsResult { .error(errorMessage: "Not implemented") }
    /// Ports ops.ts codexForkThread (machine RPC).
    public func codexForkThread(options: CodexForkThreadOptions) async -> CodexForkThreadResult { .error(errorMessage: "Not implemented") }
    /// Ports ops.ts codexDuplicateThread (machine RPC).
    public func codexDuplicateThread(options: CodexForkThreadOptions, cutAfterItemId: String) async -> CodexForkThreadResult { .error(errorMessage: "Not implemented") }
    /// Ports ops.ts codexListRewindPoints (machine RPC).
    public func codexListRewindPoints(options: CodexForkThreadOptions) async -> CodexListRewindPointsResult { .error(errorMessage: "Not implemented") }
    /// Ports ops.ts forkAndSpawn.
    public func forkAndSpawn(source: ForkSource, options: ForkOptions = ForkOptions()) async -> SpawnSessionResult { .error(errorMessage: "Not implemented") }
    /// Ports ops.ts spawnSideChat.
    public func spawnSideChat(source: ForkSource) async -> SpawnSessionResult { .error(errorMessage: "Not implemented") }
}