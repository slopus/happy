import Foundation
import HappyWire

// What a stored session's decrypted metadata and agent state say about it.
// The merge rules need these, so they live with the store; the UI reads the
// same answers.

extension SessionRecord {
    /// `agentState.requests` has an unanswered permission request.
    public var hasPendingPermissionRequests: Bool {
        guard let requests = agentState?["requests"]?.objectValue else { return false }
        return !requests.isEmpty
    }

    /// A bot: one continuous conversation with a named agent (`metadata.bot`).
    public var isBot: Bool {
        metadata?["bot"]?.objectValue != nil
    }

    /// A task: one continuous conversation for one piece of work, with a
    /// folder of its own (`metadata.task`). It lives like a bot (one
    /// conversation for its whole life, stopped only by its machine, never
    /// deleted) but has no face. A session naming both is a bot.
    public var isTask: Bool {
        !isBot && metadata?["task"]?.objectValue != nil
    }

    /// The paired person may archive this task (its owner, or the team's
    /// owner). Absent, as from a daemon that doesn't say, means no.
    public var taskCanArchive: Bool {
        isTask && metadata?["task"]?["canArchive"]?.boolValue == true
    }

    /// The task's machine takes `leaveTask`, which drops it from the paired
    /// person's own list and leaves it running for everyone else.
    public var canLeaveTask: Bool {
        isTask && (metadata?["capabilities"]?["rpcMethods"]?.arrayValue ?? []).contains(.string("leaveTask"))
    }

    /// A Happy Agent session (`metadata.client.id == "rig"`). These stay in
    /// the live list while disconnected; only their lifecycle archives them.
    public var isRig: Bool {
        metadata?["client"]?["id"]?.stringValue == "rig"
    }

    /// A Happy Agent session on rig metadata v1 or later (rig.ts
    /// `isRigMetadataV1`).
    public var isRigV1: Bool {
        SessionMetadata.isRigV1(metadata)
    }

    /// The agent confirms each user message it takes into context
    /// (rig.ts `rigSendsMessageReceipts`).
    public var sendsMessageReceipts: Bool {
        SessionMetadata.sendsMessageReceipts(metadata)
    }

    /// storage.ts `isSessionArchived`, without the local in-flight archive:
    /// archived by its lifecycle, or any other session that is not active.
    public var isArchivedOnServer: Bool {
        metadata?["lifecycleState"]?.stringValue == "archived" || (!isRig && !active)
    }

    /// Archived, or being archived from this device.
    public var isArchived: Bool {
        archiving || isArchivedOnServer
    }

    /// A task archived by its owner or left by the paired person (its machine
    /// archives a left task's session for them alone). Lists drop these
    /// rather than archive them: there is no way back to a task yet.
    public var isRetiredTask: Bool {
        isTask && isArchived
    }
}

/// Checks on decrypted session metadata, for code that holds only the
/// metadata (the chat feed's projection, the message encoder).
public enum SessionMetadata {
    /// rig.ts `isRigMetadataV1`.
    public static func isRigV1(_ metadata: JSONValue?) -> Bool {
        metadata?["client"]?["id"]?.stringValue == "rig" && (metadata?["rigMetadataVersion"]?.numberValue ?? 0) >= 1
    }

    /// rig.ts `rigSendsMessageReceipts`.
    public static func sendsMessageReceipts(_ metadata: JSONValue?) -> Bool {
        isRigV1(metadata) && metadata?["capabilities"]?["messageReceipts"]?.boolValue == true
    }
}
