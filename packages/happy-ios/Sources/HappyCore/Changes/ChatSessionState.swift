import Foundation
import HappyStore
import HappyWire

/// The session around the chat: its record (metadata, agent state,
/// thinking) and the account settings that change how the chat reads.
///
/// Built off the main thread from the account's home feed, and reduced to
/// what the chat screen draws (`init(_:sessionId:)`), so equal states mean
/// an equal screen and a heartbeat or a cursor bump changes nothing.
public struct ChatSessionState: Equatable, Sendable {
    /// Nil until the session is in the store, and once it is gone from it.
    public var record: SessionRecord?
    public var settings: AccountSettings
    /// happy-app's `isDataReady`: sessions have been fetched at least once,
    /// so a missing record means the session was deleted.
    public var dataReady: Bool
    /// The machine a stopped session ran on, for whether it can be resumed.
    public var machine: MachineRecord?
    /// A stopped session's "last seen" as the composer's status shows it,
    /// at the presence clock (`HomeSnapshot.presenceNow`). It changes only
    /// when the shown text does, so the clock moving changes nothing else.
    public var lastSeen: ComposerStatus.LastSeen?
    public var avatarImage: AvatarImageSource?

    public init(record: SessionRecord?, settings: AccountSettings, dataReady: Bool = false, machine: MachineRecord? = nil, lastSeen: ComposerStatus.LastSeen? = nil, avatarImage: AvatarImageSource? = nil) {
        self.record = record
        self.settings = settings
        self.dataReady = dataReady
        self.machine = machine
        self.lastSeen = lastSeen
        self.avatarImage = avatarImage
    }

    public var metadata: JSONValue? { record?.metadata }
    public var agentState: JSONValue? { record?.agentState }
    public var thinking: Bool { record?.thinking ?? false }

    /// `settings.groupToolCalls`: fold finished turns behind "Worked for …".
    public var groupToolCalls: Bool { settings.bool("groupToolCalls") }
    /// `settings.compactToolCalls`: every tool as a one-line row.
    public var compactToolCalls: Bool { settings.bool("compactToolCalls") }

    /// The terminal has control, so permissions are answered there
    /// (`usesControlledSessionUi && agentState.controlledByUser`).
    public var controlledByUser: Bool {
        guard metadata?["client"]?["id"]?.stringValue != "rig" else { return false }
        return agentState?["controlledByUser"]?.boolValue ?? false
    }

    /// `agentState.requests` is not empty.
    public var hasPendingPermission: Bool { record?.hasPendingPermissionRequests ?? false }

    /// The flavor the session was started with; absent means Claude.
    public var flavor: String? { metadata?["flavor"]?.stringValue }
}

extension ChatSessionState {
    /// Session `sessionId` as the chat screen draws it, from one home
    /// snapshot (one read, so the record and the settings agree). `record`
    /// replaces the stored one (the debug fixtures).
    /// `now` (ms) stands in when the presence clock has not started.
    public init(_ snapshot: HomeSnapshot, sessionId: String, record override: SessionRecord? = nil, now: Int64? = nil) {
        let record = override ?? snapshot.sessions.first { $0.id == sessionId }
        let stopped = record.map { SessionState($0) == .disconnected } ?? false
        // Only a stopped session needs its machine, for resuming.
        let machineId = stopped ? record?.metadata?["machineId"]?.stringValue : nil
        let clock = snapshot.presenceNow ?? now ?? Int64(Date().timeIntervalSince1970 * 1000)
        self.init(
            record: record.map(Self.rendered),
            settings: Self.rendered(AccountSettings(snapshot.settings)),
            dataReady: snapshot.sessionsSynced || !snapshot.sessions.isEmpty,
            machine: machineId.flatMap { id in snapshot.machines.machines.first { $0.id == id } }.map(Self.rendered),
            lastSeen: stopped ? record.map { ComposerStatus.lastSeen(activeAt: $0.activeAt, now: clock) } : nil,
            avatarImage: record.flatMap { record in
                AvatarImageSource.resolve(record, project: snapshot.projects.first { $0.id == record.projectReference })
            }
        )
    }

    /// `record` with every field the chat, its header, dock and composer
    /// never read cleared: sync cursors, versions, ciphertexts, the local
    /// unread flag, `updatedAt` (moves with every message) and `activeAt`
    /// while the session is online (moves with every heartbeat; only a
    /// stopped session shows when it was last seen).
    public static func rendered(_ record: SessionRecord) -> SessionRecord {
        var record = record
        record.seq = 0
        record.updatedAt = 0
        record.lastMessageSentAt = nil
        if record.active { record.activeAt = 0 }
        record.metadataVersion = 0
        record.metadataCipher = ""
        record.agentStateVersion = 0
        record.agentStateCipher = nil
        record.dataKeyCipher = nil
        record.syncedMessageSeq = 0
        record.thinkingAt = 0
        record.unread = false
        record.avatar = nil
        record.avatarVersion = nil
        record.avatarUpdateSeq = nil
        // Home orders by it; the chat never shows it.
        if case .object(var fields)? = record.metadata, fields["lastMeaningfulMessageAt"] != nil {
            fields["lastMeaningfulMessageAt"] = nil
            record.metadata = .object(fields)
        }
        return record
    }

    /// The settings the chat, its header and dock, the composer and a
    /// message's screen read. Anything else is left at its default, so a
    /// change to it changes nothing here. A new read of a setting through
    /// `ChatSessionState` must add its key.
    public static let renderedSettings: Set<String> = [
        "showHarnessIconInSessionHeader", "avatarStyle", "avatarMonochrome",
        "userMessageBubbleColor", "showLineNumbersInToolViews", "groupToolCalls", "compactToolCalls",
        "alwaysShowContextSize", "usageLimitShowRemaining", "agentDefaultOverrides",
    ]

    public static func rendered(_ settings: AccountSettings) -> AccountSettings {
        AccountSettings(settings.values.filter { renderedSettings.contains($0.key) })
    }

    /// What resuming reads from a machine: whether it is online and what
    /// it supports. Its heartbeats and versions are cleared.
    public static func rendered(_ machine: MachineRecord) -> MachineRecord {
        var machine = machine
        machine.seq = 0
        machine.createdAt = 0
        machine.updatedAt = 0
        machine.activeAt = 0
        machine.metadataVersion = 0
        machine.metadataCipher = ""
        machine.daemonStateVersion = 0
        machine.daemonStateCipher = nil
        machine.daemonState = nil
        machine.dataKeyCipher = nil
        return machine
    }
}
