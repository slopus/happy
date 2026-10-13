import Foundation
import HappyStore
import HappyWire

/// A model a Happy Agent session advertises (rig.ts `RigModelDescriptor`).
/// `key` is `providerId:id`.
public struct RigModelDescriptor: Equatable, Sendable {
    public var key: String
    public var id: String
    public var providerId: String
    public var name: String
    public var providerName: String
    public var providerKind: String
    public var contextWindow: Double?
    public var serviceTiers: [String]
    public var thinkingLevels: [String]
    public var defaultThinkingLevel: String?
    /// The selected model is not in the catalog.
    public var isUnavailable: Bool

    public init(
        key: String,
        id: String,
        providerId: String,
        name: String,
        providerName: String,
        providerKind: String,
        contextWindow: Double? = nil,
        serviceTiers: [String] = [],
        thinkingLevels: [String] = [],
        defaultThinkingLevel: String? = nil,
        isUnavailable: Bool = false
    ) {
        self.key = key
        self.id = id
        self.providerId = providerId
        self.name = name
        self.providerName = providerName
        self.providerKind = providerKind
        self.contextWindow = contextWindow
        self.serviceTiers = serviceTiers
        self.thinkingLevels = thinkingLevels
        self.defaultThinkingLevel = defaultThinkingLevel
        self.isUnavailable = isUnavailable
    }
}

/// rig.ts: what a Happy Agent session's metadata publishes for the
/// composer's pickers (its models, reasoning levels and what is selected).
public enum RigCatalog {
    /// `isRigMetadata`.
    public static func isRig(_ metadata: JSONValue?) -> Bool {
        metadata?["client"]?["id"]?.stringValue == "rig"
    }

    /// `isRigMetadataV1`.
    public static func isRigV1(_ metadata: JSONValue?) -> Bool {
        SessionMetadata.isRigV1(metadata)
    }

    /// `qualifyRigModelKey`.
    public static func modelKey(providerId: String, modelId: String) -> String {
        "\(providerId):\(modelId)"
    }

    /// `getRigModels`: every advertised model with a provider and an id.
    public static func models(_ metadata: JSONValue?) -> [RigModelDescriptor] {
        guard isRig(metadata) else { return [] }
        return (metadata?["models"]?.arrayValue ?? []).compactMap { model in
            guard
                let providerId = nonEmpty(model["provider"]?["id"], model["providerId"]),
                let id = nonEmpty(model["id"], model["code"])
            else { return nil }
            return RigModelDescriptor(
                key: modelKey(providerId: providerId, modelId: id),
                id: id,
                providerId: providerId,
                name: nonEmpty(model["name"], model["value"]) ?? id,
                providerName: nonEmpty(model["provider"]?["name"], model["providerName"]) ?? providerId,
                providerKind: nonEmpty(model["provider"]?["kind"], model["providerKind"]) ?? "custom",
                contextWindow: model["contextWindow"]?.numberValue,
                serviceTiers: strings(model["serviceTiers"]),
                thinkingLevels: strings(model["thinkingLevels"]),
                defaultThinkingLevel: nonEmpty(model["defaultThinkingLevel"])
            )
        }
    }

    /// `getRigComposerMode`: the open draft's mode, else the one the daemon
    /// last ran with.
    public static func composerMode(_ metadata: JSONValue?) -> JSONValue? {
        guard isRigV1(metadata) else { return nil }
        return present(metadata?["draft"]) ?? present(metadata?["lastMode"])
    }

    /// `getRigSelectedModelPair`.
    public static func selectedModelPair(_ metadata: JSONValue?) -> (providerId: String, id: String)? {
        guard isRig(metadata) else { return nil }
        let mode = composerMode(metadata)
        let providerId = nonEmpty(mode?["providerId"], metadata?["currentModelProviderId"], metadata?["model"]?["providerId"])
        let id = nonEmpty(mode?["modelId"], metadata?["currentModelCode"], metadata?["model"]?["id"])
        guard let providerId, let id else { return nil }
        return (providerId, id)
    }

    /// `getRigSelectedModelKey`.
    public static func selectedModelKey(_ metadata: JSONValue?) -> String? {
        selectedModelPair(metadata).map { modelKey(providerId: $0.providerId, modelId: $0.id) }
    }

    /// `getRigCurrentModel`: the selected model, or an unavailable stand-in
    /// when the catalog no longer lists it.
    public static func currentModel(_ metadata: JSONValue?) -> RigModelDescriptor? {
        guard let selected = selectedModelPair(metadata) else { return nil }
        let key = modelKey(providerId: selected.providerId, modelId: selected.id)
        if let model = models(metadata).first(where: { $0.key == key }) {
            return model
        }
        let provider = metadata?["provider"]?["id"]?.stringValue == selected.providerId
            ? metadata?["provider"]
            : metadata?["providers"]?.arrayValue?.first { $0["id"]?.stringValue == selected.providerId }
        return RigModelDescriptor(
            key: key,
            id: selected.id,
            providerId: selected.providerId,
            name: selected.id,
            providerName: provider?["name"]?.stringValue ?? selected.providerId,
            providerKind: provider?["kind"]?.stringValue ?? "custom",
            isUnavailable: true
        )
    }

    /// `getRigReasoningLevels`: the model's own levels, else the session's.
    public static func reasoningLevels(_ metadata: JSONValue?, modelKey: String?) -> [String] {
        guard isRig(metadata) else { return [] }
        if let model = models(metadata).first(where: { $0.key == modelKey }), !model.thinkingLevels.isEmpty {
            return model.thinkingLevels
        }
        let levels = strings(metadata?["reasoning"]?["levels"])
        if !levels.isEmpty {
            return levels
        }
        return (metadata?["thoughtLevels"]?.arrayValue ?? []).compactMap { $0["code"]?.stringValue }
    }

    /// `getRigReasoningSelection`: the explicit level if the model offers
    /// it, else the model's default if it does.
    public static func reasoningSelection(_ metadata: JSONValue?, modelKey: String?) -> String? {
        guard isRig(metadata) else { return nil }
        let levels = reasoningLevels(metadata, modelKey: modelKey)
        let explicit = present(composerMode(metadata)?["effort"])?.stringValue
            ?? present(metadata?["reasoning"]?["current"])?.stringValue
            ?? metadata?["currentThoughtLevelCode"]?.stringValue
        if let explicit, !explicit.isEmpty, levels.contains(explicit) {
            return explicit
        }
        let modelDefault = models(metadata).first { $0.key == modelKey }?.defaultThinkingLevel
        if let modelDefault, levels.contains(modelDefault) {
            return modelDefault
        }
        return nil
    }

    /// `isRigModelSelectionEnabled`.
    public static func isModelSelectionEnabled(_ metadata: JSONValue?) -> Bool {
        !isRigV1(metadata)
            || (metadata?["session"]?["modelLocked"]?.boolValue != true
                && metadata?["capabilities"]?["modelSelection"]?.boolValue != false)
    }

    /// `isRigReasoningSelectionEnabled`.
    public static func isReasoningSelectionEnabled(_ metadata: JSONValue?) -> Bool {
        !isRigV1(metadata) || metadata?["capabilities"]?["reasoningSelection"]?.boolValue != false
    }

    /// `isRigPermissionSelectionEnabled`.
    public static func isPermissionSelectionEnabled(_ metadata: JSONValue?) -> Bool {
        !isRigV1(metadata) || metadata?["capabilities"]?["permissionModeSelection"]?.boolValue != false
    }

    /// rigModelPickerOrder.ts `sortRigModelsForPicker`: Astra leads its
    /// provider (older daemons append it last). Providers keep their order,
    /// and so does every other row.
    public static func sortedForPicker(_ models: [RigModelDescriptor]) -> [RigModelDescriptor] {
        var order: [String] = []
        var groups: [String: [RigModelDescriptor]] = [:]
        for model in models {
            if groups[model.providerId] == nil {
                order.append(model.providerId)
            }
            groups[model.providerId, default: []].append(model)
        }
        func isAstra(_ model: RigModelDescriptor) -> Bool {
            model.id == "openai/gpt-6-astra" || model.id == "gpt-6-astra"
        }
        return order.flatMap { provider in
            let group = groups[provider] ?? []
            return group.filter(isAstra) + group.filter { !isAstra($0) }
        }
    }

    // MARK: JSON

    /// A string with something in it besides whitespace, untrimmed.
    static func nonEmpty(_ values: JSONValue?...) -> String? {
        for value in values {
            if let string = value?.stringValue, !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return string
            }
        }
        return nil
    }

    /// JS `??` treats null as absent.
    static func present(_ value: JSONValue?) -> JSONValue? {
        value == .null ? nil : value
    }

    static func strings(_ value: JSONValue?) -> [String] {
        (value?.arrayValue ?? []).compactMap(\.stringValue)
    }
}
