import Foundation
import HappyWire

/// ops.ts SpawnSessionResult, including asynchronous Rig and directory approval answers.
public enum SpawnSessionResult: Equatable, Sendable {
    case success(sessionId: String)
    case pending(clientRequestId: String, retryAfterMs: Int)
    case requestToApproveDirectoryCreation(directory: String)
    case error(errorMessage: String)
}

/// ops.ts SpawnSessionOptions. CLI flavor agents read modelMode/effortLevel;
/// Rig reads providerId/modelId/effort and requires clientRequestId.
public struct SpawnSessionOptions: Sendable, Equatable {
    /// RPC address prefix; not included in the sealed request.
    public var machineId: String
    /// `directory`, used for spawn-in-directory only.
    public var directory: String
    /// `approvedNewDirectoryCreation`, always sent for directory spawns.
    public var approvedNewDirectoryCreation = false
    /// `token`, sent to CLI flavor agents only.
    public var token: String?
    /// `agent`: claude, codex, gemini, openclaw, agy or rig.
    public var agent: String?
    /// `permissionMode`, sent to either harness.
    public var permissionMode: String?
    /// CLI flavor-agent `modelMode`; Rig does not read it.
    public var modelMode: String?
    /// CLI flavor-agent `effortLevel`; also the fallback for Rig `effort`.
    public var effortLevel: String?
    /// Rig `clientRequestId`: stable idempotency id, required for Rig spawns.
    public var clientRequestId: String?
    /// Rig `providerId`, or agentConfiguration.providerId for catalog spawns.
    public var providerId: String?
    /// Rig `modelId`, or agentConfiguration.modelId for catalog spawns.
    public var modelId: String?
    /// Rig `effort`, or agentConfiguration.effort; wins over effortLevel.
    public var effort: String?
    /// Rig `target`, preserved whole for happy-agent-spawn (catalog identity).
    public var happyAgentTarget: JSONValue?
    /// CLI `resumeClaudeSessionId` attaches the copied Claude transcript.
    public var resumeClaudeSessionId: String?
    /// CLI `resumeCodexThreadId` attaches the copied Codex thread.
    public var resumeCodexThreadId: String?
    /// CLI `parentSessionId`, the source Happy session for lineage.
    public var parentSessionId: String?
    /// CLI `forkedFromMessageId`, the Happy rewind point for lineage.
    public var forkedFromMessageId: String?
    /// CLI `isSideChat`, hides this child from the top-level session list.
    public var isSideChat: Bool?

    public init(machineId: String, directory: String, agent: String? = nil) {
        self.machineId = machineId
        self.directory = directory
        self.agent = agent
    }
}

/// ops.ts ClaudeForkSessionOptions, addressed to the machine holding the JSONL.
public struct ClaudeForkSessionOptions: Sendable, Equatable {
    /// RPC address prefix; not a sealed request field.
    public var machineId: String
    /// `directory`, locates the Claude project directory.
    public var directory: String
    /// `claudeSessionId`, the source transcript's UUID.
    public var claudeSessionId: String

    public init(machineId: String, directory: String, claudeSessionId: String) {
        self.machineId = machineId
        self.directory = directory
        self.claudeSessionId = claudeSessionId
    }
}

/// ops.ts CodexForkThreadOptions, addressed to the machine holding the thread.
public struct CodexForkThreadOptions: Sendable, Equatable {
    /// RPC address prefix; not a sealed request field.
    public var machineId: String
    /// `directory`, passed through to Codex thread/fork.
    public var directory: String
    /// `codexThreadId`, the source app-server thread id.
    public var codexThreadId: String

    public init(machineId: String, directory: String, codexThreadId: String) {
        self.machineId = machineId
        self.directory = directory
        self.codexThreadId = codexThreadId
    }
}

/// ops.ts ClaudeForkSessionResult: copied backend id or refusal.
public enum ClaudeForkSessionResult: Sendable, Equatable {
    case success(newClaudeSessionId: String)
    case error(errorMessage: String)
}

/// ops.ts CodexForkThreadResult: copied backend id or refusal.
public enum CodexForkThreadResult: Sendable, Equatable {
    case success(newCodexThreadId: String)
    case error(errorMessage: String)
}

/// A user-text message from Claude's on-disk transcript.
public struct ClaudeRewindPoint: Codable, Sendable, Equatable {
    public var uuid: String
    public var text: String
    public var timestamp: Double
}

/// A user-text item from Codex's on-disk thread.
public struct CodexRewindPoint: Codable, Sendable, Equatable {
    public var itemId: String
    public var text: String
    public var timestamp: Double
}

/// ops.ts claudeListRewindPoints response.
public enum ClaudeListRewindPointsResult: Sendable, Equatable {
    case success(points: [ClaudeRewindPoint])
    case error(errorMessage: String)
}

/// ops.ts codexListRewindPoints response.
public enum CodexListRewindPointsResult: Sendable, Equatable {
    case success(points: [CodexRewindPoint])
    case error(errorMessage: String)
}

/// ops.ts machineStopSession/machineDelete result.
public struct MachineOperationResult: Codable, Sendable, Equatable {
    public var success: Bool
    public var message: String?
}

/// ops.ts machineStopDaemon acknowledgement.
public struct MachineStopDaemonResult: Codable, Sendable, Equatable {
    public var message: String
}

/// Successful versioned metadata acknowledgement; metadata remains sealed.
public struct MetadataUpdateResult: Sendable, Equatable {
    public var version: Int
    public var metadata: String
}

/// ops.ts ForkSource: Happy lineage plus the backend identity to copy.
public enum ForkSource: Sendable, Equatable {
    case claude(sessionId: String, options: ClaudeForkSessionOptions)
    case codex(sessionId: String, options: CodexForkThreadOptions)
}

/// ops.ts ForkOptions. Absent cuts copy the complete transcript/thread.
public struct ForkOptions: Sendable, Equatable {
    /// `cutAfterUuid`, supplied to claude-duplicate-session only.
    public var cutAfterUuid: String?
    /// `cutAfterItemId`, supplied to codex-duplicate-thread only.
    public var cutAfterItemId: String?
    /// Spawn's `forkedFromMessageId`, the Happy message selected for rewind.
    public var forkedFromMessageId: String?
    /// Spawn's `isSideChat`, marks a hidden child.
    public var isSideChat: Bool?

    public init(cutAfterUuid: String? = nil, cutAfterItemId: String? = nil, forkedFromMessageId: String? = nil, isSideChat: Bool? = nil) {
        self.cutAfterUuid = cutAfterUuid
        self.cutAfterItemId = cutAfterItemId
        self.forkedFromMessageId = forkedFromMessageId
        self.isSideChat = isSideChat
    }
}
