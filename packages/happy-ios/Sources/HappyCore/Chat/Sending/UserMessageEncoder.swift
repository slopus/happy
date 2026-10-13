import Foundation
import HappyStore
import HappyWire

public struct UnsupportedPermissionModeError: Error, Equatable, Sendable, LocalizedError {
    public let mode: String
    public let cliVersion: String
    public var errorDescription: String? {
        "This session's Happy CLI (v\(cliVersion)) does not support the '\(mode)' permission mode. Pick a different mode for this session, or update the Happy CLI on that machine."
    }
}

/// The single user-message encoding boundary to switch when the session protocol is redesigned.
/// Ports sync.ts sendMessage, messageMeta.ts and its Rig/default helpers.
public enum UserMessageEncoder {
    public static let systemPrompt = """
    # Options

    You have a way to give a user a easy way to answer your questions if you know possible answers. To provide this, you need to output in your final response an XML:

    <options>
        <option>Option 1</option>
        ...
        <option>Option N</option>
    </options>

    You must output this in the very end of your response, not inside of any other text. Do not wrap it into a codeblock. Always dedicate "<options>" and "</options>" to a dedicated line. Never output anything like "custom", user always have an option to send a custom message. Do not enumerate options in both text and options block.
    Always prefer to use the options mode to the text mode. Try to keep options minimal, better to clarify in a next steps.

    # Plan mode with options

    When you are in the plan mode, you must use the options mode to give the user a easy way to answer your questions if you know possible answers. Do not assume what is needed, when there is discrepancy between what you need and what you have, you must use the options mode.
    """

    public static func encode(_ message: OutgoingMessage, session: SessionRecord, composer: JSONValue = .object([:]), settings: JSONValue? = nil, hasPendingUserMessage: Bool = false, sentFrom: String = "ios") throws -> JSONValue {
        var meta: [String: JSONValue] = ["sentFrom": .string(sentFrom)]
        let metadata = session.metadata ?? .object([:])
        if isRig(metadata), metadata["capabilities"]?["messageReceipts"]?.boolValue == true {
            let requests = !(session.agentState?["requests"]?.objectValue ?? [:]).isEmpty
            let questions = (session.agentState?["communications"]?.objectValue ?? [:]).contains { id, communication in
                if let completed = session.agentState?["completedCommunications"]?[id], completed != .null, completed != .bool(false) { return false }
                if communication["kind"]?.stringValue != "form" { return true }
                return (communication["form"]?["questions"]?.arrayValue ?? []).contains { question in
                    !(question["options"]?.arrayValue ?? []).isEmpty || question["allowCustom"]?.boolValue != false
                }
            }
            meta["expectsAcceptance"] = .bool(true)
            meta["queuedWhileBusy"] = .bool(message.source != .newSession && (hasPendingUserMessage || requests || (!questions && session.thinking)))
        }
        meta["appendSystemPrompt"] = .string(systemPrompt)
        meta.merge(try modeMeta(metadata: metadata, composer: composer, settings: settings)) { _, value in value }
        if let display = message.displayText, !display.isEmpty { meta["displayText"] = .string(display) }
        return .object(["role": .string("user"), "content": .object(["type": .string("text"), "text": .string(message.text)]), "meta": .object(meta)])
    }

    public static func isRig(_ metadata: JSONValue) -> Bool {
        metadata["client"]?["id"]?.stringValue == "rig" && (metadata["rigMetadataVersion"]?.numberValue ?? 0) >= 1
    }

    static func modeMeta(metadata m: JSONValue, composer c: JSONValue, settings: JSONValue?) throws -> [String: JSONValue] {
        var result: [String: JSONValue] = [:]
        func value(_ value: JSONValue?) -> JSONValue? { value == .null ? nil : value }
        func first(_ values: JSONValue?...) -> JSONValue? { values.compactMap(value).first }
        func nonEmpty(_ values: JSONValue?...) -> String? {
            values.compactMap { $0?.stringValue }.first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        }
        if isRig(m) {
            let mode = first(m["draft"], m["lastMode"])
            if let permission = first(c["permissionMode"], mode?["permissionMode"], m["currentOperatingModeCode"], m["permissionMode"], m["session"]?["permissionMode"]), permission.stringValue != "" { result["permissionMode"] = permission }
            if let tier = c["serviceTier"] { result["serviceTier"] = tier }
            else if let mode { result["serviceTier"] = mode["serviceTier"] }
            let currentProvider = nonEmpty(mode?["providerId"], m["currentModelProviderId"], m["model"]?["providerId"])
            let currentID = nonEmpty(mode?["modelId"], m["currentModelCode"], m["model"]?["id"])
            let currentKey = currentProvider.flatMap { provider in currentID.map { "\(provider):\($0)" } }
            let selected = c["modelMode"]?.stringValue ?? currentKey
            let models = (m["models"]?.arrayValue ?? []).filter { nonEmpty($0["provider"]?["id"], $0["providerId"]) != nil && nonEmpty($0["id"], $0["code"]) != nil }
            let model = models.first { model in
                "\(nonEmpty(model["provider"]?["id"], model["providerId"])!):\(nonEmpty(model["id"], model["code"])!)" == selected
            }
            if let model {
                result["model"] = .string(nonEmpty(model["id"], model["code"])!)
                result["modelProviderId"] = .string(nonEmpty(model["provider"]?["id"], model["providerId"])!)
            } else if let selected, let separator = selected.firstIndex(of: ":") {
                result["modelProviderId"] = .string(String(selected[..<separator]))
                result["model"] = .string(String(selected[selected.index(after: separator)...]))
            }
            var levels = model?["thinkingLevels"]?.arrayValue ?? []
            if levels.isEmpty { levels = m["reasoning"]?["levels"]?.arrayValue ?? [] }
            if levels.isEmpty { levels = (m["thoughtLevels"]?.arrayValue ?? []).compactMap { $0["code"] } }
            let explicit = first(mode?["effort"], m["reasoning"]?["current"], m["currentThoughtLevelCode"])
            let local = c["effortLevel"]
            if let local, local.stringValue != "", levels.contains(local) { result["effort"] = local }
            else if let explicit, explicit.stringValue != "", levels.contains(explicit) { result["effort"] = explicit }
            else if let fallback = nonEmpty(model?["defaultThinkingLevel"]), levels.contains(.string(fallback)) { result["effort"] = .string(fallback) }
            return result
        }
        let flavor = m["flavor"]?.stringValue ?? "claude"
        let agent = ["codex", "gemini", "openclaw", "agy"].contains(flavor) ? flavor : "claude"
        var overrides = settings?["agentDefaultOverrides"]?[agent]?.objectValue ?? [:]
        func retired(_ mode: JSONValue?) -> JSONValue? { mode == .string("dontAsk") ? .string("acceptEdits") : mode }
        overrides["permissionMode"] = retired(overrides["permissionMode"])
        if agent == "claude", let model = overrides["modelMode"]?.stringValue, ["claude-opus-5-5[1m]", "claude-opus-5[1m]", "claude-sonnet-5-5[1m]"].contains(model) { overrides["modelMode"] = .string(String(model.dropLast(4))) }
        let version = m["version"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        let concrete = flavor == "codex" || flavor == "agy"
        var permission = first(c["permissionMode"], overrides["permissionMode"])
        var model = first(c["modelMode"], overrides["modelMode"])
        var effort = first(c["effortLevel"], overrides["effortLevel"])
        if concrete {
            if permission == nil { permission = .string(flavor == "agy" ? "default" : (version == nil || supportsAuto(version!) ? "auto" : "default")) }
            if model == nil { model = .string(flavor == "agy" ? "Gemini 3.8 Flash" : "gpt-6.1-sol") }
            if effort == nil { effort = .string("medium") }
        }
        permission = retired(permission)
        if permission == .string("auto"), let version, !supportsAuto(version) {
            throw UnsupportedPermissionModeError(mode: "auto", cliVersion: version)
        }
        result["permissionMode"] = permission
        if let model { result["model"] = model == .string("default") ? .null : model }
        result["effort"] = effort
        return result
    }

    /// Semver boundary shared with agentDefaults.ts; unknown versions allow auto.
    static func supportsAuto(_ version: String) -> Bool {
        guard version.range(of: #"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$"#, options: .regularExpression) != nil else { return false }
        let normalized = version.split(separator: "+", maxSplits: 1)[0]
        let parts = normalized.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let numbers = parts[0].split(separator: ".").compactMap { Int($0) }
        guard numbers.count == 3 else { return false }
        let target = [1, 2, 1]
        if numbers != target { return target.lexicographicallyPrecedes(numbers) }
        guard parts.count > 1 else { return true }
        let pre = parts[1].split(separator: ".", omittingEmptySubsequences: false)
        let boundary = ["beta", "2"]
        for index in 0..<min(pre.count, boundary.count) {
            let a = String(pre[index]), b = boundary[index]
            if a == b { continue }
            if let an = Int(a), let bn = Int(b) { return an > bn }
            if Int(a) != nil { return false }
            if Int(b) != nil { return true }
            return a > b
        }
        return pre.count >= boundary.count
    }

    /// JSON.stringify insertion order on the wire; canonical sorted bytes remain available via JSONValue.encoded().
    public static func wireBytes(_ record: JSONValue) throws -> Data {
        func object(_ value: JSONValue, keys: [String]) throws -> String {
            let fields = try keys.compactMap { key -> String? in
                guard let value = value[key] else { return nil }
                let encoded: String
                if key == "content" { encoded = try object(value, keys: ["type", "text", "data"]) }
                else if key == "meta" { encoded = try object(value, keys: ["sentFrom", "expectsAcceptance", "queuedWhileBusy", "appendSystemPrompt", "permissionMode", "model", "modelProviderId", "effort", "serviceTier", "displayText"]) }
                else if key == "data" { encoded = try object(value, keys: ["id", "time", "role", "ev"]) }
                else if key == "ev" { encoded = try object(value, keys: ["t", "ref", "name", "size", "image"]) }
                else if key == "image" { encoded = try object(value, keys: ["width", "height", "thumbhash"]) }
                else { encoded = try value.encodedString() }
                return "\"\(key)\":\(encoded)"
            }
            return "{" + fields.joined(separator: ",") + "}"
        }
        return Data(try object(record, keys: ["role", "content", "meta"]).utf8)
    }
}