import Foundation
import HappyWire

/// A session's own picks: `ComposerStateRecord.values`, the local mirror of
/// happy-app's `session.permissionMode`, `modelMode` and `effortLevel`.
/// Nil is no pick (absent, null or not a string).
public struct ComposerPicks: Equatable, Sendable {
    public var permissionMode: String?
    public var modelMode: String?
    public var effortLevel: String?

    public init(permissionMode: String? = nil, modelMode: String? = nil, effortLevel: String? = nil) {
        self.permissionMode = permissionMode
        self.modelMode = modelMode
        self.effortLevel = effortLevel
    }

    /// From `ComposerStateRecord.values`.
    public init(values: JSONValue?) {
        self.init(
            permissionMode: values?["permissionMode"]?.stringValue,
            modelMode: values?["modelMode"]?.stringValue,
            effortLevel: values?["effortLevel"]?.stringValue
        )
    }
}

/// What the composer's permission, model and effort chips offer and show
/// (hooks/useComposerModes.ts).
///
/// A pick can live on the session, in the agent's own metadata, or nowhere,
/// leaving the account default to stand for it; the order they are read in
/// is the difference between showing what the agent will do and a guess.
public struct ComposerModes: Equatable, Sendable {
    public var availableModes: [ModeOption]
    public var permissionMode: ModeOption?
    public var availableModels: [ModeOption]
    public var modelMode: ModeOption?
    public var availableEffortLevels: [ModeOption]
    public var effortLevel: ModeOption?

    public init(
        availableModes: [ModeOption],
        permissionMode: ModeOption?,
        availableModels: [ModeOption],
        modelMode: ModeOption?,
        availableEffortLevels: [ModeOption],
        effortLevel: ModeOption?
    ) {
        self.availableModes = availableModes
        self.permissionMode = permissionMode
        self.availableModels = availableModels
        self.modelMode = modelMode
        self.availableEffortLevels = availableEffortLevels
        self.effortLevel = effortLevel
    }

    /// `useComposerModes` for a session: its picks, then the agent defaults
    /// (`agentDefaultOverrides` over the code defaults for the session's CLI,
    /// `metadata.version`), then what the metadata says. Happy Agent sessions
    /// fall back to their own published selection instead of the defaults.
    /// Nil metadata is a session that doesn't exist yet: every row falls
    /// back to the defaults.
    public init(metadata: JSONValue?, picks: ComposerPicks, agentDefaultOverrides: [String: JSONValue]) {
        typealias Options = ModelModeOptions
        let flavor = metadata?["flavor"]?.stringValue
        let cliVersion = metadata?["version"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        let isRig = RigCatalog.isRig(metadata)
        let defaults = AgentDefaults.resolve(agentDefaultOverrides, AgentDefaults.Agent(flavor: flavor), cliVersion: cliVersion)

        // A pick on a since-retired row shows the row that runs the same
        // model; the key itself is left alone.
        let sessionModelMode = isRig ? picks.modelMode : AgentDefaults.retireModelMode(picks.modelMode, flavor: flavor)
        let availableModels = Options.availableModels(
            flavor: flavor,
            metadata: metadata,
            selectedKey: sessionModelMode ?? (isRig ? nil : defaults.modelMode)
        )
        let availableModes = Options.availablePermissionModes(flavor: flavor, metadata: metadata, selectedKey: picks.permissionMode)

        let permissionMode = Options.resolveCurrentOption(
            availableModes,
            preferredKeys: [picks.permissionMode] + (isRig
                ? [
                    metadata?["currentOperatingModeCode"]?.stringValue,
                    metadata?["permissionMode"]?.stringValue,
                    metadata?["session"]?["permissionMode"]?.stringValue,
                ]
                : [defaults.permissionMode, metadata?["currentOperatingModeCode"]?.stringValue])
        )
        let modelMode = Options.resolveCurrentOption(availableModels, preferredKeys: [
            sessionModelMode,
            isRig ? Options.rigCurrentModelOptionKey(metadata: metadata) : defaults.modelMode,
            isRig ? nil : metadata?["currentModelCode"]?.stringValue,
        ])

        let modelKey = modelMode?.key ?? "default"
        let availableEffortLevels = Options.effortLevelsForModel(flavor: flavor, modelKey: modelKey, metadata: metadata)
        let effortLevel = Options.resolveCurrentOption(availableEffortLevels, preferredKeys: [
            picks.effortLevel,
            isRig ? RigCatalog.reasoningSelection(metadata, modelKey: modelKey) : defaults.effortLevel,
        ])

        self.init(
            availableModes: availableModes,
            permissionMode: permissionMode,
            availableModels: availableModels,
            modelMode: modelMode,
            availableEffortLevels: availableEffortLevels,
            effortLevel: effortLevel
        )
    }

    /// HomeDock.tsx's pickers for a session not started yet, on a flavor
    /// agent (`agentType`): the hardcoded catalogs gated on the picked
    /// machine's happy-cli (`cliVersion`), the dock's picks, then the
    /// defaults. Permission falls back to the code default last, so a
    /// saved `auto` filtered out for an old CLI lands there rather than on
    /// the head of the list. Happy Agent creation (`rigCreation`) is not
    /// covered.
    public static func newSession(
        agentType: String,
        picks: ComposerPicks,
        agentDefaultOverrides: [String: JSONValue],
        cliVersion: String?
    ) -> ComposerModes {
        typealias Options = ModelModeOptions
        let agent = AgentDefaults.Agent(flavor: agentType)
        let cliVersion = cliVersion.flatMap { $0.isEmpty ? nil : $0 }
        let defaults = AgentDefaults.resolve(agentDefaultOverrides, agent, cliVersion: cliVersion)
        let permissionOptions = Options.filterPermissionModesForCli(
            Options.hardcodedPermissionModes(flavor: agentType),
            cliVersion: cliVersion
        )
        let modelOptions = Options.includeConfiguredModel(
            flavor: agentType,
            models: Options.hardcodedModelModes(flavor: agentType),
            configured: defaults.modelMode
        )
        let permission = Options.resolveCurrentOption(permissionOptions, preferredKeys: [
            picks.permissionMode,
            defaults.permissionMode,
            AgentDefaults.codeDefaults(agent, cliVersion: cliVersion).permissionMode,
        ])
        let model = Options.resolveCurrentOption(modelOptions, preferredKeys: [
            AgentDefaults.retireModelMode(picks.modelMode, flavor: agentType),
            defaults.modelMode,
        ])
        let effortOptions = Options.effortLevelsForModel(flavor: agentType, modelKey: model?.key ?? "default")
        let effort = Options.resolveCurrentOption(effortOptions, preferredKeys: [picks.effortLevel, defaults.effortLevel])
        return ComposerModes(
            availableModes: permissionOptions,
            permissionMode: permission,
            availableModels: modelOptions,
            modelMode: model,
            availableEffortLevels: effortOptions,
            effortLevel: effort
        )
    }

    // MARK: Picks

    /// SessionView.tsx `updatePermissionMode`.
    public static func patch(selectingPermission mode: ModeOption) -> SessionAgentModesPatch {
        SessionAgentModesPatch(permissionMode: .string(mode.key))
    }

    /// SessionView.tsx `updateModelMode`: a model that doesn't offer the
    /// session's effort clears it, to the model's own default or none.
    public static func patch(
        selectingModel model: ModeOption,
        flavor: String?,
        metadata: JSONValue?,
        sessionEffortLevel: String?
    ) -> SessionAgentModesPatch {
        var patch = SessionAgentModesPatch(modelMode: .string(model.key))
        if let effort = sessionEffortLevel, !effort.isEmpty {
            let levels = ModelModeOptions.effortLevelsForModel(flavor: flavor, modelKey: model.key, metadata: metadata)
            if !levels.contains(where: { $0.key == effort }) {
                patch.effortLevel = model.defaultThinkingLevel.map(JSONValue.string) ?? .null
            }
        }
        return patch
    }

    /// SessionView.tsx `updateEffortLevel`.
    public static func patch(selectingEffort level: ModeOption) -> SessionAgentModesPatch {
        SessionAgentModesPatch(effortLevel: .string(level.key))
    }
}
