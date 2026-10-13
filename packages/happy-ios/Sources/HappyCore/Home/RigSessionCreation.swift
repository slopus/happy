import Foundation
import HappyWire

/// What a Happy Agent machine publishes about starting sessions on it
/// (sync/rigSessionCreation.ts): its models, its permission modes, the
/// defaults, and what it can make. Nil for a Happy CLI machine, or a Happy
/// Agent machine that cannot start sessions.
public struct RigSessionCreation: Equatable, Sendable {
    /// A model as the machine publishes it, keyed `providerId:id`.
    public struct Model: Equatable, Sendable {
        public var key: String
        public var id: String
        public var providerId: String
        public var name: String
        public var providerName: String
        public var description: String?
        public var thinkingLevels: [String]
        public var defaultThinkingLevel: String?
    }

    public struct Mode: Equatable, Sendable {
        public var key: String
        public var name: String
        public var description: String?
        public var semanticKind: String?
    }

    /// Bounds on any retry delay before it is slept.
    static let pendingRetryMinMs = 250
    static let pendingRetryMaxMs = 10_000
    /// When neither the result nor the machine names a delay.
    static let pendingRetryDefaultMs = 1_000

    public var models: [Model]
    public var permissionModes: [Mode]
    public var defaultModelKey: String?
    public var defaultPermissionMode: String?
    public var supportsWorktrees: Bool
    /// The machine can make a new bot from a `bot` spawn target.
    public var supportsBots: Bool
    /// The backoff the machine publishes for polling a `pending` result.
    public var pendingRetryAfterMs: Int?

    public init?(metadata: JSONValue?) {
        guard let metadata, MachineChoice.isRigMachine(metadata),
              metadata["capabilities"]?["newSession"]?.boolValue == true else { return nil }

        let models: [Model] = (metadata["models"]?.arrayValue ?? []).compactMap { model in
            guard model.objectValue != nil else { return nil }
            let provider = model["provider"]
            guard let providerId = Self.nonEmpty(model["providerId"]) ?? Self.nonEmpty(provider?["id"]),
                  let id = Self.nonEmpty(model["id"]) ?? Self.nonEmpty(model["code"]) else { return nil }
            let name = Self.nonEmpty(model["name"]) ?? Self.nonEmpty(model["value"]) ?? id
            let providerName = Self.nonEmpty(model["providerName"]) ?? Self.nonEmpty(provider?["name"]) ?? providerId
            let levels = (model["thinkingLevels"]?.arrayValue ?? []).compactMap { level -> String? in
                guard let value = level.stringValue, !value.isEmpty else { return nil }
                return value
            }
            let declared = Self.nonEmpty(model["defaultThinkingLevel"])
            return Model(
                key: Self.modelKey(providerId: providerId, modelId: id),
                id: id,
                providerId: providerId,
                name: name,
                providerName: providerName,
                description: providerName,
                thinkingLevels: levels,
                defaultThinkingLevel: declared.flatMap { levels.contains($0) ? $0 : nil } ?? levels.first
            )
        }

        let published: [Mode] = (metadata["operatingModes"]?.arrayValue ?? []).compactMap { mode in
            guard mode.objectValue != nil, let key = Self.nonEmpty(mode["code"]) else { return nil }
            return Mode(
                key: key,
                name: Self.nonEmpty(mode["value"]) ?? key,
                description: Self.nonEmpty(mode["description"]),
                semanticKind: Self.nonEmpty(mode["kind"])
            )
        }
        // Shown in the vocabulary's rank order, as every permission menu is.
        let ranked = PermissionModeLabels.sorted(published.map { ModeOption(key: $0.key, name: $0.name) })
        let modes = ranked.compactMap { option in published.first { $0.key == option.key } }

        let defaults = metadata["defaults"]
        var defaultModelKey = models.first?.key
        if let providerId = Self.nonEmpty(defaults?["providerId"]), let modelId = Self.nonEmpty(defaults?["modelId"]) {
            let key = Self.modelKey(providerId: providerId, modelId: modelId)
            if models.contains(where: { $0.key == key }) { defaultModelKey = key }
        }
        // The harness's own first mode, not the display-sorted one: a sort
        // that ranks Full access above Default must not decide the fallback.
        let publishedPermission = Self.nonEmpty(defaults?["permissionMode"])
        let defaultPermissionMode = publishedPermission.flatMap { key in modes.contains { $0.key == key } ? key : nil }
            ?? published.first?.key

        self.models = Self.pickerOrder(models)
        self.permissionModes = modes
        self.defaultModelKey = defaultModelKey
        self.defaultPermissionMode = defaultPermissionMode
        let capabilities = metadata["capabilities"]
        supportsWorktrees = capabilities?["worktrees"]?.boolValue == true
        supportsBots = capabilities?["bots"]?.boolValue == true
        pendingRetryAfterMs = metadata["sessionCreation"]?["pendingRetryAfterMs"]?.numberValue.flatMap(Self.finite)
    }

    /// The thinking levels of a model, or of the default model.
    public func efforts(forModel key: String?) -> [String] {
        model(key)?.thinkingLevels ?? []
    }

    public func defaultEffort(forModel key: String?) -> String? {
        model(key)?.defaultThinkingLevel
    }

    private func model(_ key: String?) -> Model? {
        models.first { $0.key == key } ?? models.first { $0.key == defaultModelKey }
    }

    /// `qualifyRigModelKey`.
    public static func modelKey(providerId: String, modelId: String) -> String {
        "\(providerId):\(modelId)"
    }

    /// `resolveRigPendingRetryDelayMs`: the result's delay, else the
    /// machine's, else 1s, held between 250ms and 10s.
    public static func pendingRetryDelayMs(_ retryAfterMs: Int?, published: Int?) -> Int {
        let requested = retryAfterMs ?? published ?? pendingRetryDefaultMs
        return min(pendingRetryMaxMs, max(pendingRetryMinMs, requested))
    }

    /// utils/rigModelPickerOrder.ts: Astra leads its provider's models,
    /// which otherwise keep their order, as do the providers.
    static func pickerOrder(_ models: [Model]) -> [Model] {
        var providers: [String] = []
        var groups: [String: [Model]] = [:]
        for model in models {
            if groups[model.providerId] == nil { providers.append(model.providerId) }
            groups[model.providerId, default: []].append(model)
        }
        func isAstra(_ model: Model) -> Bool {
            model.id == "openai/gpt-6-astra" || model.id == "gpt-6-astra"
        }
        return providers.flatMap { provider -> [Model] in
            let group = groups[provider] ?? []
            return group.filter(isAstra) + group.filter { !isAstra($0) }
        }
    }

    private static func nonEmpty(_ value: JSONValue?) -> String? {
        guard let string = value?.stringValue, !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return string
    }

    private static func finite(_ value: Double) -> Int? {
        value.isFinite ? Int(value) : nil
    }
}

/// `buildRigSpawnConfiguration`: the exact `spawn-happy-session` request a
/// Happy Agent machine accepts, checked against what it published.
public struct RigSpawnConfiguration: Equatable, Sendable {
    public var directory: String
    public var clientRequestId: String
    public var approvedNewDirectoryCreation: Bool
    public var providerId: String
    public var modelId: String
    public var permissionMode: String
    public var effort: String

    public enum Failure: Error, Equatable, LocalizedError {
        case notAvailable
        case missingDirectory
        case missingRequestId
        case modelUnavailable
        case permissionUnavailable
        case effortUnavailable

        public var errorDescription: String? {
            switch self {
            case .notAvailable: "This machine is not available for Rig session creation."
            case .missingDirectory: "A Rig session directory is required."
            case .missingRequestId: "A Rig client request ID is required."
            case .modelUnavailable: "The selected Rig model is unavailable."
            case .permissionUnavailable: "The selected Rig permission mode is unavailable."
            case .effortUnavailable: "The selected Rig reasoning level is unavailable for this model."
            }
        }
    }

    public init(
        metadata: JSONValue?,
        directory: String,
        clientRequestId: String,
        approvedNewDirectoryCreation: Bool = false,
        modelKey: String?,
        permissionMode: String?,
        effort: String?
    ) throws {
        guard let creation = RigSessionCreation(metadata: metadata) else { throw Failure.notAvailable }
        guard !directory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw Failure.missingDirectory }
        guard !clientRequestId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw Failure.missingRequestId }
        let key = modelKey ?? creation.defaultModelKey
        guard let model = creation.models.first(where: { $0.key == key }) else { throw Failure.modelUnavailable }
        guard let permission = permissionMode ?? creation.defaultPermissionMode,
              creation.permissionModes.contains(where: { $0.key == permission }) else { throw Failure.permissionUnavailable }
        guard let effort = effort ?? creation.defaultEffort(forModel: model.key),
              model.thinkingLevels.contains(effort) else { throw Failure.effortUnavailable }
        self.directory = directory
        self.clientRequestId = clientRequestId
        self.approvedNewDirectoryCreation = approvedNewDirectoryCreation
        self.providerId = model.providerId
        self.modelId = model.id
        self.permissionMode = permission
        self.effort = effort
    }

    /// The machine RPC's options: agent `rig`, no Happy CLI-only fields.
    public func options(machineId: String, target: HappyAgentSpawnTarget?) -> SpawnSessionOptions {
        var options = SpawnSessionOptions(machineId: machineId, directory: directory)
        options.approvedNewDirectoryCreation = approvedNewDirectoryCreation
        options.agent = "rig"
        options.clientRequestId = clientRequestId
        options.providerId = providerId
        options.modelId = modelId
        options.permissionMode = permissionMode
        options.effort = effort
        options.happyAgentTarget = target?.json
        return options
    }
}

/// sync/happyAgentSpawn.ts: where in Happy Agent's catalog a session
/// starts, by identity rather than by path.
public enum HappyAgentSpawnTarget: Equatable, Sendable {
    case project(id: String)
    case workspace(id: String)
    case newWorkspace(projectId: String)
    /// A new bot, always named here: the daemon never invents a name.
    case bot(name: String)

    public enum Failure: Error, Equatable, LocalizedError {
        case workspaceUnavailable
        public var errorDescription: String? { "The selected Happy Agent workspace is no longer available." }
    }

    /// `resolveHappyAgentSpawnTarget`: nil for a plain directory. Once a
    /// project is known an unknown workspace is an error, never a path to
    /// import as a second project.
    public static func resolve(
        projectId: String?,
        workspaceSelection: String,
        workspaces: [(id: String, path: String)]
    ) throws -> HappyAgentSpawnTarget? {
        guard let projectId = projectId?.trimmingCharacters(in: .whitespacesAndNewlines), !projectId.isEmpty else { return nil }
        switch workspaceSelection {
        case NewSessionDraft.newWorktreeKey: return .newWorkspace(projectId: projectId)
        case NewSessionDraft.noWorktreeKey: return .project(id: projectId)
        default:
            guard let workspace = workspaces.first(where: { $0.path == workspaceSelection }) else {
                throw Failure.workspaceUnavailable
            }
            return .workspace(id: workspace.id)
        }
    }

    public var json: JSONValue {
        switch self {
        case .project(let id): .object(["kind": .string("project"), "id": .string(id)])
        case .workspace(let id): .object(["kind": .string("workspace"), "id": .string(id)])
        case .newWorkspace(let projectId): .object(["kind": .string("newWorkspace"), "projectId": .string(projectId)])
        case .bot(let name): .object(["kind": .string("bot"), "name": .string(name)])
        }
    }
}
