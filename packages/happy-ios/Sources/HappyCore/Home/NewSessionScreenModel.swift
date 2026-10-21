import Foundation
import HappyStore
import HappyWire

/// What new/index.tsx's phone screen shows for a draft: the config rows,
/// each picker's rows and choice, the composer's harness and settings, and
/// whether Send can be pressed. A pure value, read off the composer's
/// choices whenever they change.
public struct NewSessionScreenModel: Equatable, Sendable {
    /// One picker row (`PickerItem`).
    public struct Item: Equatable, Sendable {
        public var key: String
        public var label: String
        public var subtitle: String?
        /// The heading drawn above the first row of a group.
        public var section: String?
        /// An offline computer, drawn faded but still pickable.
        public var isDimmed: Bool
        /// A computer's state, worded by the screen (`status.online`,
        /// `status.lastSeen`).
        public var status: MachineStatus?
        /// A catalog project offered by identity: picked, never typed.
        public var projectId: String?

        public init(
            key: String,
            label: String,
            subtitle: String? = nil,
            section: String? = nil,
            isDimmed: Bool = false,
            status: MachineStatus? = nil,
            projectId: String? = nil
        ) {
            self.key = key
            self.label = label
            self.subtitle = subtitle
            self.section = section
            self.isDimmed = isDimmed
            self.status = status
            self.projectId = projectId
        }
    }

    public enum MachineStatus: Equatable, Sendable {
        case online
        case lastSeen(ComposerStatus.LastSeen)
    }

    /// One row of the composer's settings popover.
    public struct Setting: Equatable, Sendable {
        public enum Kind: Equatable, Sendable {
            case permission
            case model
            case effort
        }

        public var kind: Kind
        public var value: String
        /// The Ionicons glyph.
        public var icon: String
        public var items: [Item]
        public var selectedKey: String?
    }

    /// The machine row's help while the harness's daemon is offline.
    public enum OfflineHelp: Equatable, Sendable {
        /// `machine.offlineHelp`.
        case happyCLI
        case happyAgent
    }

    public var machineName: String
    public var machineItems: [Item]
    public var selectedMachineKey: String?
    /// Set while the chosen harness's daemon is offline: the place rows
    /// fade and stop taking presses.
    public var offlineHelp: OfflineHelp?

    public var pathName: String
    /// The path field's text.
    public var pathValue: String
    public var pathItems: [Item]
    /// The row drawn as chosen while the draft names a project.
    public var selectedProjectKey: String?
    /// "using project …", while the draft names a project.
    public var selectedProjectName: String?
    /// The row whose directory the field holds.
    public var matchedPathKey: String?
    public var homeDir: String?

    public var canPickWorktree: Bool
    public var picksWorkspaces: Bool
    public var worktreeKey: String
    public var worktreeLabel: String
    public var worktreeFixedItems: [Item]
    public var worktreeItems: [Item]

    public var agentKey: String
    public var agentLabel: String
    public var agentItems: [Item]
    public var placeholder: String
    public var settings: [Setting]
    /// Codex words its permission picker as its own.
    public var isCodex: Bool

    /// `canSend`: a computer whose daemon for the harness is online, and no
    /// start already running. A prompt is not needed.
    public var canSend: Bool

    /// new/index.tsx's `ALL_AGENTS`: lowercased, in the dock's pick order.
    public static let agentLabels: [String: String] = [
        "claude": "claude code",
        "codex": "codex",
        "agy": "antigravity",
        "rig": "happy",
    ]

    public init(choices: NewSessionChoices, draft: NewSessionDraft, snapshot: HomeSnapshot, gitWorktrees: [Worktrees.Entry], isStarting: Bool, now: Int64) {
        let machines = snapshot.machines.machines.sorted { $0.createdAt > $1.createdAt }
        let machineChoices = MachineChoice.collect(machines)
        let choice = MachineChoice.find(in: machineChoices, machineId: draft.selectedMachineId)
        let agent = choices.resolvedAgent.rawValue
        let agentMachine = choice?.machine(forAgent: agent)

        machineName = choice?.name ?? "Select machine"
        // Online first, each group in the catalog's order.
        let sorted = machineChoices.enumerated().sorted { lhs, rhs in
            lhs.element.online != rhs.element.online ? lhs.element.online : lhs.offset < rhs.offset
        }.map(\.element)
        machineItems = sorted.map { choice in
            Item(
                key: choice.id,
                label: choice.name,
                isDimmed: !choice.online,
                status: choice.online ? .online : .lastSeen(ComposerStatus.lastSeen(activeAt: choice.activeAt, now: now))
            )
        }
        selectedMachineKey = choice?.id ?? draft.selectedMachineId
        let isOffline = agentMachine.map { !$0.active } ?? false
        offlineHelp = isOffline ? (agent == "rig" ? .happyAgent : .happyCLI) : nil

        // Both daemons contribute places, whichever harness is chosen.
        let homeDir = choices.homeDir
        self.homeDir = homeDir
        let selectedPath = draft.selectedPath
        let places = choices.sessionPlaces
        let draftProjectId = draft.selectedProjectId
        let draftProjectPlace = draftProjectId.flatMap { id in places.first { $0.projectId == id } }
        var pathItems: [Item] = places.map { place in
            guard let path = place.path else {
                // Only Happy Agent's catalog knows this project's folder.
                return Item(key: place.key, label: place.name, projectId: place.projectId)
            }
            let relative = NewSessionChoices.relativeToHome(path, homeDir: homeDir)
            return Item(
                key: place.key,
                label: place.projectId != nil ? place.name : relative,
                subtitle: place.projectId != nil ? relative : nil
            )
        }
        // The draft's own project keeps its row after its last chat is
        // archived, named by the catalog.
        if let draftProjectId, draftProjectPlace == nil {
            let names = Dictionary(snapshot.projects.compactMap { project in
                project.metadata?["name"]?.stringValue.map { (project.id, $0) }
            }, uniquingKeysWith: { first, _ in first })
            pathItems.append(Item(key: SessionPlaces.projectKey(draftProjectId), label: names[draftProjectId] ?? "Project", projectId: draftProjectId))
        }
        self.pathItems = pathItems
        let selectedProjectKey = draftProjectId.map { draftProjectPlace?.key ?? SessionPlaces.projectKey($0) }
        self.selectedProjectKey = selectedProjectKey
        selectedProjectName = selectedProjectKey.flatMap { key in pathItems.first { $0.key == key }?.label }
        let trimmedPath = (selectedPath ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let draftProjectId {
            pathName = pathItems.first { $0.projectId == draftProjectId }?.label ?? "Project"
        } else {
            pathName = trimmedPath.isEmpty ? "~" : NewSessionChoices.relativeToHome(trimmedPath, homeDir: homeDir)
        }
        pathValue = selectedPath ?? ""
        let normalizedValue = Self.normalizedPath(selectedPath, homeDir: homeDir)
        matchedPathKey = normalizedValue.flatMap { value in
            pathItems.first { Self.normalizedPath($0.key, homeDir: homeDir) == value }?.key
        }

        let picksWorkspaces = choices.picksWorkspaces
        self.picksWorkspaces = picksWorkspaces
        canPickWorktree = choices.supportsWorktree || picksWorkspaces
        worktreeKey = draft.worktreeSelection
        var fixed: [Item] = []
        if choices.canCreateWorktree {
            fixed.append(Item(key: NewSessionDraft.newWorktreeKey, label: picksWorkspaces ? "Create New" : "new worktree"))
        }
        fixed.append(Item(key: NewSessionDraft.noWorktreeKey, label: picksWorkspaces ? "Main" : "no worktree"))
        worktreeFixedItems = fixed
        if picksWorkspaces {
            // A project named only by the catalog has no directory to list
            // workspaces under.
            worktreeItems = normalizedValue == nil ? [] : choices.sessionWorkspaces
                .map { Item(key: $0.key, label: $0.name, subtitle: $0.path) }
        } else {
            worktreeItems = (choices.listsGitWorktrees ? gitWorktrees : []).map { Item(key: $0.path, label: $0.branch, subtitle: $0.path) }
        }
        let worktreeKey = draft.worktreeSelection
        switch worktreeKey {
        case NewSessionDraft.noWorktreeKey: worktreeLabel = picksWorkspaces ? "Main" : "no worktree"
        case NewSessionDraft.newWorktreeKey: worktreeLabel = picksWorkspaces ? "Create New" : "new worktree"
        default: worktreeLabel = worktreeItems.first { $0.key == worktreeKey }?.label ?? worktreeKey
        }

        agentItems = choices.agentOptions.map { Item(key: $0.key, label: Self.agentLabels[$0.key] ?? $0.name) }
        let shown = Self.agentLabels[agent] != nil ? agent : "claude"
        agentKey = shown
        agentLabel = Self.agentLabels[shown] ?? shown
        isCodex = agent == "codex"
        placeholder = agent == "codex" ? "Ask Codex" : "Ask \(agentLabel)"

        var settings: [Setting] = []
        let permissions = choices.permissionOptions.filter { !$0.isDisabled }
        if permissions.count > 1, let current = choices.currentPermission {
            settings.append(Setting(
                kind: .permission,
                value: current.name,
                icon: Self.permissionIcon(current.key) ?? "shield-outline",
                items: permissions.map { Item(key: $0.key, label: $0.name, subtitle: $0.description) },
                selectedKey: current.key
            ))
        }
        if choices.modelOptions.count > 1, let current = choices.currentModel {
            let items = choices.modelSections.flatMap { section in
                section.options.map { option in
                    Item(
                        key: option.key,
                        label: option.name,
                        subtitle: option.description == section.title ? nil : option.description,
                        section: section.title
                    )
                }
            }
            settings.append(Setting(kind: .model, value: current.name, icon: "cube-outline", items: items, selectedKey: current.key))
        }
        if !choices.effortOptions.isEmpty, let current = choices.currentEffort {
            settings.append(Setting(
                kind: .effort,
                value: current.name,
                icon: "speedometer-outline",
                items: choices.effortOptions.map { Item(key: $0.key, label: $0.name, subtitle: $0.description) },
                selectedKey: current.key
            ))
        }
        self.settings = settings

        canSend = draft.selectedMachineId != nil && agentMachine?.active == true && !isStarting
    }

    /// utils/newSessionModeSelection.ts `resolvePermissionStyle`'s icon.
    public static func permissionIcon(_ key: String) -> String? {
        switch key {
        case "acceptEdits", "auto_edit", "dontAsk", "safe-yolo", "bypassPermissions", "yolo": "play-forward"
        case "plan", "read-only": "pause"
        default: nil
        }
    }

    /// `normalizePathForComparison`: trimmed, absolute, without a trailing
    /// separator; nil when blank.
    public static func normalizedPath(_ path: String?, homeDir: String?) -> String? {
        let trimmed = (path ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let absolute = NewSessionChoices.absolutePath(trimmed, homeDir: homeDir)
        if absolute == "/" || absolute.range(of: #"^[A-Za-z]:[\\/]?$"#, options: .regularExpression) != nil {
            return absolute
        }
        var result = Substring(absolute)
        while let last = result.last, last == "/" || last == "\\" { result = result.dropLast() }
        return String(result)
    }

    /// The path a directory row puts in the field: the row's own folder,
    /// as the list words it.
    public func fieldValue(for item: Item) -> String {
        guard item.projectId == nil else { return "" }
        let path = SessionPlaces.projectId(from: item.key) == nil ? item.key : item.label
        return NewSessionChoices.relativeToHome(path, homeDir: homeDir)
    }
}
