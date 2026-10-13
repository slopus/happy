import Foundation
import HappyStore
import HappyWire

/// Everything the composer offers for a draft, and what each picker shows
/// as chosen (HomeDock.tsx, from `machineChoices` to `focusedPromptPlaceholder`).
/// A pure value: built again whenever the draft or the store changes.
public struct NewSessionChoices: Equatable, Sendable {
    /// One row of a picker.
    public struct Option: Equatable, Sendable {
        public var key: String
        public var name: String
        public var description: String?
        /// "Enter custom path…": an action, never drawn as chosen.
        public var isAction: Bool
        /// Listed but not pickable (a mode the CLI can't run).
        public var isDisabled: Bool

        public init(key: String, name: String, description: String? = nil, isAction: Bool = false, isDisabled: Bool = false) {
            self.key = key
            self.name = name
            self.description = description
            self.isAction = isAction
            self.isDisabled = isDisabled
        }

        init(_ mode: ModeOption) {
            self.init(key: mode.key, name: mode.name, description: mode.description, isDisabled: mode.isDisabled)
        }
    }

    /// One group of a picker, headed the way the model menu heads a
    /// provider.
    public struct Section: Equatable, Sendable {
        public var key: String
        public var title: String?
        public var options: [Option]
    }

    /// What the composer reads the draft against.
    public struct Inputs: Sendable {
        public var draft: NewSessionDraft
        public var createsBot: Bool
        public var machines: [MachineRecord]
        /// Newest first, as the session list keeps them.
        public var sessions: [SessionRecord]
        public var projectNames: [String: String]
        public var agentDefaultOverrides: [String: JSONValue]
        /// `git worktree list` on the selected computer, when it is asked.
        public var gitWorktrees: [Worktrees.Entry]

        public init(
            draft: NewSessionDraft,
            createsBot: Bool = false,
            machines: [MachineRecord],
            sessions: [SessionRecord],
            projectNames: [String: String] = [:],
            agentDefaultOverrides: [String: JSONValue] = [:],
            gitWorktrees: [Worktrees.Entry] = []
        ) {
            self.draft = draft
            self.createsBot = createsBot
            self.machines = machines
            self.sessions = sessions
            self.projectNames = projectNames
            self.agentDefaultOverrides = agentDefaultOverrides
            self.gitWorktrees = gitWorktrees
        }

        public init(draft: NewSessionDraft, createsBot: Bool, snapshot: HomeSnapshot, gitWorktrees: [Worktrees.Entry] = []) {
            self.init(
                draft: draft,
                createsBot: createsBot,
                machines: snapshot.machines.machines,
                sessions: snapshot.sessions,
                projectNames: Dictionary(snapshot.projects.compactMap { project in
                    project.metadata?["name"]?.stringValue.map { (project.id, $0) }
                }, uniquingKeysWith: { first, _ in first }),
                agentDefaultOverrides: AccountSettings(snapshot.settings).agentDefaultOverrides,
                gitWorktrees: gitWorktrees
            )
        }
    }

    public static let customPathKey = "__custom_project_path__"

    public var machineOptions: [Option]
    public var currentMachine: Option?
    /// The draft's machine as it should be stored: the computer's id, or the
    /// first (online-first) option when the stored one is gone. Nil while
    /// the catalog is empty, which can be a sync still arriving.
    public var resolvedMachineId: String?
    public var homeDir: String?

    public var projectOptions: [Option]
    public var currentProject: Option?
    public var selectedProjectId: String?
    /// Prepared from the same canonical pool used by the picker and launch.
    public var sessionPlaces: [NewSessionPlace]
    public var sessionWorkspaces: [SessionWorkspace]
    /// Happy Agent calls these workspaces and names them; git calls them
    /// worktrees.
    public var picksWorkspaces: Bool

    /// Happy Agent on this computer can make bots.
    public var supportsBots: Bool
    public var supportsWorktree: Bool
    public var canCreateWorktree: Bool
    public var worktreeOptions: [Option]
    public var currentWorktree: Option?
    public var worktreeSelection: String
    /// Git worktrees are listed only while the place is a plain directory
    /// on an online Happy CLI machine.
    public var listsGitWorktrees: Bool
    /// The Happy CLI machine to list them on, in `resolvedPath`.
    public var gitWorktreeMachineId: String?
    /// The draft's directory, absolute on the selected computer.
    public var resolvedPath: String

    public var agentOptions: [Option]
    public var hasAvailableHarness: Bool
    /// The harness the computer settles the draft on.
    public var resolvedAgent: NewSessionDraft.Agent
    public var currentAgent: Option

    public var permissionOptions: [Option]
    public var modelOptions: [Option]
    public var modelSections: [Section]
    public var effortOptions: [Option]
    public var currentPermission: Option?
    public var currentModel: Option?
    public var currentEffort: Option?

    /// The permission chip: the mode's first word.
    public var permissionLabel: String?
    /// The model chip, cut for the native trigger.
    public var modelChipLabel: String
    /// "Ask Claude Code", or "Name your bot".
    public var promptPlaceholder: String

    /// What the harness defaults are read against (`defaults(for:)`).
    var rigSelectionCreation: RigSessionCreation?
    var cliVersion: String?
    var agentDefaultOverrides: [String: JSONValue]

    public init(_ inputs: Inputs) {
        let draft = inputs.draft
        let machines = inputs.machines.sorted { $0.createdAt > $1.createdAt }
        let choices = MachineChoice.collect(machines)
        let selectedChoice = MachineChoice.find(in: choices, machineId: draft.selectedMachineId)

        let sortedChoices = choices.enumerated().sorted { lhs, rhs in
            lhs.element.online != rhs.element.online ? lhs.element.online : lhs.offset < rhs.offset
        }.map(\.element)
        machineOptions = sortedChoices.map { Option(key: $0.id, name: $0.name) }
        currentMachine = Self.resolve(machineOptions, [selectedChoice?.id])
        resolvedMachineId = Self.resolveMachineSelection(selectedChoice?.id ?? draft.selectedMachineId, available: machineOptions.map(\.key))
        let homeDir = selectedChoice?.happyMachine?.metadata?["homeDir"]?.stringValue
            ?? selectedChoice?.rigMachine?.metadata?["homeDir"]?.stringValue
        self.homeDir = homeDir

        // The places belong to the computer, so both daemons are read.
        let placeMachineIds = selectedChoice?.machineIds ?? []
        let selectedPath = draft.selectedPath
        let places = SessionPlaces.collect(machineIds: placeMachineIds, sessions: inputs.sessions, selectedPath: selectedPath ?? "~")
        // The phone's catalog-project screen has no typed path. Home's
        // picker still offers its default '~' row for an empty path.
        sessionPlaces = selectedPath == nil
            ? SessionPlaces.collect(machineIds: placeMachineIds, sessions: inputs.sessions)
            : places
        let rigSelectionCreation = RigSessionCreation(metadata: selectedChoice?.rigMachine?.metadata)

        let draftProjectId = draft.selectedProjectId
        let draftProjectPlace = draftProjectId.flatMap { id in places.first { $0.projectId == id } }
        let draftProjectKey = draftProjectId.map { draftProjectPlace?.key ?? SessionPlaces.projectKey($0) }
        var projects: [Option] = places.compactMap { place in
            guard let path = place.path else {
                // Only Happy Agent can open a project nothing here has the
                // folder for.
                return rigSelectionCreation == nil ? nil : Option(key: place.key, name: place.name)
            }
            let relative = Self.relativeToHome(path, homeDir: homeDir)
            let name = place.projectId != nil ? place.name : relative
            return Option(key: place.key, name: name, description: name == path ? nil : relative)
        }
        // The draft's own project keeps its row after its last chat is
        // archived, named from the catalog.
        if let draftProjectId, draftProjectPlace == nil {
            projects.append(Option(key: SessionPlaces.projectKey(draftProjectId), name: inputs.projectNames[draftProjectId] ?? "Project"))
        }
        projectOptions = projects
        let selectedProjectId = draftProjectId ?? places.first { $0.path == selectedPath }?.projectId
        self.selectedProjectId = selectedProjectId
        currentProject = Self.resolve(projectOptions, [draftProjectKey, selectedPath, "~"])

        let agent = draft.agentType
        let rigCreation = agent == .rig ? rigSelectionCreation : nil
        supportsBots = rigSelectionCreation?.supportsBots == true
        let supportsWorktree = rigCreation?.supportsWorktrees ?? (agent == .rig ? false : Self.supportsWorktree(agent))
        self.supportsWorktree = supportsWorktree
        worktreeSelection = draft.worktreeSelection
        let picksWorkspaces = selectedProjectId != nil
        self.picksWorkspaces = picksWorkspaces
        resolvedPath = Self.absolutePath(selectedPath ?? "~", homeDir: homeDir)

        let happyMachine = selectedChoice?.happyMachine
        let listsGitWorktrees = !picksWorkspaces && supportsWorktree && happyMachine?.active == true
        self.listsGitWorktrees = listsGitWorktrees
        gitWorktreeMachineId = listsGitWorktrees ? happyMachine?.id : nil
        sessionWorkspaces = SessionPlaces.workspaces(machineIds: placeMachineIds, projectId: selectedProjectId, sessions: inputs.sessions)
        let existing: [Option] = picksWorkspaces
            ? sessionWorkspaces.map { Option(key: $0.key, name: $0.name, description: $0.path) }
            : (listsGitWorktrees ? inputs.gitWorktrees : []).map { Option(key: $0.path, name: $0.branch, description: $0.path) }
        let createsNativeWorkspace = agent == .rig && picksWorkspaces && rigCreation != nil
        let creationMachine = selectedChoice?.worktreeCreationMachine(agent: agent.rawValue, agentSupportsWorktrees: supportsWorktree)
        let canCreateWorktree = createsNativeWorkspace || (agent != .rig && creationMachine != nil)
        self.canCreateWorktree = canCreateWorktree
        if !supportsWorktree && !picksWorkspaces {
            worktreeOptions = [Option(key: NewSessionDraft.noWorktreeKey, name: "No worktree", description: "Not supported by \(agent.name)")]
        } else {
            var options: [Option] = []
            if canCreateWorktree {
                options.append(Option(key: NewSessionDraft.newWorktreeKey, name: picksWorkspaces ? "Create New Workspace" : "Create New Worktree"))
            }
            // No workspace is the project's own checkout: a place with a name.
            options.append(Option(key: NewSessionDraft.noWorktreeKey, name: picksWorkspaces ? "Main" : "No worktree"))
            options += existing
            if let key = draft.worktreeKey, !options.contains(where: { $0.key == key }) {
                options.append(Option(key: key, name: key))
            }
            worktreeOptions = options
        }
        currentWorktree = Self.resolve(worktreeOptions, [worktreeSelection])

        let available = (selectedChoice?.availableAgents ?? []).compactMap(NewSessionDraft.Agent.init(rawValue:))
        agentOptions = available.map { Option(key: $0.rawValue, name: $0.name) }
        hasAvailableHarness = !agentOptions.isEmpty
        resolvedAgent = selectedChoice.flatMap {
            NewSessionDraft.Agent(rawValue: $0.resolveNewSessionAgent(stored: agent.rawValue, picked: draft.pickedAgentType?.rawValue))
        } ?? agent
        currentAgent = agentOptions.first { $0.key == agent.rawValue }
            ?? agentOptions.first
            ?? Option(key: agent.rawValue, name: agent.name)

        let cliVersion = selectedChoice?.happyMachine?.metadata?["happyCliVersion"]?.stringValue
        self.cliVersion = cliVersion
        self.rigSelectionCreation = rigSelectionCreation
        agentDefaultOverrides = inputs.agentDefaultOverrides
        let modes = Self.modes(
            agent: agent,
            rig: rigCreation,
            picks: ComposerPicks(permissionMode: draft.permissionMode, modelMode: draft.modelMode, effortLevel: draft.effortLevel),
            overrides: inputs.agentDefaultOverrides,
            cliVersion: cliVersion
        )
        permissionOptions = modes.permissions
        modelOptions = modes.models
        modelSections = modes.modelSections
        effortOptions = modes.efforts
        currentPermission = modes.permission
        currentModel = modes.model
        currentEffort = modes.effort

        permissionLabel = currentPermission.flatMap { PermissionModeLabels.shortLabel(ModeOption(key: $0.key, name: $0.name)) }
        modelChipLabel = ModelModeOptions.truncateModelLabel(currentModel?.name ?? currentAgent.name)
        promptPlaceholder = inputs.createsBot
            ? "Name your bot"
            : Self.promptPlaceholder(agentKey: currentAgent.key, agentName: currentAgent.name)
    }

    // MARK: Pieces shared with the start

    /// What the permission, model and effort pickers offer, and what each
    /// shows as chosen.
    struct Modes {
        var permissions: [Option]
        var models: [Option]
        var modelSections: [Section]
        var efforts: [Option]
        var permission: Option?
        var model: Option?
        var effort: Option?
    }

    /// The modes a harness offers on this computer, with `picks` read
    /// against them: Happy Agent's from its machine, the others from
    /// Composer's new-session catalogs (`ComposerModes.newSession`).
    static func modes(
        agent: NewSessionDraft.Agent,
        rig: RigSessionCreation?,
        picks: ComposerPicks,
        overrides: [String: JSONValue],
        cliVersion: String?
    ) -> Modes {
        if let rig {
            let models = rig.models.map {
                ModeOption(key: $0.key, name: $0.name, description: $0.description, providerId: $0.providerId, providerName: $0.providerName)
            }
            let permissions = rig.permissionModes.map { Option(key: $0.key, name: $0.name, description: $0.description) }
            let modelOptions = models.map(Option.init)
            let model = resolve(modelOptions, [picks.modelMode, rig.defaultModelKey])
            let efforts = rig.efforts(forModel: model?.key).map { Option(key: $0, name: $0) }
            let effortDefault = rig.defaultEffort(forModel: model?.key) ?? rig.defaultEffort(forModel: rig.defaultModelKey)
            return Modes(
                permissions: permissions,
                models: modelOptions,
                modelSections: sections(models),
                efforts: efforts,
                permission: resolve(permissions, [picks.permissionMode, rig.defaultPermissionMode]),
                model: model,
                effort: resolve(efforts, [picks.effortLevel, effortDefault])
            )
        }
        let modes = ComposerModes.newSession(
            agentType: agent.rawValue,
            picks: picks,
            agentDefaultOverrides: overrides,
            cliVersion: cliVersion
        )
        return Modes(
            permissions: modes.availableModes.map(Option.init),
            models: modes.availableModels.map(Option.init),
            modelSections: sections(modes.availableModels),
            efforts: modes.availableEffortLevels.map(Option.init),
            permission: modes.permissionMode.map(Option.init),
            model: modes.modelMode.map(Option.init),
            effort: modes.effortLevel.map(Option.init)
        )
    }

    /// The model menu, one section per provider.
    static func sections(_ models: [ModeOption]) -> [Section] {
        ModelModeOptions.groupByProvider(models).map { group in
            Section(key: group.key, title: group.title, options: group.models.map(Option.init))
        }
    }

    /// The defaults a harness starts on when it is chosen (`selectAgent`):
    /// Happy Agent's from its machine, the others the account's.
    public func defaults(for agent: NewSessionDraft.Agent) -> AgentDefaults.Config {
        if agent == .rig {
            let rig = rigSelectionCreation
            return AgentDefaults.Config(
                permissionMode: rig?.defaultPermissionMode ?? "",
                modelMode: rig?.defaultModelKey ?? "",
                effortLevel: rig?.defaultEffort(forModel: rig?.defaultModelKey)
            )
        }
        return AgentDefaults.resolve(agentDefaultOverrides, AgentDefaults.Agent(flavor: agent.rawValue), cliVersion: cliVersion)
    }

    /// `getSupportsWorktree`.
    static func supportsWorktree(_ agent: NewSessionDraft.Agent) -> Bool {
        ModelModeOptions.supportsWorktree(flavor: agent.rawValue)
    }

    /// The first option named, else the first option.
    static func resolve(_ options: [Option], _ preferred: [String?]) -> Option? {
        for key in preferred {
            if let key, let option = options.first(where: { $0.key == key }) { return option }
        }
        return options.first
    }

    /// `resolveHomeDockMachineSelection`.
    public static func resolveMachineSelection(_ selected: String?, available: [String]) -> String? {
        // An empty catalog can be a sync still arriving: keep the choice.
        guard !available.isEmpty else { return selected }
        if let selected, available.contains(selected) { return selected }
        return available.first
    }

    /// `resolveHomeDockPromptPlaceholder`.
    public static func promptPlaceholder(agentKey: String, agentName: String) -> String {
        switch agentKey {
        case "claude": "Ask Claude Code"
        case "codex": "Ask Codex"
        default: "Ask \(agentName)"
        }
    }

    /// utils/pathUtils.ts `resolveAbsolutePath`.
    public static func absolutePath(_ path: String, homeDir: String?) -> String {
        guard path.hasPrefix("~"), let homeDir, !homeDir.isEmpty else { return path }
        let normalized = homeDir.hasSuffix("/") || homeDir.hasSuffix("\\") ? String(homeDir.dropLast()) : homeDir
        if path == "~" { return normalized }
        guard path.hasPrefix("~/") else { return path }
        let backslash = homeDir.lastIndex(of: "\\").map { index in
            homeDir.lastIndex(of: "/").map { index > $0 } ?? true
        } ?? false
        return normalized + (backslash ? "\\" : "/") + path.dropFirst(2)
    }

    /// utils/sessionUtils.ts `formatPathRelativeToHome`.
    public static func relativeToHome(_ path: String, homeDir: String?) -> String {
        guard let homeDir, !homeDir.isEmpty else { return path }
        let home = homeDir.hasSuffix("/") ? String(homeDir.dropLast()) : homeDir
        guard path.hasPrefix(home) else { return path }
        let rest = path.dropFirst(home.count)
        if rest.hasPrefix("/") { return "~" + rest }
        return rest.isEmpty ? "~" : "~/" + rest
    }
}

extension NewSessionLaunch {
    /// Why a start can't begin, in happy-app's words.
    public enum Refusal: Error, Equatable, LocalizedError {
        case selectMachine
        case machineNotRegistered
        case botName(String)
        case happyAgentNotRunning
        case happyCLIUnavailable
        case machineOffline
        case happyCLIOffline
        case cannotStartHappyAgent
        case cannotCreateBots
        case configurationUnavailable
        case projectNeedsHappyAgent
        case workspace(String)

        public var errorDescription: String? {
            switch self {
            case .selectMachine: "Please select a machine"
            case .machineNotRegistered: "This session’s computer is not registered with this account, so nothing can start a session on it. Check that Happy is running there and signed in to this account."
            case .botName(let problem): problem
            case .happyAgentNotRunning: "Happy Agent is not running on this computer"
            case .happyCLIUnavailable: "Happy CLI is not available on your computer. Run `happy daemon start` on your computer, then try again."
            case .machineOffline: "Machine is offline"
            case .happyCLIOffline: "Happy CLI is offline on your computer. Run `happy daemon start` on your computer, then try again."
            case .cannotStartHappyAgent: "This machine cannot start Happy agent sessions"
            case .cannotCreateBots: "Happy Agent on this computer cannot create bots yet. Update it and try again."
            case .configurationUnavailable: "The selected agent configuration is unavailable"
            case .projectNeedsHappyAgent: "Only Happy Agent knows where this project is, so no other harness can open it. Switch the harness back to Happy Agent, or pick the project’s folder."
            case .workspace(let message): message
            }
        }
    }

    /// useStartSessionFromDraft.ts up to `beginRun`: the draft resolved
    /// again at the moment Start is pressed, so a stale choice can't spawn
    /// a harness the computer no longer has.
    ///
    /// `pickedAgent` is the harness the person picked for this start, else
    /// the composer's last pick. `target` overrides the catalog destination
    /// for a caller that already knows it (`.some(nil)` forces a directory).
    public static func resolve(
        draft: NewSessionDraft,
        pickedAgent: NewSessionDraft.Agent?,
        bot: (name: String, faceSeed: String)? = nil,
        machines: [MachineRecord],
        sessions: [SessionRecord],
        agentDefaultOverrides: [String: JSONValue],
        prompt: String,
        attachments: [OutgoingAttachment],
        target targetOverride: HappyAgentSpawnTarget?? = nil
    ) -> Result<NewSessionLaunch, Refusal> {
        let choices = MachineChoice.collect(machines.sorted { $0.createdAt > $1.createdAt })
        guard let choice = MachineChoice.find(in: choices, machineId: draft.selectedMachineId) else {
            return .failure(draft.selectedMachineId == nil ? .selectMachine : .machineNotRegistered)
        }
        let botName = bot?.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let botName, let problem = BotName.problem(botName) {
            return .failure(.botName(problem))
        }
        let agent: NewSessionDraft.Agent = bot != nil
            ? .rig
            : NewSessionDraft.Agent(rawValue: choice.resolveNewSessionAgent(stored: draft.agentType.rawValue, picked: pickedAgent?.rawValue)) ?? draft.agentType
        let agentChanged = agent != draft.agentType
        guard let machine = choice.machine(forAgent: agent.rawValue) else {
            return .failure(agent == .rig ? .happyAgentNotRunning : .happyCLIUnavailable)
        }
        guard machine.active else {
            return .failure(agent == .rig ? .machineOffline : .happyCLIOffline)
        }
        let rig = agent == .rig ? RigSessionCreation(metadata: machine.metadata) : nil
        if agent == .rig && rig == nil { return .failure(.cannotStartHappyAgent) }
        if bot != nil && rig?.supportsBots != true { return .failure(.cannotCreateBots) }

        let cliVersion = machine.metadata?["happyCliVersion"]?.stringValue
        // A harness the computer switched to starts on its own defaults.
        let picks = agentChanged
            ? ComposerPicks()
            : ComposerPicks(permissionMode: draft.permissionMode, modelMode: draft.modelMode, effortLevel: draft.effortLevel)
        let modes = NewSessionChoices.modes(agent: agent, rig: rig, picks: picks, overrides: agentDefaultOverrides, cliVersion: cliVersion)
        let permission = modes.permission
        let model = modes.model
        let effort = modes.effort
        guard let permission, let model else { return .failure(.configurationUnavailable) }

        let projectId = draft.selectedProjectId?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        if projectId != nil && rig == nil { return .failure(.projectNeedsHappyAgent) }
        let selectedPath = draft.selectedPath?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "~"
        let absolutePath = NewSessionChoices.absolutePath(selectedPath, homeDir: machine.metadata?["homeDir"]?.stringValue)
        let places = SessionPlaces.collect(machineIds: choice.machineIds, sessions: sessions, selectedPath: selectedPath)
        let selectedProjectId = projectId ?? places.first { $0.path == selectedPath }?.projectId
        let workspaces = SessionPlaces.workspaces(machineIds: choice.machineIds, projectId: selectedProjectId, sessions: sessions)
        let requested = draft.worktreeSelection

        let target: HappyAgentSpawnTarget?
        if let botName {
            target = .bot(name: botName)
        } else if rig != nil {
            if let targetOverride {
                target = targetOverride
            } else {
                do {
                    target = try HappyAgentSpawnTarget.resolve(
                        projectId: selectedProjectId,
                        workspaceSelection: requested,
                        workspaces: workspaces.map { (id: $0.id, path: $0.path) }
                    )
                } catch {
                    return .failure(.workspace((error as? LocalizedError)?.errorDescription ?? "The selected workspace is unavailable"))
                }
            }
        } else {
            target = nil
        }
        let creator = target == nil
            ? choice.worktreeCreationMachine(
                agent: agent.rawValue,
                agentSupportsWorktrees: rig?.supportsWorktrees ?? (agent == .rig ? false : NewSessionChoices.supportsWorktree(agent))
            )
            : nil
        // Without either route a stale "Create New" falls back to the main
        // tree.
        let worktree = target == nil && creator == nil && requested == NewSessionDraft.newWorktreeKey
            ? NewSessionDraft.noWorktreeKey
            : requested

        return .success(NewSessionLaunch(
            machineId: machine.id,
            agent: agent,
            rigMetadata: rig != nil ? machine.metadata : nil,
            absolutePath: absolutePath,
            worktreeSelection: worktree,
            worktreeCreationMachineId: creator?.id,
            target: target,
            permissionMode: permission.key,
            modelMode: model.key,
            effortLevel: effort?.key,
            prompt: bot != nil ? "" : prompt.trimmingCharacters(in: .whitespacesAndNewlines),
            attachments: bot != nil ? [] : attachments,
            signature: SpawnRequests.Signature(
                machineId: machine.id,
                agent: agent.rawValue,
                // Two catalog projects share an empty path; the project tells them apart.
                place: projectId.map(SessionPlaces.projectKey) ?? selectedPath,
                worktree: worktree,
                modelKey: model.key,
                permissionMode: permission.key,
                effort: effort?.key,
                bot: botName.map { (name: $0, faceSeed: bot?.faceSeed ?? "") }
            ),
            bot: botName.map { Bot(name: $0, faceSeed: bot?.faceSeed ?? "") }
        ))
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
