import Foundation
import HappyStore
import HappyWire

/// What info.tsx is worked out from: the session's own snapshot, its
/// checkout's status, and what the screen itself decided.
public struct SessionInfoInput: Sendable {
    public var detail: SessionDetailSnapshot?
    public var git: GitStatus?
    /// The fork row's spinner.
    public var forking = false
    /// The resume command's check, for two seconds after a copy.
    public var copiedResumeCommand = false
    /// The "Raw JSON (Dev Mode)" group (Debug builds).
    public var includesRaw = false

    public init(includesRaw: Bool = false) {
        self.includesRaw = includesRaw
    }
}

/// info.tsx reduced to what it draws.
public struct SessionInfoFrame: Equatable, Sendable {
    public enum Content: Equatable, Sendable {
        /// Sessions were never fetched and this one isn't stored.
        case loading
        /// "Session deleted".
        case deleted
        case shown(SessionInfoModel)
    }

    public var content: Content
    public var forking: Bool
    public var copiedResumeCommand: Bool
    /// The raw JSON blocks, in order; empty without the group.
    public var raw: [SessionInfoRawBlock]

    public init(_ input: SessionInfoInput, detail: SessionDetailSnapshot) {
        forking = input.forking
        copiedResumeCommand = input.copiedResumeCommand
        guard let record = detail.session else {
            content = detail.dataReady ? .deleted : .loading
            raw = []
            return
        }
        let permissionMode = detail.composer["permissionMode"]?.stringValue ?? record.metadata?["permissionMode"]?.stringValue
        content = .shown(SessionInfoModel(
            session: record,
            machine: detail.machine,
            settings: AccountSettings(detail.settings),
            gitStatus: input.git,
            permissionMode: permissionMode
        ))
        raw = input.includesRaw ? SessionInfoRawBlock.blocks(record) : []
    }

    public var model: SessionInfoModel? {
        if case .shown(let model) = content { return model }
        return nil
    }

    /// The groups shown, top to bottom.
    public var sections: [SessionInfoSection] {
        guard let model else { return [] }
        var sections: [SessionInfoSection] = [.quickActions]
        if model.cliOutdated { sections.append(.cliWarning) }
        sections.append(.details)
        if model.metadata != nil { sections.append(.metadata) }
        if model.agentState != nil { sections.append(.agentState) }
        sections.append(.activity)
        if !raw.isEmpty { sections.append(.raw) }
        return sections
    }
}

/// info.tsx's groups.
public enum SessionInfoSection: Hashable, Sendable {
    case quickActions
    case cliWarning
    case details
    case metadata
    case agentState
    case activity
    case raw
}

/// One block of the "Raw JSON (Dev Mode)" group, already printed.
public struct SessionInfoRawBlock: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case agentState, metadata, session
    }

    public var kind: Kind
    public var code: String

    public init(kind: Kind, code: String) {
        self.kind = kind
        self.code = code
    }

    /// The agent state and metadata when there are any, then the session.
    static func blocks(_ record: SessionRecord) -> [SessionInfoRawBlock] {
        var blocks: [SessionInfoRawBlock] = []
        if let state = record.agentState, state != .null {
            blocks.append(SessionInfoRawBlock(kind: .agentState, code: SessionDetails.prettyJSON(state)))
        }
        if let metadata = record.metadata, metadata != .null {
            blocks.append(SessionInfoRawBlock(kind: .metadata, code: SessionDetails.prettyJSON(metadata)))
        }
        blocks.append(SessionInfoRawBlock(kind: .session, code: SessionDetails.prettyJSON(.object([
            "id": .string(record.id),
            "seq": .number(Double(record.seq)),
            "createdAt": .number(Double(record.createdAt)),
            "updatedAt": .number(Double(record.updatedAt)),
            "active": .bool(record.active),
            "activeAt": .number(Double(record.activeAt)),
            "metadata": record.metadata ?? .null,
            "metadataVersion": .number(Double(record.metadataVersion)),
            "agentState": record.agentState ?? .null,
            "agentStateVersion": .number(Double(record.agentStateVersion)),
            "thinking": .bool(record.thinking),
            "thinkingAt": .number(Double(record.thinkingAt)),
        ]))))
        return blocks
    }
}

/// What one update changes on the screen.
public struct SessionInfoChanges: Equatable, Sendable {
    /// The screen goes between the list and a loading or deleted state, or
    /// between those two.
    public var state = false
    /// Groups built (again).
    public var rebuilt: Set<SessionInfoSection> = []
    /// "Last updated" and "Sequence" given their new text in place.
    public var lastUpdated = false
    public var sequence = false
    /// Raw JSON blocks given their new text in place, by index.
    public var rawBlocks: [Int] = []
    public var title = false

    public init(state: Bool = false, rebuilt: Set<SessionInfoSection> = [], lastUpdated: Bool = false, sequence: Bool = false,
                rawBlocks: [Int] = [], title: Bool = false) {
        self.state = state
        self.rebuilt = rebuilt
        self.lastUpdated = lastUpdated
        self.sequence = sequence
        self.rawBlocks = rawBlocks
        self.title = title
    }
}

public struct SessionInfoUpdate: Sendable {
    public var frame: SessionInfoFrame
    /// Against the frame on screen.
    public var changes: SessionInfoChanges
}

/// What the screen can show before its own snapshot is read: the title
/// home already has for the session, so the bar has it as the screen
/// slides in.
public struct SessionInfoSeed: Equatable, Sendable {
    /// As `SessionInfoModel.title` reads it; nil reads "New chat".
    public var title: String?

    /// From home's snapshot; nil when home doesn't hold the session, and
    /// the screen waits for its own snapshot as before.
    public init?(_ snapshot: HomeSnapshot?, sessionId: String) {
        guard let record = snapshot?.sessions.first(where: { $0.id == sessionId }) else { return nil }
        title = record.title
    }
}

/// info.tsx off the main thread: the model, the raw JSON and exactly which
/// groups and rows changed against what the screen shows. A new message
/// (a new `updatedAt` and `seq`) retexts two rows; a heartbeat or a cursor
/// derives nothing.
public enum SessionInfoDerivation {
    public static func derive(_ input: SessionInfoInput, applied: SessionInfoFrame?) -> (output: SessionInfoUpdate, state: SessionInfoFrame)? {
        guard let detail = input.detail else { return nil }
        let frame = SessionInfoFrame(input, detail: detail)
        guard frame != applied else { return nil }
        return (SessionInfoUpdate(frame: frame, changes: changes(from: applied, to: frame)), frame)
    }

    static func changes(from old: SessionInfoFrame?, to new: SessionInfoFrame) -> SessionInfoChanges {
        var changes = SessionInfoChanges()
        guard let after = new.model else {
            changes.state = old?.content != new.content
            changes.title = changes.state
            return changes
        }
        guard let old, let before = old.model else {
            changes.state = true
            changes.title = true
            changes.rebuilt = Set(new.sections)
            return changes
        }
        changes.title = before.title != after.title
        let shown = Set(old.sections)
        for section in new.sections {
            guard shown.contains(section) else {
                changes.rebuilt.insert(section)
                continue
            }
            switch section {
            case .quickActions:
                if before.git != after.git || before.machineId != after.machineId || before.resume != after.resume
                    || before.canFork != after.canFork || before.parentSessionId != after.parentSessionId
                    || before.isBot != after.isBot || old.forking != new.forking {
                    changes.rebuilt.insert(section)
                }
            case .cliWarning:
                break
            case .details:
                if before.sessionId != after.sessionId || before.sessionIdShort != after.sessionIdShort
                    || before.claudeSessionId != after.claudeSessionId || before.codexThreadId != after.codexThreadId
                    || before.resumeCommand != after.resumeCommand || old.copiedResumeCommand != new.copiedResumeCommand
                    || before.isConnected != after.isConnected || before.createdAt != after.createdAt {
                    changes.rebuilt.insert(section)
                } else {
                    changes.lastUpdated = before.updatedAt != after.updatedAt
                    changes.sequence = before.seq != after.seq
                }
            case .metadata:
                if before.metadata != after.metadata || before.cliOutdated != after.cliOutdated {
                    changes.rebuilt.insert(section)
                }
            case .agentState:
                if before.agentState != after.agentState { changes.rebuilt.insert(section) }
            case .activity:
                if before.thinking != after.thinking || before.thinkingAt != after.thinkingAt || before.activity != after.activity {
                    changes.rebuilt.insert(section)
                }
            case .raw:
                if old.raw.map(\.kind) != new.raw.map(\.kind) {
                    changes.rebuilt.insert(section)
                } else {
                    changes.rawBlocks = new.raw.indices.filter { old.raw[$0].code != new.raw[$0].code }
                }
            }
        }
        return changes
    }
}
