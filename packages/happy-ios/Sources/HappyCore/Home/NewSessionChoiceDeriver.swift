import HappyStore
import HappyWire

/// The chooser's catalog and models are projected and compared on this
/// actor. A draft text edit reuses the catalog; unread, message and presence
/// display-clock changes do not rebuild any picker models.
actor NewSessionChoiceDeriver {
    struct DerivedChoices: Sendable {
        var value: NewSessionChoices
        var revision: UInt64
        var renderedRevision: UInt64
        var sessions: [SessionRecord]
    }
    private struct Machine: Equatable {
        var id: String
        var createdAt: Int64
        var active: Bool
        var activeAt: Int64
        var metadata: JSONValue?
    }
    private struct Catalog: Equatable {
        var machines: [Machine]
        var places: [JSONValue?]
        var projectNames: [String: String]
        var overrides: [String: JSONValue]
    }
    private struct Request: Equatable {
        var catalog: UInt64
        var draft: NewSessionDraft
        var createsBot: Bool
        var worktrees: [Worktrees.Entry]
    }

    private let beforeDerivation: @Sendable (HomeSnapshot, NewSessionDraft) async -> Void
    private var snapshotRevision: UInt64?
    private var catalog: Catalog?
    private var catalogVersion: UInt64 = 0
    private var orderedSessions: [SessionRecord] = []
    private var request: Request?
    private var result: DerivedChoices?
    private var rendered: NewSessionChoices?
    private var renderedRevision: UInt64 = 0
    private var latestGeneration: UInt64 = 0
    private(set) var derivationCount = 0
    private(set) var catalogProjectionCount = 0
    private(set) var canonicalPoolBuildCount = 0

    /// The default `beforeDerivation`, compiled once, here, as
    /// `InvalidateSync.taskSleep` explains.
    static let noHook: @Sendable (HomeSnapshot, NewSessionDraft) async -> Void = { _, _ in }

    init(beforeDerivation: @escaping @Sendable (HomeSnapshot, NewSessionDraft) async -> Void = NewSessionChoiceDeriver.noHook) {
        self.beforeDerivation = beforeDerivation
    }

    func choices(snapshot: HomeSnapshot, revision: UInt64, generation: UInt64, draft: NewSessionDraft,
                 createsBot: Bool, worktrees: [Worktrees.Entry]) async -> DerivedChoices? {
        guard generation >= latestGeneration else { return nil }
        latestGeneration = generation
        await beforeDerivation(snapshot, draft)
        guard generation == latestGeneration else { return nil }
        ThreadRules.assertOffMain()
        if snapshotRevision != revision {
            catalogProjectionCount += 1
            canonicalPoolBuildCount += 1
            // happy-app useSessions supplies active chats first, then
            // meaningful activity. Background updatedAt writes do not reorder
            // the picker; side chats never enter its source list.
            let rows = Self.canonicalPool(snapshot.sessions)
            orderedSessions = rows
            let next = Catalog(
                machines: snapshot.machines.machines.map {
                    Machine(id: $0.id, createdAt: $0.createdAt, active: $0.active, activeAt: $0.activeAt, metadata: $0.metadata)
                },
                places: rows.map { row in
                    row.metadata.map { metadata in
                        .object([
                            "bot": .bool(metadata["bot"] != nil && metadata["bot"] != .null),
                            "archived": .bool(metadata["lifecycleState"]?.stringValue == "archived"),
                            "path": metadata["path"]?.stringValue.map(JSONValue.string) ?? .null,
                            "machineId": metadata["machineId"]?.stringValue.map(JSONValue.string) ?? .null,
                            "projectId": metadata["project"]?["id"]?.stringValue.map(JSONValue.string) ?? .null,
                            "projectName": metadata["project"]?["name"]?.stringValue.map(JSONValue.string) ?? .null,
                            "workspace": .bool(metadata["workspace"] != nil && metadata["workspace"] != .null),
                            "workspaceId": metadata["workspace"]?["id"]?.stringValue.map(JSONValue.string) ?? .null,
                            "workspaceName": metadata["workspace"]?["name"]?.stringValue.map(JSONValue.string) ?? .null,
                        ])
                    }
                },
                projectNames: Dictionary(snapshot.projects.compactMap { row in
                    row.metadata?["name"]?.stringValue.map { (row.id, $0) }
                }, uniquingKeysWith: { first, _ in first }),
                overrides: AccountSettings(snapshot.settings).agentDefaultOverrides)
            if next != catalog { catalogVersion &+= 1 }
            catalog = next
            snapshotRevision = revision
        }
        var pickerDraft = draft
        pickerDraft.input = ""
        pickerDraft.updatedAt = 0
        let nextRequest = Request(catalog: catalogVersion, draft: pickerDraft, createsBot: createsBot, worktrees: worktrees)
        result?.sessions = orderedSessions
        if nextRequest == request, let result { return result }
        let next = NewSessionChoices(.init(
            draft: pickerDraft, createsBot: createsBot, machines: snapshot.machines.machines,
            sessions: orderedSessions, projectNames: catalog?.projectNames ?? [:],
            agentDefaultOverrides: catalog?.overrides ?? [:], gitWorktrees: worktrees))
        derivationCount += 1
        request = nextRequest
        if next != result?.value {
            // Private defaults can change future picks without changing a
            // label or option currently shown. Install those values silently.
            var visible = next
            visible.rigSelectionCreation = nil
            visible.cliVersion = nil
            visible.agentDefaultOverrides = [:]
            if visible != rendered { renderedRevision &+= 1; rendered = visible }
            result = DerivedChoices(value: next, revision: (result?.revision ?? 0) &+ 1,
                                    renderedRevision: renderedRevision, sessions: orderedSessions)
        }
        return result
    }

    func launch(snapshot: HomeSnapshot, revision: UInt64, draft: NewSessionDraft,
                bot: (name: String, faceSeed: String)? = nil, prompt: String,
                attachments: [OutgoingAttachment]) -> Result<NewSessionLaunch, NewSessionLaunch.Refusal> {
        ThreadRules.assertOffMain()
        let rows: [SessionRecord]
        if snapshotRevision == revision {
            rows = orderedSessions
        } else {
            canonicalPoolBuildCount += 1
            rows = Self.canonicalPool(snapshot.sessions)
        }
        return NewSessionLaunch.resolve(draft: draft, pickedAgent: draft.pickedAgentType, bot: bot,
                                        machines: snapshot.machines.machines, sessions: rows,
                                        agentDefaultOverrides: AccountSettings(snapshot.settings).agentDefaultOverrides,
                                        prompt: prompt, attachments: attachments)
    }

    private static func canonicalPool(_ sessions: [SessionRecord]) -> [SessionRecord] {
        sessions.filter { $0.metadata?["isSideChat"]?.boolValue != true }.sorted {
            if $0.active != $1.active { return $0.active }
            if $0.lastActivityAt != $1.lastActivityAt { return $0.lastActivityAt > $1.lastActivityAt }
            return $0.id < $1.id
        }
    }
}