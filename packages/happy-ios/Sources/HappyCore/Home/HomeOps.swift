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
    /// ops.ts `machineStopSession`.
    func machineStopSession(machineId: String, sessionId: String) async -> MachineOperationResult
    /// ops.ts `machineBash`.
    func machineBash(machineId: String, command: String, cwd: String) async throws -> SessionBashResponse
}

extension MachineActions: HomeOps {}

/// What home asks of a session, as ops.ts and sync.ts name it: the
/// session half of the seam, served by the Ops workstream's
/// `SessionActions`.
public protocol HomeSessionOps: Sendable {
    /// ops.ts `sessionKill`.
    func sessionKill(sessionId: String) async throws -> SessionKillResponse
    /// ops.ts `sessionSetAgentModes`.
    func sessionSetAgentModes(sessionId: String, patch: SessionAgentModesPatch, transport: any MetadataUpdateTransport) async throws
    /// ops.ts `sessionSetAvatar`.
    func sessionSetAvatar(sessionId: String, picture: SessionAvatarPicture) async throws
    /// ops.ts `sessionArchive`.
    func archive(sessionId: String) async throws
    /// sync.ts `ensureSessionReady`: waits until a new session's row and
    /// keys have synced, so its first message can be placed.
    func ensureSessionReady(sessionId: String) async throws
    /// sync.ts `uploadSessionBlob`: a bot's face, stored with the session.
    func uploadSessionBlob(sessionId: String, name: String, bytes: Data) async throws -> (ref: String, size: Int)
}

extension SessionActions: HomeSessionOps {}

extension AccountSession {
    /// The machine operations home runs.
    public var homeOps: any HomeOps {
        machineActions
    }

    /// The session operations home runs.
    public var homeSessionOps: any HomeSessionOps { actions }
}
