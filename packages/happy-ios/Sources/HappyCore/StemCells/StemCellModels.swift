import Foundation
import HappyWire

/// The models a paired computer offers, read from `GET /v0/config` as
/// desktop's `happyAgentModelCatalogProject` reads it: every provider in the
/// order the daemon lists them, each with the models it has switched on.
public struct StemCellModelCatalog: Equatable, Sendable {
    public struct Model: Equatable, Sendable {
        public var id: String
        public var name: String
        /// Every effort the model supports, least to most.
        public var efforts: [String]
        public var defaultEffort: String
        public var serviceTiers: [String]

        public init(id: String, name: String, efforts: [String], defaultEffort: String, serviceTiers: [String] = []) {
            self.id = id
            self.name = name
            self.efforts = efforts
            self.defaultEffort = defaultEffort
            self.serviceTiers = serviceTiers
        }
    }

    public struct Provider: Equatable, Sendable {
        public var id: String
        /// The account's friendly name ("Current CLI"), when it has one.
        public var name: String?
        /// The service it is an account of ("claude", "codex").
        public var type: String
        public var enabled: Bool
        /// Kept out of the pickers; a selection on it still works.
        public var hidden: Bool
        public var models: [Model]

        public init(id: String, name: String?, type: String, enabled: Bool, hidden: Bool, models: [Model]) {
            self.id = id
            self.name = name
            self.type = type
            self.enabled = enabled
            self.hidden = hidden
            self.models = models
        }

        /// Switched off, or on with nothing to offer: its models can't be picked.
        public var isDisabled: Bool { !enabled || models.isEmpty }
    }

    public var defaultProviderId: String
    public var defaultModelId: String
    public var defaultPermissionMode: String
    /// Every model the daemon knows, whether or not an account offers it.
    public var models: [Model]
    public var providers: [Provider]

    public init(defaultProviderId: String, defaultModelId: String, defaultPermissionMode: String = "auto", models: [Model], providers: [Provider]) {
        self.defaultProviderId = defaultProviderId
        self.defaultModelId = defaultModelId
        self.defaultPermissionMode = defaultPermissionMode
        self.models = models
        self.providers = providers
    }

    /// The response's bytes, so the providers keep the order the daemon
    /// wrote them in; nil when it isn't a configuration.
    public init?(response data: Data) {
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              let config = value["config"], let defaults = config["defaults"],
              let providerId = defaults["providerId"]?.stringValue, let modelId = defaults["modelId"]?.stringValue
        else { return nil }
        let definitions = config["models"]?.objectValue ?? [:]
        func model(_ id: String, _ reference: JSONValue?) -> Model? {
            guard let definition = definitions[id] else { return nil }
            let efforts = (reference?["efforts"] ?? definition["efforts"])?.arrayValue?.compactMap(\.stringValue) ?? []
            return Model(
                id: id,
                name: reference?["name"]?.stringValue ?? definition["name"]?.stringValue ?? id,
                efforts: efforts,
                defaultEffort: (reference?["defaultEffort"] ?? definition["defaultEffort"])?.stringValue ?? efforts.first ?? "medium",
                serviceTiers: (reference?["serviceTiers"] ?? definition["serviceTiers"])?.arrayValue?.compactMap(\.stringValue) ?? []
            )
        }
        let modelOrder = JSONKeyOrder.keys(in: data, at: ["config", "models"])
        let providerOrder = JSONKeyOrder.keys(in: data, at: ["config", "providers"])
        let providers = config["providers"]?.objectValue ?? [:]
        self.init(
            defaultProviderId: providerId,
            defaultModelId: modelId,
            defaultPermissionMode: defaults["permissionMode"]?.stringValue ?? "auto",
            models: Self.ordered(definitions.keys, by: modelOrder).compactMap { model($0, nil) },
            providers: Self.ordered(providers.keys, by: providerOrder).compactMap { id in
                guard let provider = providers[id] else { return nil }
                let references = provider["models"]?.arrayValue ?? []
                return Provider(
                    id: id,
                    name: provider["name"]?.stringValue,
                    type: provider["type"]?.stringValue ?? id,
                    enabled: provider["enabled"]?.boolValue ?? false,
                    hidden: provider["hidden"]?.boolValue ?? false,
                    models: references.filter { $0["enabled"]?.boolValue == true }.compactMap { reference in
                        reference["id"]?.stringValue.flatMap { model($0, reference) }
                    }
                )
            }
        )
    }

    private static func ordered(_ keys: Dictionary<String, JSONValue>.Keys, by order: [String]) -> [String] {
        let known = Set(keys)
        let listed = order.filter { known.contains($0) }
        return listed + keys.filter { !listed.contains($0) }.sorted()
    }

    public func provider(_ id: String) -> Provider? { providers.first { $0.id == id } }

    /// `happyAgentSessionSelectionDefault`: the declared default when its
    /// account offers it, else the first usable account's first model; the
    /// effort is the model's own default.
    public func defaultMode() -> AgentWire.Mode {
        let declared = provider(defaultProviderId)
        let declaredModel = declared?.isDisabled == false ? declared?.models.first { $0.id == defaultModelId } : nil
        let provider = declaredModel != nil ? declared : providers.first { !$0.isDisabled && !$0.hidden }
        let model = declaredModel ?? provider?.models.first
        return AgentWire.Mode(
            providerId: provider?.id ?? defaultProviderId,
            modelId: model?.id ?? defaultModelId,
            effort: model?.defaultEffort ?? "medium",
            serviceTier: nil,
            permissionMode: defaultPermissionMode
        )
    }

    /// `happyAgentSelectionModelUpdate`: another model, on the account given
    /// or the first that offers it. Its effort is the one asked for, else the
    /// model's own default, never one carried over that it may not support; a
    /// speed it doesn't offer is dropped.
    public func select(providerId: String?, modelId: String, effort: String? = nil, from current: AgentWire.Mode) -> AgentWire.Mode {
        let providerId = providerId ?? providers.first { !$0.isDisabled && !$0.hidden && $0.models.contains { $0.id == modelId } }?.id ?? current.providerId
        let provider = provider(providerId)
        let model = provider?.models.first { $0.id == modelId }
        let effort = effort.flatMap { level in model?.efforts.contains(level) == false ? nil : level } ?? model?.defaultEffort ?? current.effort
        let tier = current.serviceTier.flatMap { tier in provider?.isDisabled == false && model?.serviceTiers.contains(tier) == true ? tier : nil }
        return AgentWire.Mode(providerId: providerId, modelId: modelId, effort: effort, serviceTier: tier, permissionMode: current.permissionMode)
    }

    /// The model's definition, from its account or the shared list.
    public func model(_ mode: AgentWire.Mode) -> Model? {
        provider(mode.providerId)?.models.first { $0.id == mode.modelId } ?? models.first { $0.id == mode.modelId }
    }
}

/// Desktop's `happyAgentComposerModelControlProps`, flattened for a phone:
/// the services (one per provider type) with their accounts in catalog
/// order, the models each lists, and what is selected. Desktop nests the
/// accounts in the model menu and the efforts as its second row; the phone
/// shows Model, Provider and Effort as three pickers of their own.
public struct StemCellModelMenus: Equatable, Sendable {
    public struct Choice: Equatable, Sendable {
        public var id: String
        public var label: String
        public var efforts: [String]
        public var defaultEffort: String
        public var disabled: Bool
    }

    public struct Account: Equatable, Sendable {
        public var id: String
        public var label: String
        public var models: [Choice]
    }

    public struct Service: Equatable, Sendable {
        public var id: String
        public var label: String
        public var accounts: [Account]
        /// The account whose models the service lists: the selected one when
        /// it is this service's, else the first that is switched on.
        public var account: String

        public var shown: Account? { accounts.first { $0.id == account } ?? accounts.first }
    }

    /// Why the selected account is named although it is not a choice.
    public enum Notice: Equatable, Sendable {
        /// It still works; it is only kept out of the lists.
        case hidden
        /// It is no longer configured on the computer; its name.
        case removed(String)
        /// It is switched off, so nothing is sent to it; its name.
        case off(String)
    }

    public var services: [Service]
    public var selection: AgentWire.Mode
    /// The selected model, listed or not.
    public var current: Choice?
    public var notice: Notice?

    public init(catalog: StemCellModelCatalog, selection: AgentWire.Mode) {
        self.selection = selection
        var services: [Service] = []
        var current: Choice?
        for provider in catalog.providers {
            let choices = provider.models.map { Self.choice($0, disabled: provider.isDisabled) }
            if provider.id == selection.providerId { current = choices.first { $0.id == selection.modelId } }
            // A hidden account is not offered, though the selection on it stays.
            guard !provider.hidden else { continue }
            let account = Account(id: provider.id, label: provider.name ?? provider.id, models: choices)
            if let index = services.firstIndex(where: { $0.id == provider.type }) {
                services[index].accounts.append(account)
                if provider.id == selection.providerId { services[index].account = provider.id }
            } else {
                services.append(Service(id: provider.type, label: Self.serviceName(provider.type), accounts: [account], account: provider.id))
            }
            // A switched-off account is listed, but a service opens on one that works.
            if let index = services.firstIndex(where: { $0.id == provider.type }), !provider.isDisabled,
               catalog.provider(services[index].account)?.isDisabled == true,
               !services[index].accounts.contains(where: { $0.id == selection.providerId }) {
                services[index].account = provider.id
            }
        }
        let selected = catalog.provider(selection.providerId)
        // An account removed from the configuration still names its model.
        if current == nil, let model = catalog.models.first(where: { $0.id == selection.modelId }) {
            current = Self.choice(model, disabled: true)
        }
        self.services = services
        self.current = current
        let name = selected?.name ?? selection.providerId
        if let selected, !selected.isDisabled {
            notice = selected.hidden ? .hidden : nil
        } else if selected == nil {
            notice = .removed(name)
        } else {
            notice = .off(name)
        }
    }

    static func choice(_ model: StemCellModelCatalog.Model, disabled: Bool) -> Choice {
        Choice(id: model.id, label: model.name, efforts: model.efforts, defaultEffort: model.defaultEffort, disabled: disabled)
    }

    /// The selected service, and its account.
    public var selectedService: Service? { services.first { $0.accounts.contains { $0.id == selection.providerId } } }
    public var selectedAccount: Account? { selectedService?.accounts.first { $0.id == selection.providerId } }

    /// The effort shown: the selection's when its model supports it, else
    /// the model's own default.
    public var effort: String? {
        guard let current else { return selection.effort }
        return current.efforts.contains(selection.effort) ? selection.effort : current.defaultEffort
    }

    /// `composerModelAccountModel`: the model an account is switched onto,
    /// the same one when it offers it, otherwise its first. Nil when it
    /// offers neither.
    public func model(on account: Account) -> Choice? {
        account.models.first { $0.id == selection.modelId && !$0.disabled } ?? account.models.first { !$0.disabled }
    }

    /// The service a provider type names ("Claude", "Codex"), titled when unknown.
    public static func serviceName(_ type: String) -> String {
        switch type {
        case "bedrock": "Bedrock"
        case "claude": "Claude"
        case "codex": "Codex"
        case "grok": "Grok"
        default:
            type.split(whereSeparator: { $0 == "_" || $0 == "-" }).map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
        }
    }

    /// `happyAgentThinkingLabel`.
    public static func effortName(_ level: String) -> String {
        switch level {
        case "off": "Off"
        case "on": "On"
        case "minimal": "Minimal"
        case "low": "Low"
        case "medium": "Medium"
        case "high": "High"
        case "xhigh": "Extra High"
        case "max": "Maximum"
        case "ultra": "Ultra"
        default: level.prefix(1).uppercased() + level.dropFirst()
        }
    }
}

/// One account's plan usage as the picker shows it: desktop's
/// `happyAgentComposerModelUsageProject` for one `GET /v0/usage` entry.
public struct StemCellAccountUsage: Equatable, Sendable {
    public struct Window: Equatable, Sendable {
        public enum Kind: Equatable, Sendable { case week, session }

        public var kind: Kind
        public var usedPercent: Double
        public var resetsAt: Date?
        public var capturedAt: Date?
        /// The account can't be used until this window starts over.
        public var blocking: Bool

        /// What is left, 0–100, as the rings read it.
        public var left: Int { Int(min(100, max(0, 100 - usedPercent)).rounded()) }
    }

    /// How a ring is coloured.
    public enum Tone: Equatable, Sendable { case ample, low, critical }

    public var week: Window?
    public var session: Window?
    public var updatedAt: Date?
    public var refreshing: Bool
    public var refreshError: String?
    /// The account has spent its limit.
    public var limited: Bool
    /// When it is usable again, if the service said.
    public var limitResets: Date?

    /// Every account with a reading, a read in flight or a failed read.
    public static func project(_ response: JSONValue) -> [String: StemCellAccountUsage] {
        var usage: [String: StemCellAccountUsage] = [:]
        for entry in response["providers"]?.arrayValue ?? [] {
            guard let providerId = entry["providerId"]?.stringValue else { continue }
            let reading = entry["usage"]
            let windows = reading?["windows"]
            let fiveHour = windows?["fiveHour"].flatMap(rawWindow)
            let weekly = windows?["weekly"].flatMap(rawWindow)
            let monthly = windows?["monthly"].flatMap(rawWindow)
            let hasPlan = fiveHour != nil || weekly != nil || reading?["planName"]?.stringValue != nil
            let refreshedAt = entry["refreshedAt"]?.numberValue ?? (hasPlan ? reading?["capturedAt"]?.numberValue : nil)
            let refreshError = entry["refreshError"]?.stringValue ?? entry["error"]?.stringValue
            let refreshing = entry["refreshing"]?.boolValue ?? false
            guard hasPlan || refreshing || refreshError != nil else { continue }
            let exhausted = hasPlan && reading?["exhausted"]?.boolValue == true
            // Every full window holds a spent account back; one blocked with
            // none full waits on its fullest.
            var blocking: [Raw] = []
            if exhausted {
                let all = [fiveHour, weekly, monthly].compactMap { $0 }
                let full = all.filter { $0.used >= 100 }
                blocking = full.isEmpty ? Array(all.sorted { $0.used > $1.used }.prefix(1)) : full
            }
            func window(_ kind: Window.Kind, _ raw: Raw?) -> Window? {
                raw.map { raw in
                    Window(kind: kind, usedPercent: raw.used, resetsAt: raw.resets.map(date), capturedAt: raw.captured.map(date), blocking: blocking.contains(raw))
                }
            }
            let resets = blocking.compactMap(\.resets).max()
            usage[providerId] = StemCellAccountUsage(
                week: hasPlan ? window(.week, weekly) : nil,
                session: hasPlan ? window(.session, fiveHour) : nil,
                updatedAt: refreshedAt.map(date),
                refreshing: refreshing,
                refreshError: refreshError,
                limited: exhausted,
                limitResets: exhausted ? resets.map(date) : nil
            )
        }
        return usage
    }

    private struct Raw: Equatable {
        var used: Double
        var resets: Double?
        var captured: Double?
    }

    private static func rawWindow(_ value: JSONValue) -> Raw? {
        value["usedPercent"]?.numberValue.map { Raw(used: $0, resets: value["resetsAt"]?.numberValue, captured: value["capturedAt"]?.numberValue) }
    }

    private static func date(_ milliseconds: Double) -> Date { Date(timeIntervalSince1970: milliseconds / 1000) }

    /// The window an account's row shows: its week, else its session.
    public var shown: Window? { week ?? session }

    public static func tone(left: Int, blocked: Bool) -> Tone {
        if blocked || left < 10 { return .critical }
        return left < 25 ? .low : .ample
    }
}

/// The keys of one JSON object in the order they were written, which a
/// decoded dictionary forgets. `path` names the object from the top.
enum JSONKeyOrder {
    static func keys(in data: Data, at path: [String]) -> [String] {
        let bytes = [UInt8](data)
        var index = 0
        func skipSpace() {
            while index < bytes.count, [0x20, 0x0A, 0x0D, 0x09].contains(bytes[index]) { index += 1 }
        }
        func string() -> String? {
            guard index < bytes.count, bytes[index] == 0x22 else { return nil }
            let start = index
            index += 1
            while index < bytes.count, bytes[index] != 0x22 {
                index += bytes[index] == 0x5C ? 2 : 1
            }
            index += 1
            return try? JSONDecoder().decode(String.self, from: Data(bytes[start..<min(index, bytes.count)]))
        }
        /// Past one value of any kind.
        func skipValue() {
            skipSpace()
            guard index < bytes.count else { return }
            switch bytes[index] {
            case 0x22:
                _ = string()
            case 0x7B, 0x5B:
                var depth = 0
                repeat {
                    switch bytes[index] {
                    case 0x22: _ = string(); continue
                    case 0x7B, 0x5B: depth += 1
                    case 0x7D, 0x5D: depth -= 1
                    default: break
                    }
                    index += 1
                } while index < bytes.count && depth > 0
            default:
                while index < bytes.count, ![0x2C, 0x7D, 0x5D].contains(bytes[index]) { index += 1 }
            }
        }
        /// The keys of the object at `index`, descending into `rest` when given.
        func walk(_ rest: ArraySlice<String>) -> [String] {
            skipSpace()
            guard index < bytes.count, bytes[index] == 0x7B else { return [] }
            index += 1
            var keys: [String] = []
            while true {
                skipSpace()
                guard index < bytes.count, bytes[index] != 0x7D, let key = string() else { return rest.isEmpty ? keys : [] }
                skipSpace()
                index += 1 // the colon
                if let next = rest.first, key == next { return walk(rest.dropFirst()) }
                keys.append(key)
                skipValue()
                skipSpace()
                if index < bytes.count, bytes[index] == 0x2C { index += 1 }
            }
        }
        return path.isEmpty ? walk([]) : walk(path[...])
    }
}
