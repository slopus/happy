import Foundation
import HappyWire

extension SessionActions {
    /// Ports ops.ts sessionSwitch.
    public func sessionSwitch(sessionId: String, to: SessionControlMode) async throws -> Bool { throw SessionOpsError.notImplemented }
    /// Ports ops.ts sessionGoalAction.
    public func sessionGoalAction(sessionId: String, action: SessionGoalAction, objective: String? = nil) async throws { throw SessionOpsError.notImplemented }
    /// Ports ops.ts sessionBash.
    public func sessionBash(sessionId: String, request: SessionBashRequest) async throws -> SessionBashResponse { throw SessionOpsError.notImplemented }
    /// Ports ops.ts sessionReadFile.
    public func sessionReadFile(sessionId: String, path: String) async throws -> SessionReadFileResponse { throw SessionOpsError.notImplemented }
    /// Ports ops.ts sessionWriteFile. expectedHash nil omits the field; .null requests creation.
    public func sessionWriteFile(sessionId: String, path: String, content: String, expectedHash: JSONValue? = nil) async throws -> SessionWriteFileResponse { throw SessionOpsError.notImplemented }
    /// Ports ops.ts sessionListDirectory.
    public func sessionListDirectory(sessionId: String, path: String) async throws -> SessionListDirectoryResponse { throw SessionOpsError.notImplemented }
    /// Ports ops.ts sessionGetDirectoryTree.
    public func sessionGetDirectoryTree(sessionId: String, path: String, maxDepth: Int) async throws -> SessionGetDirectoryTreeResponse { throw SessionOpsError.notImplemented }
    /// Ports ops.ts sessionRipgrep.
    public func sessionRipgrep(sessionId: String, args: [String], cwd: String? = nil) async throws -> SessionRipgrepResponse { throw SessionOpsError.notImplemented }
    /// Ports ops.ts sessionKill.
    public func sessionKill(sessionId: String) async throws -> SessionKillResponse { throw SessionOpsError.notImplemented }
    /// Ports ops.ts sessionSetAgentModes and sessionUpdateAgentModesMetadata.
    public func sessionSetAgentModes(sessionId: String, patch: SessionAgentModesPatch, transport: any MetadataUpdateTransport) async throws { throw SessionOpsError.notImplemented }
    /// Ports ops.ts sessionSetAvatar.
    public func sessionSetAvatar(sessionId: String, picture: SessionAvatarPicture) async throws { throw SessionOpsError.notImplemented }
    /// Ports sync.ts renameSession, over update-metadata with expectedVersion.
    public func rename(sessionId: String, title: String, transport: any MetadataUpdateTransport) async throws { throw SessionOpsError.notImplemented }
}