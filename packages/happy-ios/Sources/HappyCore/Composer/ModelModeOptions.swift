import Foundation
import HappyWire

/// One row of the permission, model or effort picker (modelModeOptions.ts
/// `ModeOption` and `ModelMode`). The model fields are nil on the others.
public struct ModeOption: Equatable, Sendable {
    public var key: String
    public var name: String
    public var description: String?
    /// A published operating mode's `kind` (`safe-yolo`, `read-only`…).
    public var semanticKind: String?
    /// Listed but not pickable.
    public var isDisabled: Bool
    /// The happy-cli that first parses this mode; nil for every CLI.
    public var sinceCliVersion: String?

    public var modelId: String?
    public var providerId: String?
    public var providerName: String?
    public var providerKind: String?
    public var contextWindow: Double?
    public var serviceTiers: [String]?
    public var thinkingLevels: [String]?
    public var defaultThinkingLevel: String?
    /// The selected model left the catalog.
    public var isUnavailable: Bool

    public init(
        key: String,
        name: String,
        description: String? = nil,
        semanticKind: String? = nil,
        isDisabled: Bool = false,
        sinceCliVersion: String? = nil,
        modelId: String? = nil,
        providerId: String? = nil,
        providerName: String? = nil,
        providerKind: String? = nil,
        contextWindow: Double? = nil,
        serviceTiers: [String]? = nil,
        thinkingLevels: [String]? = nil,
        defaultThinkingLevel: String? = nil,
        isUnavailable: Bool = false
    ) {
        self.key = key
        self.name = name
        self.description = description
        self.semanticKind = semanticKind
        self.isDisabled = isDisabled
        self.sinceCliVersion = sinceCliVersion
        self.modelId = modelId
        self.providerId = providerId
        self.providerName = providerName
        self.providerKind = providerKind
        self.contextWindow = contextWindow
        self.serviceTiers = serviceTiers
        self.thinkingLevels = thinkingLevels
        self.defaultThinkingLevel = defaultThinkingLevel
        self.isUnavailable = isUnavailable
    }
}

/// `ModelModeProviderGroup`: one provider's section of the model menu.
public struct ModelModeProviderGroup: Equatable, Sendable {
    public var key: String
    /// Nil for models that name no provider.
    public var title: String?
    public var models: [ModeOption]
}

extension AgentDefaults.Agent {
    /// agentDefaults.ts `normalizeAgentKey`: anything unknown, or no flavor,
    /// is Claude.
    public init(flavor: String?) {
        self = flavor.flatMap(Self.init(rawValue:)) ?? .claude
    }
}

extension AgentDefaults {
    /// agentDefaults.ts `retireModelMode`: a saved Claude key that left the
    /// list (`claude-opus-5[1m]`) onto the row that runs the same model.
    /// Other harnesses, Happy Agent's included, own their keys.
    public static func retireModelMode(_ mode: String?, flavor: String?) -> String? {
        guard let mode, !mode.isEmpty, flavor != "rig", Agent(flavor: flavor) == .claude else {
            return mode
        }
        return retiredClaudeModelModes[mode] ?? mode
    }
}

/// modelModeOptions.ts: what the composer's permission, model and effort
/// pickers offer for a session. The catalogs are `AgentDefaults`'; this
/// adds the session's metadata, the CLI gate and Happy Agent's catalogs.
///
/// `flavor` is `metadata.flavor` as sent (nil when absent). Like happy-app,
/// most branches compare it exactly, so a session with no flavor is Claude
/// for its catalogs but offers no effort levels.
public enum ModelModeOptions {
    // MARK: Catalogs

    /// `groupModelModesByProvider`: providers in the order they first
    /// appear, rows in wire order.
    public static func groupByProvider(_ models: [ModeOption]) -> [ModelModeProviderGroup] {
        var groups: [ModelModeProviderGroup] = []
        var index: [String: Int] = [:]
        for model in models {
            let trimmedId = model.providerId?.trimmingCharacters(in: .whitespacesAndNewlines)
            let providerId = trimmedId?.isEmpty == false ? trimmedId : nil
            let key = providerId ?? "__models__"
            if let position = index[key] {
                groups[position].models.append(model)
            } else {
                let trimmedName = model.providerName?.trimmingCharacters(in: .whitespacesAndNewlines)
                index[key] = groups.count
                groups.append(ModelModeProviderGroup(
                    key: key,
                    title: trimmedName?.isEmpty == false ? trimmedName : providerId,
                    models: [model]
                ))
            }
        }
        return groups
    }

    /// `mapMetadataOptions`: `{ code, value, description }` rows.
    public static func mapMetadataOptions(_ options: JSONValue?) -> [ModeOption] {
        (options?.arrayValue ?? []).compactMap { option in
            guard let code = option["code"]?.stringValue else { return nil }
            return ModeOption(
                key: code,
                name: option["value"]?.stringValue ?? code,
                description: option["description"]?.stringValue
            )
        }
    }

    /// `getHardcodedPermissionModes`. `auto` is tagged with the CLI that
    /// first parses it.
    public static func hardcodedPermissionModes(flavor: String?) -> [ModeOption] {
        AgentDefaults.permissionModes(hardcodedAgent(flavor)).map { option in
            ModeOption(
                key: option.key,
                name: option.name,
                description: option.description,
                sinceCliVersion: permissionModeSinceCliVersion[option.key]
            )
        }
    }

    /// `getHardcodedModelModes`, with each row's provider.
    public static func hardcodedModelModes(flavor: String?) -> [ModeOption] {
        let agent = hardcodedAgent(flavor)
        return AgentDefaults.hardcodedModels(agent).map { option in
            let provider = provider(agent, model: option.key)
            return ModeOption(
                key: option.key,
                name: option.name,
                description: option.description,
                providerId: provider?.id,
                providerName: provider?.name
            )
        }
    }

    /// `includeConfiguredModel`: a saved model the list no longer offers
    /// stays as its own row, so the picker shows it rather than the head of
    /// the list. Claude, Codex and agy only.
    public static func includeConfiguredModel(flavor: String?, models: [ModeOption], configured: String?) -> [ModeOption] {
        let isClaude = flavor != "rig" && AgentDefaults.Agent(flavor: flavor) == .claude
        guard
            flavor == "codex" || flavor == "agy" || isClaude,
            let key = AgentDefaults.retireModelMode(configured, flavor: flavor),
            !key.isEmpty, key != "default",
            !models.contains(where: { $0.key == key })
        else { return models }
        return models + [ModeOption(
            key: key,
            name: (isClaude ? unlistedClaudeModelNames[key] : nil) ?? key,
            description: flavor == "codex" ? "custom model" : "saved model"
        )]
    }

    // MARK: CLI gate

    /// `modeSupportedByCli`: an untagged mode, or no CLI version (not
    /// happy-cli), is always supported; a mangled version is treated as old.
    public static func modeSupportedByCli(sinceCliVersion: String?, cliVersion: String?) -> Bool {
        guard let sinceCliVersion, !sinceCliVersion.isEmpty, let cliVersion, !cliVersion.isEmpty else {
            return true
        }
        guard SemanticVersion.isWellFormed(cliVersion) else { return false }
        return SemanticVersion.compare(cliVersion, sinceCliVersion) >= 0
    }

    /// `permissionModeSupportedByCli`, for a bare key.
    public static func permissionModeSupportedByCli(_ modeKey: String?, cliVersion: String?) -> Bool {
        guard let modeKey, !modeKey.isEmpty else { return true }
        return modeSupportedByCli(sinceCliVersion: permissionModeSinceCliVersion[modeKey], cliVersion: cliVersion)
    }

    /// `filterPermissionModesForCli`: drops modes the session's CLI can't
    /// parse (it would drop the whole prompt).
    public static func filterPermissionModesForCli(_ modes: [ModeOption], cliVersion: String?) -> [ModeOption] {
        modes.filter { modeSupportedByCli(sinceCliVersion: $0.sinceCliVersion, cliVersion: cliVersion) }
    }

    // MARK: A session's options

    /// `getAvailableModels`. Happy Agent sessions list their own catalog
    /// (keys `provider:model`), with the selected model kept, disabled, if
    /// it left. Others prefer metadata models, then the hardcoded list.
    public static func availableModels(flavor: String?, metadata: JSONValue?, selectedKey: String? = nil) -> [ModeOption] {
        if RigCatalog.isRigV1(metadata) {
            var models = RigCatalog.sortedForPicker(RigCatalog.models(metadata)).map { model in
                ModeOption(
                    key: model.key,
                    name: model.name,
                    description: model.providerName,
                    modelId: model.id,
                    providerId: model.providerId,
                    providerName: model.providerName,
                    providerKind: model.providerKind,
                    contextWindow: model.contextWindow,
                    serviceTiers: model.serviceTiers,
                    thinkingLevels: model.thinkingLevels,
                    defaultThinkingLevel: model.defaultThinkingLevel
                )
            }
            if let current = RigCatalog.currentModel(metadata), current.isUnavailable,
               !models.contains(where: { $0.key == current.key }) {
                models.append(ModeOption(
                    key: current.key,
                    name: current.name,
                    description: "\(current.providerName) · unavailable",
                    isDisabled: true,
                    modelId: current.id,
                    providerId: current.providerId,
                    providerName: current.providerName,
                    providerKind: current.providerKind,
                    serviceTiers: [],
                    thinkingLevels: [],
                    isUnavailable: true
                ))
            }
            let local = selectedKey ?? metadata?["modelMode"]?.stringValue
            if let local, let separator = local.firstIndex(of: ":"), !models.contains(where: { $0.key == local }) {
                let providerId = String(local[..<separator])
                let modelId = String(local[local.index(after: separator)...])
                models.append(ModeOption(
                    key: local,
                    name: modelId,
                    description: "\(providerId) · unavailable",
                    isDisabled: true,
                    modelId: modelId,
                    providerId: providerId,
                    providerName: providerId,
                    providerKind: "custom",
                    isUnavailable: true
                ))
            }
            return models
        }
        let metadataModels = mapMetadataOptions(metadata?["models"])
        if !metadataModels.isEmpty {
            if flavor == "codex", !metadataModels.contains(where: { $0.key == "default" }) {
                return [ModeOption(key: "default", name: "default model")] + metadataModels
            }
            return metadataModels
        }
        return includeConfiguredModel(flavor: flavor, models: hardcodedModelModes(flavor: flavor), configured: selectedKey)
    }

    /// `getAvailablePermissionModes`. Happy Agent sessions list their own
    /// catalog in rank order, with an unlisted current mode first and
    /// disabled. The shipped harnesses use their hardcoded list, gated on
    /// the session's CLI (`metadata.version`).
    public static func availablePermissionModes(flavor: String?, metadata: JSONValue?, selectedKey: String? = nil) -> [ModeOption] {
        if RigCatalog.isRigV1(metadata) {
            var modes = PermissionModeLabels.sorted((metadata?["operatingModes"]?.arrayValue ?? []).compactMap { mode in
                guard let code = mode["code"]?.stringValue else { return nil }
                return ModeOption(
                    key: code,
                    name: mode["value"]?.stringValue ?? code,
                    description: mode["description"]?.stringValue,
                    semanticKind: mode["kind"]?.stringValue
                )
            })
            let current = selectedKey
                ?? metadata?["currentOperatingModeCode"]?.stringValue
                ?? metadata?["permissionMode"]?.stringValue
                ?? metadata?["session"]?["permissionMode"]?.stringValue
            if let current, !current.isEmpty, !modes.contains(where: { $0.key == current }) {
                modes.insert(ModeOption(
                    key: current,
                    name: current,
                    description: "Unavailable in the current Happy mode catalog",
                    isDisabled: true
                ), at: 0)
            }
            return modes
        }
        if flavor == "claude" || flavor == "codex" || flavor == "openclaw" || flavor == "agy" {
            return ModeHacks.hack(filterPermissionModesForCli(
                hardcodedPermissionModes(flavor: flavor),
                cliVersion: metadata?["version"]?.stringValue
            ))
        }
        let metadataModes = mapMetadataOptions(metadata?["operatingModes"])
        if !metadataModes.isEmpty {
            return PermissionModeLabels.sorted(ModeHacks.hack(metadataModes))
        }
        return ModeHacks.hack(hardcodedPermissionModes(flavor: flavor))
    }

    /// `findOptionByKey`.
    public static func findOption(_ options: [ModeOption], key: String?) -> ModeOption? {
        guard let key, !key.isEmpty else { return nil }
        return options.first { $0.key == key }
    }

    /// `resolveCurrentOption`: the first preferred key that is listed.
    public static func resolveCurrentOption(_ options: [ModeOption], preferredKeys: [String?]) -> ModeOption? {
        for key in preferredKeys {
            if let option = findOption(options, key: key) {
                return option
            }
        }
        return nil
    }

    // MARK: Defaults

    /// `getDefaultModelKey`.
    public static func defaultModelKey(flavor: String?, cliVersion: String? = nil) -> String {
        AgentDefaults.codeDefaults(AgentDefaults.Agent(flavor: flavor), cliVersion: nonEmpty(cliVersion)).modelMode
    }

    /// `getDefaultPermissionModeKey`.
    public static func defaultPermissionModeKey(flavor: String?) -> String {
        AgentDefaults.codeDefaults(AgentDefaults.Agent(flavor: flavor), cliVersion: nil).permissionMode
    }

    /// `getDefaultEffortKey`.
    public static func defaultEffortKey(flavor: String?) -> String? {
        AgentDefaults.codeDefaults(AgentDefaults.Agent(flavor: flavor), cliVersion: nil).effortLevel
    }

    // MARK: Effort

    /// `effortDisplayName`: capitalised, `xhigh` as "xHigh".
    public static func effortDisplayName(_ key: String) -> String {
        key == "xhigh" ? "xHigh" : key.prefix(1).uppercased() + key.dropFirst()
    }

    /// `getClaudeEffortLevels`: the SDK's one scale for every model.
    public static func claudeEffortLevels() -> [ModeOption] {
        effort(AgentDefaults.effortLevels(.claude, model: ""))
    }

    /// `getCodexEffortLevels`: what the model publishes; an unknown model
    /// gets the range every gpt-5 accepts.
    public static func codexEffortLevels(model: String?) -> [ModeOption] {
        effort(AgentDefaults.effortLevels(.codex, model: model ?? ""))
    }

    /// `getAgyEffortLevels`.
    public static func agyEffortLevels(model: String?) -> [ModeOption] {
        effort(AgentDefaults.effortLevels(.agy, model: model ?? ""))
    }

    /// `getHardcodedEffortLevels`.
    public static func hardcodedEffortLevels(flavor: String?) -> [ModeOption] {
        switch flavor {
        case "claude": claudeEffortLevels()
        case "codex": codexEffortLevels(model: nil)
        case "agy": agyEffortLevels(model: defaultModelKey(flavor: "agy"))
        default: []
        }
    }

    /// `getEffortLevelsForModel`: Happy Agent's levels for the model, else
    /// the harness's; empty when the model has no effort.
    public static func effortLevelsForModel(flavor: String?, modelKey: String, metadata: JSONValue? = nil) -> [ModeOption] {
        if RigCatalog.isRigV1(metadata) {
            return RigCatalog.reasoningLevels(metadata, modelKey: modelKey).map {
                ModeOption(key: $0, name: effortDisplayName($0))
            }
        }
        switch flavor {
        case "claude": return claudeEffortLevels()
        case "codex": return codexEffortLevels(model: modelKey)
        case "agy": return agyEffortLevels(model: modelKey)
        default: return []
        }
    }

    /// `getDefaultEffortKeyForModel`: the agent's default, else the
    /// highest the model allows.
    public static func defaultEffortKeyForModel(flavor: String?, modelKey: String) -> String? {
        let levels = effortLevelsForModel(flavor: flavor, modelKey: modelKey)
        guard let last = levels.last else { return nil }
        return defaultEffortKey(flavor: flavor) ?? last.key
    }

    /// `getRigCurrentModelOptionKey`.
    public static func rigCurrentModelOptionKey(metadata: JSONValue?) -> String? {
        RigCatalog.selectedModelKey(metadata)
    }

    /// `getSupportsWorktree`.
    public static func supportsWorktree(flavor: String?) -> Bool {
        flavor != "openclaw"
    }

    // MARK: Chip labels

    /// `MODEL_CHIP_LABEL_MAX_LENGTH`.
    public static let modelChipLabelMaxLength = 16

    /// `truncateModelLabel`: the model name cut to fit the chip, on a word
    /// boundary when one is near the limit ("Claude Sonnet…").
    public static func truncateModelLabel(_ label: String, max: Int = modelChipLabelMaxLength) -> String {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > max else { return trimmed }
        let cut = String(trimmed.prefix(max))
        let head: String
        if let space = cut.lastIndex(of: " "), cut.distance(from: cut.startIndex, to: space) >= max - 8 {
            head = String(cut[..<space])
        } else {
            head = String(cut.reversed().drop(while: \.isWhitespace).reversed())
        }
        return "\(head)…"
    }

    /// AgentInput.tsx `isSandboxEnabled`: `metadata.sandbox` is set, and
    /// when it is an object with `enabled`, that is true.
    public static func isSandboxEnabled(metadata: JSONValue?) -> Bool {
        guard let sandbox = metadata?["sandbox"], isTruthy(sandbox) else { return false }
        if let object = sandbox.objectValue, let enabled = object["enabled"] {
            return isTruthy(enabled)
        }
        return true
    }

    /// AgentInput.tsx `withSandboxSuffix`: the yolo modes' menu rows say
    /// they are sandboxed when they are.
    public static func withSandboxSuffix(_ label: String, modeKey: String?, sandboxEnabled: Bool) -> String {
        guard sandboxEnabled, modeKey == "bypassPermissions" || modeKey == "yolo" else { return label }
        return "\(label) (sandboxed)"
    }

    // MARK: Internals

    /// The mode keys a CLI version gates (`PERMISSION_MODE_SINCE_CLI_VERSION`).
    static let permissionModeSinceCliVersion = ["auto": AgentDefaults.cliVersionWithAuto]

    /// Names for Claude models that left the list but can still be saved.
    static let unlistedClaudeModelNames = ["claude-sonnet-5": "Sonnet 5"]

    /// The hardcoded catalogs fall back to Claude's for any other flavor.
    static func hardcodedAgent(_ flavor: String?) -> AgentDefaults.Agent {
        switch flavor {
        case "codex": .codex
        case "gemini": .gemini
        case "openclaw": .openclaw
        case "agy": .agy
        default: .claude
        }
    }

    static func provider(_ agent: AgentDefaults.Agent, model: String) -> (id: String, name: String)? {
        switch agent {
        case .claude: ("anthropic", "Anthropic")
        case .codex: ("openai", "OpenAI")
        case .agy:
            if model.hasPrefix("Gemini") {
                ("google", "Google")
            } else if model.hasPrefix("Claude") {
                ("anthropic", "Anthropic")
            } else {
                ("openai", "OpenAI")
            }
        case .gemini, .openclaw: nil
        }
    }

    static func effort(_ options: [AgentDefaults.Option]) -> [ModeOption] {
        options.map { ModeOption(key: $0.key, name: $0.name) }
    }

    static func nonEmpty(_ value: String?) -> String? {
        value?.isEmpty == false ? value : nil
    }

    /// JavaScript truthiness for a JSON value.
    static func isTruthy(_ value: JSONValue) -> Bool {
        switch value {
        case .null: false
        case .bool(let bool): bool
        case .number(let number): number != 0 && !number.isNaN
        case .string(let string): !string.isEmpty
        case .array, .object: true
        }
    }
}
