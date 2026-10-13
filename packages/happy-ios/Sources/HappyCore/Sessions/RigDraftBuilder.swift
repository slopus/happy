import Foundation
import HappyWire

/// rigComposer.composeRigDraft, using the persistent native composer mirror.
enum RigDraftBuilder {
    static func compose(metadata: JSONValue, composer: JSONValue, text: String?) -> JSONValue {
        let mode = metadata["draft"]?.objectValue ?? metadata["lastMode"]?.objectValue ?? [:]
        let modelKey = composer["modelMode"]?.stringValue ?? {
            guard let provider = mode["providerId"]?.stringValue, let model = mode["modelId"]?.stringValue else { return nil }
            return "\(provider):\(model)"
        }()
        let models = metadata["models"]?.arrayValue ?? []
        let model = models.first { candidate in
            guard let provider = nonempty(candidate["provider"]?["id"]?.stringValue) ?? nonempty(candidate["providerId"]?.stringValue),
                  let id = nonempty(candidate["id"]?.stringValue) ?? nonempty(candidate["code"]?.stringValue) else { return false }
            return "\(provider):\(id)" == modelKey
        }
        let parts = modelKey?.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let splitProvider = parts?.count == 2 && parts?.first?.isEmpty == false ? String(parts![0]) : nil
        let splitModel = splitProvider == nil ? nil : String(parts![1])
        let provider = nonempty(model?["provider"]?["id"]?.stringValue)
            ?? nonempty(model?["providerId"]?.stringValue) ?? splitProvider
            ?? metadata["currentModelProviderId"]?.stringValue ?? ""
        let modelId = nonempty(model?["id"]?.stringValue) ?? nonempty(model?["code"]?.stringValue) ?? splitModel ?? metadata["currentModelCode"]?.stringValue ?? ""
        let modelLevels = model?["thinkingLevels"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let reasoningLevels = metadata["reasoning"]?["levels"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let levels = !modelLevels.isEmpty ? modelLevels : !reasoningLevels.isEmpty ? reasoningLevels
            : metadata["thoughtLevels"]?.arrayValue?.compactMap { $0["code"]?.stringValue } ?? []
        let requestedEffort = nonempty(composer["effortLevel"]?.stringValue)
        let explicit = mode["effort"]?.stringValue ?? metadata["reasoning"]?["current"]?.stringValue ?? metadata["currentThoughtLevelCode"]?.stringValue
        let modelDefault = nonempty(model?["defaultThinkingLevel"]?.stringValue)
        let selected = explicit.flatMap { !$0.isEmpty && levels.contains($0) ? $0 : nil } ?? modelDefault.flatMap { levels.contains($0) ? $0 : nil }
        let effort = requestedEffort.flatMap { model == nil || modelLevels.contains($0) ? $0 : nil }
            ?? selected ?? modelDefault ?? mode["effort"]?.stringValue
            ?? metadata["currentThoughtLevelCode"]?.stringValue ?? ""
        let requestedTier = composer["serviceTier"] ?? mode["serviceTier"] ?? metadata["session"]?["serviceTier"] ?? .null
        let tiers = model?["serviceTiers"]?.arrayValue ?? []
        let tier = requestedTier == .null || model == nil ? requestedTier : tiers.contains(requestedTier) ? requestedTier : .null
        let permission = composer["permissionMode"]?.stringValue ?? mode["permissionMode"]?.stringValue
            ?? metadata["currentOperatingModeCode"]?.stringValue ?? metadata["permissionMode"]?.stringValue
            ?? metadata["session"]?["permissionMode"]?.stringValue ?? ""
        return .object([
            "text": .string(text ?? metadata["draft"]?["text"]?.stringValue ?? ""),
            "providerId": .string(provider),
            "modelId": .string(modelId),
            "effort": .string(effort),
            "serviceTier": tier,
            "permissionMode": .string(permission),
        ])
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}
