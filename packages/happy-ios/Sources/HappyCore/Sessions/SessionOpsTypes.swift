import Foundation
import HappyWire

public enum SessionOpsError: Error, Equatable, Sendable {
    case notImplemented
    case malformedResponse
    case unavailable(String)
    case versionConflicts
}

public enum SessionControlMode: String, Codable, Sendable { case remote, local }
public enum SessionGoalAction: String, Codable, Sendable { case clear, stop, edit }

public struct SessionBashRequest: Codable, Equatable, Sendable {
    public var command: String
    public var cwd: String?
    public var timeout: Int?
    public init(command: String, cwd: String? = nil, timeout: Int? = nil) {
        self.command = command; self.cwd = cwd; self.timeout = timeout
    }
}
public struct SessionBashResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var stdout: String
    public var stderr: String
    public var exitCode: Int
    public var error: String?
}
public struct SessionReadFileResponse: Codable, Equatable, Sendable {
    public var success: Bool
    /// Base64, as returned by readFile.
    public var content: String?
    public var error: String?
}
public struct SessionWriteFileResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var hash: String?
    public var error: String?
}
public struct DirectoryEntry: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case file, directory, other }
    public var name: String
    public var type: Kind
    public var size: Int64?
    public var modified: Double?
}
public struct SessionListDirectoryResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var entries: [DirectoryEntry]?
    public var error: String?
}
public struct TreeNode: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case file, directory }
    public var name: String
    public var path: String
    public var type: Kind
    public var size: Int64?
    public var modified: Double?
    public var children: [TreeNode]?
}
public struct SessionGetDirectoryTreeResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var tree: TreeNode?
    public var error: String?
}
public struct SessionRipgrepResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var exitCode: Int?
    public var stdout: String?
    public var stderr: String?
    public var error: String?
}
public struct SessionKillResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var message: String
}
/// nil leaves a field alone; .null clears it; .string sets it.
public struct SessionAgentModesPatch: Equatable, Sendable {
    public var permissionMode: JSONValue?
    public var modelMode: JSONValue?
    public var effortLevel: JSONValue?
    public init(permissionMode: JSONValue? = nil, modelMode: JSONValue? = nil, effortLevel: JSONValue? = nil) {
        self.permissionMode = permissionMode; self.modelMode = modelMode; self.effortLevel = effortLevel
    }
}
public struct SessionAvatarPicture: Codable, Equatable, Sendable {
    public enum MIMEType: String, Codable, Sendable { case png = "image/png", jpeg = "image/jpeg", webp = "image/webp" }
    public var ref: String
    public var size: Int
    public var mimeType: MIMEType
    public init(ref: String, size: Int, mimeType: MIMEType) { self.ref = ref; self.size = size; self.mimeType = mimeType }
}

/// The server's versioned metadata acknowledgements, separate from sealed RPC.
public protocol MetadataUpdateTransport: Sendable {
    func updateMetadata(event: String, payload: JSONValue) async throws -> JSONValue
}

extension SocketIOClient: MetadataUpdateTransport {
    public func updateMetadata(event: String, payload: JSONValue) async throws -> JSONValue {
        guard let result = try await emitWithAck(event, payload, timeout: .seconds(50)).first else { throw SessionActionError.noAnswer }
        return result
    }
}