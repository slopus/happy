import Foundation
import HappyWire

/// What new sessions start on, kept with the person's own settings on the
/// computer (`/v0/user-settings`) under desktop's keys and values
/// (happy-desktop's `happyAgentModelPreferences`), so a session started on
/// any device is what the next one starts on, on every device. Each key is
/// its own last-write-wins value; one absent or null is its default.
public struct ModelPreferences: Equatable, Sendable {
    public enum Key {
        /// `{ modelId }`: the default model. An older desktop wrote a
        /// provider beside it, which is not read.
        public static let defaultModel = "happy-desktop.model.default"
        /// The default effort; "medium" is written as null.
        public static let effort = "happy-desktop.model.effort"
        /// The default permission mode; "auto" is written as null.
        public static let access = "happy-desktop.model.access"
        /// The account picked or started on last.
        public static let provider = "happy-desktop.model.provider"
        /// Each model's effort and speed as last used on an account.
        public static let memory = "happy-desktop.model.memory"
        /// "default", or null to follow the last session.
        public static let start = "happy-desktop.model.start"

        /// In the order desktop writes them.
        static let all = [defaultModel, effort, access, provider, memory, start]
    }

    /// What a new session starts on.
    public enum Start: Equatable, Sendable {
        /// The model and effort of the last session the person started.
        case lastSession
        /// The default model and effort, which starting a session leaves be.
        case defaultModel
    }

    /// A model's effort and speed, as last used with it on an account.
    public struct Memory: Equatable, Sendable {
        public var providerId: String
        public var modelId: String
        public var effort: String?
        public var serviceTier: String?

        public init(providerId: String, modelId: String, effort: String?, serviceTier: String?) {
            self.providerId = providerId
            self.modelId = modelId
            self.effort = effort
            self.serviceTier = serviceTier
        }
    }

    public static let defaultEffort = "medium"
    static let efforts: Set<String> = ["off", "on", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
    static let permissionModes: Set<String> = ["auto", "workspace_write", "read_only", "full_access"]
    /// Under the daemon's 64 KiB value limit, as desktop caps it.
    static let memoryLimit = (entries: 256, bytes: 48 * 1024)

    /// Nil until there is one: the catalog's default then.
    public var modelId: String?
    public var effort: String
    /// Nil for the catalog's own.
    public var permissionMode: String?
    public var providerId: String?
    /// Oldest first.
    public var memory: [Memory]
    public var start: Start

    public init(modelId: String? = nil, effort: String = defaultEffort, permissionMode: String? = nil, providerId: String? = nil, memory: [Memory] = [], start: Start = .lastSession) {
        self.modelId = modelId
        self.effort = effort
        self.permissionMode = permissionMode
        self.providerId = providerId
        self.memory = memory
        self.start = start
    }

    /// Read from the person's settings; what can't be read is its default.
    public init(_ settings: [String: JSONValue]) {
        func id(_ value: JSONValue?) -> String? { value?.stringValue.flatMap { $0.isEmpty ? nil : $0 } }
        var memory: [Memory] = []
        for entry in settings[Key.memory]?.arrayValue ?? [] {
            guard let providerId = id(entry["providerId"]), let modelId = id(entry["modelId"]) else { continue }
            memory.removeAll { $0.providerId == providerId && $0.modelId == modelId }
            memory.append(Memory(
                providerId: providerId,
                modelId: modelId,
                effort: entry["effort"]?.stringValue.flatMap { Self.efforts.contains($0) ? $0 : nil },
                serviceTier: entry["serviceTier"]?.stringValue
            ))
        }
        self.init(
            modelId: id(settings[Key.defaultModel]?["modelId"]),
            effort: settings[Key.effort]?.stringValue.flatMap { Self.efforts.contains($0) ? $0 : nil } ?? Self.defaultEffort,
            permissionMode: settings[Key.access]?.stringValue.flatMap { Self.permissionModes.contains($0) ? $0 : nil },
            providerId: id(settings[Key.provider]),
            memory: memory,
            start: settings[Key.start] == .string("default") ? .defaultModel : .lastSession
        )
    }

    /// The person started a session on `mode` (desktop's `selectionStarted`):
    /// its account is the one picked last and its effort and speed are
    /// remembered for its model; while new sessions follow the last one,
    /// its model and effort are the default too.
    public func started(_ mode: AgentWire.Mode) -> ModelPreferences {
        var next = self
        if start == .lastSession {
            next.modelId = mode.modelId
            if !mode.effort.isEmpty { next.effort = mode.effort }
        }
        next.providerId = mode.providerId
        next.remember(mode)
        return next
    }

    /// The model's entry moved to the end, the most recent.
    mutating func remember(_ mode: AgentWire.Mode) {
        memory.removeAll { $0.providerId == mode.providerId && $0.modelId == mode.modelId }
        memory.append(Memory(providerId: mode.providerId, modelId: mode.modelId, effort: mode.effort.isEmpty ? nil : mode.effort, serviceTier: mode.serviceTier))
    }

    /// The settings as written, each key's value or null for its default.
    public var values: [String: JSONValue] {
        [
            Key.defaultModel: modelId.map { .object(["modelId": .string($0)]) } ?? .null,
            Key.effort: effort == Self.defaultEffort ? .null : .string(effort),
            Key.access: permissionMode.flatMap { $0 == "auto" ? nil : .string($0) } ?? .null,
            Key.provider: providerId.map(JSONValue.string) ?? .null,
            Key.memory: memoryValue,
            Key.start: start == .defaultModel ? .string("default") : .null,
        ]
    }

    /// The writes that make `settings` say this: only the keys whose value
    /// changed, in desktop's order.
    public func writes(over settings: [String: JSONValue]) -> [(key: String, value: JSONValue)] {
        let values = values
        return Key.all.compactMap { key in
            let value = values[key] ?? .null
            return value == (settings[key] ?? .null) ? nil : (key, value)
        }
    }

    /// The most recent entries that fit the limits, oldest first; none is null.
    private var memoryValue: JSONValue {
        var kept: [JSONValue] = []
        var bytes = 2
        for entry in memory.reversed() {
            let value = JSONValue.object([
                "providerId": .string(entry.providerId),
                "modelId": .string(entry.modelId),
                "effort": entry.effort.map(JSONValue.string) ?? .null,
                "serviceTier": entry.serviceTier.map(JSONValue.string) ?? .null,
            ])
            let size = ((try? JSONEncoder().encode(value))?.count ?? 0) + 1
            if kept.count >= Self.memoryLimit.entries || bytes + size > Self.memoryLimit.bytes { continue }
            kept.append(value)
            bytes += size
        }
        return kept.isEmpty ? .null : .array(kept.reversed())
    }
}

extension ModelCatalog {
    /// What a new session starts on (desktop's `defaultSelectionResolve`):
    /// the default model, else the catalog's, on the account picked last
    /// when it serves it, else the default account, else the first that
    /// does. The effort is the default one when the model has it, else the
    /// model's own; the speed is the one last used with it there, when it
    /// still has it. Each falls back on its own.
    public func startMode(_ preferences: ModelPreferences) -> AgentWire.Mode {
        let permissionMode = preferences.permissionMode ?? defaultPermissionMode
        let fallback = defaultMode()
        for modelId in [preferences.modelId, fallback.modelId].compactMap({ $0 }) {
            let serving = providers.filter { !$0.isDisabled && !$0.hidden && $0.models.contains { $0.id == modelId } }
            guard let provider = serving.first(where: { $0.id == preferences.providerId })
                    ?? serving.first(where: { $0.id == defaultProviderId }) ?? serving.first,
                  let model = provider.models.first(where: { $0.id == modelId }) else { continue }
            let remembered = preferences.memory.last { $0.providerId == provider.id && $0.modelId == model.id }
            return AgentWire.Mode(
                providerId: provider.id,
                modelId: model.id,
                effort: model.efforts.contains(preferences.effort) ? preferences.effort : model.defaultEffort,
                serviceTier: remembered?.serviceTier.flatMap { model.serviceTiers.contains($0) ? $0 : nil },
                permissionMode: permissionMode
            )
        }
        var mode = fallback
        if self.provider(mode.providerId)?.models.first(where: { $0.id == mode.modelId })?.efforts.contains(preferences.effort) == true {
            mode.effort = preferences.effort
        }
        mode.permissionMode = permissionMode
        return mode
    }
}
