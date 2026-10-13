import Foundation
import HappyStore
import HappyWire

/// What home and the new-session screen ask a machine to do, as ops.ts
/// names it. A thin adapter over the Ops workstream's `MachineActions`, so
/// the screens call one thing and tests can stand in for it.
public protocol HomeOps: Sendable {
    /// ops.ts `machineSpawnNewSession`.
    func machineSpawnNewSession(options: SpawnSessionOptions) async -> SpawnSessionResult
    /// ops.ts `machineResumeSession`.
    func machineResumeSession(machineId: String, sessionId: String, model: String?, permissionMode: String?) async -> SpawnSessionResult
    /// ops.ts `forkAndSpawn`.
    func forkAndSpawn(source: ForkSource, options: ForkOptions) async -> SpawnSessionResult
}

extension MachineActions: HomeOps {}

extension AccountSession {
    /// The machine operations home runs.
    ///
    /// OPS SEAM: `MachineActions` is built here until the Ops workstream
    /// puts one on `AccountSession`; then this returns that one.
    public var homeOps: any HomeOps {
        MachineActions(api: api, store: store, sync: sync, rpc: realtime, metadataTransport: realtime)
    }
}
