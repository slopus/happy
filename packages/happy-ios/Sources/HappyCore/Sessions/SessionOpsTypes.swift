import Foundation
import HappyWire

/// Local failures constructing or reading a current operations payload.
public enum SessionOpsError: Error, Equatable, Sendable {
    case notImplemented
    case malformedResponse
    case unavailable(String)
    case versionConflicts
}

/// sessionSwitch's `to` wire field.
public enum SessionControlMode: String, Codable, Sendable {
    case remote
    case local
}

/// sessionGoalAction's `action` wire field.
public enum SessionGoalAction: String, Codable, Sendable {
    case clear
    case stop
    case edit
}

/// ops.ts SessionBashRequest; timeout is milliseconds.
public struct SessionBashRequest: Codable, Equatable, Sendable {
    /// `command`, passed through to the shell.
    public var command: String
    /// Optional `cwd`; absence leaves the session directory in use.
    public var cwd: String?
    /// Optional `timeout`, milliseconds.
    public var timeout: Int?

    public init(command: String, cwd: String? = nil, timeout: Int? = nil) {
        self.command = command
        self.cwd = cwd
        self.timeout = timeout
    }
}

/// ops.ts SessionBashResponse, including process output on failure.
public struct SessionBashResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var stdout: String
    public var stderr: String
    public var exitCode: Int
    public var error: String?
}

/// ops.ts SessionReadFileResponse; content is kept in its wire base64 form.
public struct SessionReadFileResponse: Codable, Equatable, Sendable {
    public var success: Bool
    /// Base64, as returned by readFile.
    public var content: String?
    public var error: String?
}

/// ops.ts SessionWriteFileResponse, including the new content hash.
public struct SessionWriteFileResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var hash: String?
    public var error: String?
}

/// An entry returned by listDirectory; modified is the CLI timestamp.
public struct DirectoryEntry: Codable, Equatable, Sendable {
    /// DirectoryEntry's `type` discriminator.
    public enum Kind: String, Codable, Sendable {
        case file
        case directory
        case other
    }
    public var name: String
    public var type: Kind
    public var size: Int64?
    public var modified: Double?
}

/// ops.ts SessionListDirectoryResponse.
public struct SessionListDirectoryResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var entries: [DirectoryEntry]?
    public var error: String?
}

/// A recursive getDirectoryTree entry.
public struct TreeNode: Codable, Equatable, Sendable {
    /// TreeNode's `type` discriminator.
    public enum Kind: String, Codable, Sendable {
        case file
        case directory
    }
    public var name: String
    public var path: String
    public var type: Kind
    public var size: Int64?
    public var modified: Double?
    public var children: [TreeNode]?
}

/// ops.ts SessionGetDirectoryTreeResponse.
public struct SessionGetDirectoryTreeResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var tree: TreeNode?
    public var error: String?
}

/// ops.ts SessionRipgrepResponse; process fields may be absent on failure.
public struct SessionRipgrepResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var exitCode: Int?
    public var stdout: String?
    public var stderr: String?
    public var error: String?
}

/// ops.ts SessionKillResponse.
public struct SessionKillResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var message: String
}

/// nil leaves a field alone; .null clears it; .string sets it.
public struct SessionAgentModesPatch: Equatable, Sendable {
    /// Metadata `permissionMode`; .null clears the pick.
    public var permissionMode: JSONValue?
    /// Metadata `modelMode`; Rig interprets a provider:model qualified key.
    public var modelMode: JSONValue?
    /// Metadata `effortLevel`; Rig writes draft.effort instead.
    public var effortLevel: JSONValue?

    public init(permissionMode: JSONValue? = nil, modelMode: JSONValue? = nil, effortLevel: JSONValue? = nil) {
        self.permissionMode = permissionMode
        self.modelMode = modelMode
        self.effortLevel = effortLevel
    }
}

/// ops.ts sessionSetAvatar's already-uploaded picture reference.
public struct SessionAvatarPicture: Codable, Equatable, Sendable {
    /// The three MIME strings accepted by setAvatar.
    public enum MIMEType: String, Codable, Sendable {
        case png = "image/png"
        case jpeg = "image/jpeg"
        case webp = "image/webp"
    }
    /// `ref`, the encrypted session attachment reference.
    public var ref: String
    /// `size`, bytes.
    public var size: Int
    /// `mimeType`, one of the three image MIME strings.
    public var mimeType: MIMEType

    public init(ref: String, size: Int, mimeType: MIMEType) {
        self.ref = ref
        self.size = size
        self.mimeType = mimeType
    }
}

/// The server's versioned metadata acknowledgements, separate from sealed RPC.
public protocol MetadataUpdateTransport: Sendable {
    /// Emits update-metadata or machine-update-metadata and returns the acknowledgement.
    func updateMetadata(event: String, payload: JSONValue) async throws -> JSONValue
}

extension SocketIOClient: MetadataUpdateTransport {
    /// Ports apiSocket.emitWithAck for versioned metadata writes.
    public func updateMetadata(event: String, payload: JSONValue) async throws -> JSONValue {
        guard let result = try await emitWithAck(event, payload, timeout: .seconds(50)).first else { throw SessionActionError.noAnswer }
        return result
    }
}
