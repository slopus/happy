import Foundation
import HappyWire

/// What the composer will start: the place, the harness and its modes
/// (sync/persistence.ts `NewSessionDraft`). Persisted per account under
/// happy-app's key, so the dock and the new-session screen open on the
/// last choices.
public struct NewSessionDraft: Equatable, Sendable {
    /// `NewSessionAgentType`.
    public enum Agent: String, CaseIterable, Sendable {
        case claude, codex, gemini, openclaw, agy, rig

        /// The harness's defaults, for every agent but Happy Agent, whose
        /// machine publishes its own.
        public var defaultsAgent: AgentDefaults.Agent? {
            AgentDefaults.Agent(rawValue: rawValue)
        }

        /// utils/harnessCatalog.ts `getHarnessName`.
        public var name: String {
            defaultsAgent?.name ?? "Happy"
        }
    }

    public enum SessionType: String, Sendable {
        case simple, worktree
    }

    public static let storageKey = "new-session-draft-v1"
    /// The worktree picker's "Create New" and "No worktree"/"Main" rows.
    public static let newWorktreeKey = "__new__"
    public static let noWorktreeKey = "__none__"

    public var input: String
    public var selectedMachineId: String?
    public var selectedPath: String?
    /// A project only Happy Agent's catalog knows the folder of. Exactly
    /// one of this and `selectedPath` names the place.
    public var selectedProjectId: String?
    /// Follows what the selected computer can run.
    public var agentType: Agent
    /// The harness last picked by hand, kept until another is picked.
    public var pickedAgentType: Agent?
    public var permissionMode: String?
    public var modelMode: String?
    public var effortLevel: String?
    public var sessionType: SessionType
    public var worktreeKey: String?
    public var updatedAt: Int64

    public init(
        input: String = "",
        selectedMachineId: String? = nil,
        selectedPath: String? = nil,
        selectedProjectId: String? = nil,
        agentType: Agent = .claude,
        pickedAgentType: Agent? = nil,
        permissionMode: String? = nil,
        modelMode: String? = nil,
        effortLevel: String? = nil,
        sessionType: SessionType = .simple,
        worktreeKey: String? = nil,
        updatedAt: Int64 = 0
    ) {
        self.input = input
        self.selectedMachineId = selectedMachineId
        self.selectedPath = selectedPath
        self.selectedProjectId = selectedProjectId
        self.agentType = agentType
        self.pickedAgentType = pickedAgentType
        self.permissionMode = permissionMode
        self.modelMode = modelMode
        self.effortLevel = effortLevel
        self.sessionType = sessionType
        self.worktreeKey = worktreeKey
        self.updatedAt = updatedAt
    }

    /// The picker's worktree row: "Create New" while a worktree is asked
    /// for without one named, the named one, or none.
    public var worktreeSelection: String {
        sessionType == .worktree ? worktreeKey ?? Self.newWorktreeKey : Self.noWorktreeKey
    }

    /// `loadNewSessionDraft`: every field read leniently, so a draft from
    /// an older app still opens.
    public init?(json: String, now: Int64) {
        guard let value = try? JSONValue.decode(Data(json.utf8)), value.objectValue != nil else { return nil }
        func string(_ key: String) -> String? { value[key]?.stringValue }
        self.init(
            input: string("input") ?? "",
            selectedMachineId: string("selectedMachineId"),
            selectedPath: string("selectedPath"),
            selectedProjectId: string("selectedProjectId"),
            agentType: string("agentType").flatMap(Agent.init(rawValue:)) ?? .claude,
            pickedAgentType: string("pickedAgentType").flatMap(Agent.init(rawValue:)),
            permissionMode: string("permissionMode"),
            modelMode: string("modelMode"),
            effortLevel: string("effortLevel"),
            sessionType: string("sessionType") == SessionType.worktree.rawValue ? .worktree : .simple,
            worktreeKey: string("worktreeKey"),
            updatedAt: value["updatedAt"]?.numberValue.map { Int64($0) } ?? now
        )
    }

    /// `saveNewSessionDraft`'s JSON, nulls included.
    public var json: String {
        func optional(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
        let value = JSONValue.object([
            "input": .string(input),
            "selectedMachineId": optional(selectedMachineId),
            "selectedPath": optional(selectedPath),
            "selectedProjectId": optional(selectedProjectId),
            "agentType": .string(agentType.rawValue),
            "pickedAgentType": optional(pickedAgentType?.rawValue),
            "permissionMode": optional(permissionMode),
            "modelMode": optional(modelMode),
            "effortLevel": optional(effortLevel),
            "sessionType": .string(sessionType.rawValue),
            "worktreeKey": optional(worktreeKey),
            "updatedAt": .number(Double(updatedAt)),
        ])
        return (try? value.encodedString()) ?? "{}"
    }
}

/// utils/botName.ts: the daemon's rule for a bot's name.
public enum BotName {
    public static let maxLength = 256

    /// What the name field keeps: control characters become spaces and the
    /// daemon's ceiling is applied.
    public static func sanitize(_ input: String) -> String {
        String(String(input.unicodeScalars.map { isControl($0) ? " " : Character($0) }).prefix(maxLength))
    }

    public static func isValid(_ name: String) -> Bool {
        problem(name) == nil
    }

    /// Why a name is refused, or nil.
    public static func problem(_ name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "Give the bot a name" }
        if trimmed.utf16.count > maxLength { return "A bot's name is at most \(maxLength) characters" }
        if trimmed.unicodeScalars.contains(where: isControl) { return "A bot's name cannot contain line breaks or control characters" }
        return nil
    }

    private static func isControl(_ scalar: Unicode.Scalar) -> Bool {
        scalar.value < 0x20 || scalar.value == 0x7f
    }
}

/// The bot the composer would make: whether it makes one, the name, and the
/// faces on offer with the one picked.
public struct NewSessionBotDraft: Equatable, Sendable {
    public var createsBot: Bool
    public var botName: String
    public var faceSeeds: [String]
    public var faceSlot: Int

    public init(createsBot: Bool, botName: String, faceSeeds: [String], faceSlot: Int) {
        self.createsBot = createsBot
        self.botName = botName
        self.faceSeeds = faceSeeds
        self.faceSlot = faceSlot
    }
}

/// The draft as the composer edits it (hooks/useNewSessionDraft.ts): the
/// persisted part, plus what only lives while the app runs. One per
/// account, shared by the dock and the new-session screen.
@MainActor
public final class NewSessionDraftStore {
    public private(set) var draft: NewSessionDraft
    /// Making a bot rather than a session. Not persisted: a restarted app
    /// offers a session.
    public private(set) var createsBot = false
    public private(set) var botName = ""
    /// The four faces on offer, as seeds; `botFaceSlot` says which one the
    /// bot gets.
    public private(set) var botFaceSeeds = NewSessionDraftStore.rollBotFaceSeeds()
    public private(set) var botFaceSlot = 0
    /// Files picked for the first message; temporary, so never persisted.
    public var attachments: [OutgoingAttachment] = []

    private let settings: LocalSettings
    private let now: () -> Int64
    private var observers: [UUID: (NewSessionDraftStore) -> Void] = [:]

    public init(settings: LocalSettings, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.settings = settings
        self.now = now
        draft = settings.newSessionDraft ?? NewSessionDraft()
    }

    private static var stores: [ObjectIdentifier: (settings: LocalSettings, store: NewSessionDraftStore)] = [:]

    /// The account's store: one per `LocalSettings`, which is one per
    /// signed-in account.
    public static func shared(for settings: LocalSettings) -> NewSessionDraftStore {
        let key = ObjectIdentifier(settings)
        if let entry = stores[key], entry.settings === settings { return entry.store }
        stores = stores.filter { $0.value.settings !== settings }
        let store = NewSessionDraftStore(settings: settings)
        stores[key] = (settings, store)
        return store
    }

    /// Calls `handler` after every change until the token is released.
    public func observe(_ handler: @escaping (NewSessionDraftStore) -> Void) -> AccountsObservation {
        let id = UUID()
        observers[id] = handler
        return AccountsObservation { [weak self] in
            Task { @MainActor [weak self] in _ = self?.observers.removeValue(forKey: id) }
        }
    }

    public func setInput(_ input: String) { update { $0.input = input } }

    /// A different computer: the place means nothing there, so it goes.
    public func setMachineId(_ id: String?) {
        update {
            $0.selectedMachineId = id
            $0.selectedPath = nil
            $0.selectedProjectId = nil
            $0.worktreeKey = nil
        }
    }

    /// The same computer under the id it should have had: the place stays.
    public func renameMachineId(_ id: String?) { update { $0.selectedMachineId = id } }

    public func setPath(_ path: String?) {
        update {
            $0.selectedPath = path
            $0.selectedProjectId = nil
            $0.worktreeKey = nil
        }
    }

    /// A catalog project, in place of any directory.
    public func setProjectId(_ id: String?) {
        update {
            $0.selectedProjectId = id
            $0.selectedPath = nil
            $0.worktreeKey = nil
        }
    }

    public func setAgentType(_ agent: NewSessionDraft.Agent) { update { $0.agentType = agent } }

    /// The person's own harness choice.
    public func pickAgentType(_ agent: NewSessionDraft.Agent) {
        update {
            $0.agentType = agent
            $0.pickedAgentType = agent
        }
    }

    /// HomeDock.tsx `selectAgent`: the harness, and the modes it starts on.
    /// `picked` is the person's own choice, which outlives this draft's
    /// computer.
    public func selectAgent(_ agent: NewSessionDraft.Agent, picked: Bool, defaults: AgentDefaults.Config) {
        update {
            $0.agentType = agent
            if picked { $0.pickedAgentType = agent }
            $0.permissionMode = defaults.permissionMode
            $0.modelMode = defaults.modelMode
            if let effort = defaults.effortLevel, !effort.isEmpty { $0.effortLevel = effort }
        }
    }

    public func setPermissionMode(_ mode: String) { update { $0.permissionMode = mode } }
    public func setModelMode(_ mode: String) { update { $0.modelMode = mode } }
    public func setEffortLevel(_ level: String) { update { $0.effortLevel = level } }
    public func setSessionType(_ type: NewSessionDraft.SessionType) { update { $0.sessionType = type } }
    public func setWorktreeKey(_ key: String?) { update { $0.worktreeKey = key } }

    /// The worktree picker's choice: none, "Create New", or a named one.
    public func selectWorktree(_ key: String) {
        update {
            $0.sessionType = key == NewSessionDraft.noWorktreeKey ? .simple : .worktree
            $0.worktreeKey = key == NewSessionDraft.noWorktreeKey || key == NewSessionDraft.newWorktreeKey ? nil : key
        }
    }

    /// ProjectRow's `+` (ProjectHomeList.tsx `createWorkspace`): the
    /// project's computer and place, asking for a new workspace. A catalog
    /// project is an identity, so the harness moves to Happy Agent.
    public func prepareWorkspace(_ origin: WorkspaceOrigin) {
        setMachineId(origin.machineId)
        if let projectId = origin.projectId {
            pickAgentType(.rig)
            setProjectId(projectId)
        } else {
            setPath(origin.path)
        }
        setSessionType(.worktree)
        setWorktreeKey(nil)
    }

    public func setCreatesBot(_ value: Bool) {
        createsBot = value
        notify()
    }

    public func setBotName(_ name: String) {
        botName = name
        notify()
    }

    public func setBotFaceSlot(_ slot: Int) {
        guard botFaceSeeds.indices.contains(slot) else { return }
        botFaceSlot = slot
        notify()
    }

    /// Four new faces; the slot stays where it was.
    public func rollBotFaces() {
        botFaceSeeds = Self.rollBotFaceSeeds()
        notify()
    }

    /// The face the bot gets.
    public var botFaceSeed: String {
        botFaceSeeds[botFaceSlot]
    }

    /// What a bot start reads off the composer (`botUnchanged`).
    public var bot: NewSessionBotDraft {
        NewSessionBotDraft(createsBot: createsBot, botName: botName, faceSeeds: botFaceSeeds, faceSlot: botFaceSlot)
    }

    /// utils/botFace.ts `rollBotFaceSeeds`: four seeds of eight base-36
    /// characters, far more faces than there are bots.
    public static func rollBotFaceSeeds() -> [String] {
        var generator = SystemRandomNumberGenerator()
        return rollBotFaceSeeds(using: &generator)
    }

    static func rollBotFaceSeeds<G: RandomNumberGenerator>(using generator: inout G) -> [String] {
        let digits = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        return (0..<4).map { _ in String((0..<8).map { _ in digits[Int.random(in: 0..<digits.count, using: &generator)] }) }
    }

    private func update(_ change: (inout NewSessionDraft) -> Void) {
        change(&draft)
        draft.updatedAt = now()
        settings.newSessionDraft = draft
        notify()
    }

    private func notify() {
        for observer in observers.values { observer(self) }
    }
}
