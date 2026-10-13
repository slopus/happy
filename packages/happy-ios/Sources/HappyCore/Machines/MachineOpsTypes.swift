import Foundation
import HappyWire

public enum SpawnSessionResult: Equatable, Sendable {
    case success(sessionId: String)
    case pending(clientRequestId: String, retryAfterMs: Int)
    case requestToApproveDirectoryCreation(directory: String)
    case error(errorMessage: String)
}
public struct SpawnSessionOptions: Sendable, Equatable {
    public var machineId: String
    public var directory: String
    public var approvedNewDirectoryCreation = false
    public var token: String?
    public var agent: String?
    public var permissionMode: String?
    public var modelMode: String?
    public var effortLevel: String?
    public var clientRequestId: String?
    public var providerId: String?
    public var modelId: String?
    public var effort: String?
    public var happyAgentTarget: JSONValue?
    public var resumeClaudeSessionId: String?
    public var resumeCodexThreadId: String?
    public var parentSessionId: String?
    public var forkedFromMessageId: String?
    public var isSideChat: Bool?
    public init(machineId: String, directory: String, agent: String? = nil) { self.machineId = machineId; self.directory = directory; self.agent = agent }
}
public struct ClaudeForkSessionOptions: Sendable, Equatable {
    public var machineId: String
    public var directory: String
    public var claudeSessionId: String
    public init(machineId: String, directory: String, claudeSessionId: String) { self.machineId = machineId; self.directory = directory; self.claudeSessionId = claudeSessionId }
}
public struct CodexForkThreadOptions: Sendable, Equatable {
    public var machineId: String
    public var directory: String
    public var codexThreadId: String
    public init(machineId: String, directory: String, codexThreadId: String) { self.machineId = machineId; self.directory = directory; self.codexThreadId = codexThreadId }
}
public enum ClaudeForkSessionResult: Sendable, Equatable { case success(newClaudeSessionId: String), error(errorMessage: String) }
public enum CodexForkThreadResult: Sendable, Equatable { case success(newCodexThreadId: String), error(errorMessage: String) }
public struct ClaudeRewindPoint: Codable, Sendable, Equatable { public var uuid: String; public var text: String; public var timestamp: Double }
public struct CodexRewindPoint: Codable, Sendable, Equatable { public var itemId: String; public var text: String; public var timestamp: Double }
public enum ClaudeListRewindPointsResult: Sendable, Equatable { case success(points: [ClaudeRewindPoint]), error(errorMessage: String) }
public enum CodexListRewindPointsResult: Sendable, Equatable { case success(points: [CodexRewindPoint]), error(errorMessage: String) }
public struct MachineOperationResult: Codable, Sendable, Equatable { public var success: Bool; public var message: String? }
public struct MachineStopDaemonResult: Codable, Sendable, Equatable { public var message: String }
public struct MetadataUpdateResult: Sendable, Equatable { public var version: Int; public var metadata: String }
public enum ForkSource: Sendable, Equatable {
    case claude(sessionId: String, options: ClaudeForkSessionOptions)
    case codex(sessionId: String, options: CodexForkThreadOptions)
}
public struct ForkOptions: Sendable, Equatable {
    public var cutAfterUuid: String?
    public var cutAfterItemId: String?
    public var forkedFromMessageId: String?
    public var isSideChat: Bool?
    public init(cutAfterUuid: String? = nil, cutAfterItemId: String? = nil, forkedFromMessageId: String? = nil, isSideChat: Bool? = nil) {
        self.cutAfterUuid = cutAfterUuid; self.cutAfterItemId = cutAfterItemId; self.forkedFromMessageId = forkedFromMessageId; self.isSideChat = isSideChat
    }
}