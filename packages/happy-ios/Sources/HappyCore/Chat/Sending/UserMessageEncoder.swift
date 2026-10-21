import Foundation
import HappyStore
import HappyWire

/// Refuses a permission mode the session's CLI cannot parse, before acceptance.
public struct UnsupportedPermissionModeError: Error, Equatable, Sendable, LocalizedError {
    public let mode: String
    public let cliVersion: String
    public var errorDescription: String? {
        "This session's Happy CLI (v\(cliVersion)) does not support the '\(mode)' permission mode. "
            + "Pick a different mode for this session, or update the Happy CLI on that machine."
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

    public static func encode(
        _ message: OutgoingMessage,
        session: SessionRecord,
        composer: JSONValue = .object([:]),
        settings: JSONValue? = nil,
        hasPendingUserMessage: @autoclosure () throws -> Bool = false,
        sentFrom: String = "ios"
    ) throws -> JSONValue {
        var meta: [String: JSONValue] = ["sentFrom": .string(sentFrom)]
        let metadata = session.metadata ?? .object([:])
        if SessionMetadata.sendsMessageReceipts(metadata) {
            let requests = !(session.agentState?["requests"]?.objectValue ?? [:]).isEmpty
            let questions = (session.agentState?["communications"]?.objectValue ?? [:]).contains { id, communication in
                if let completed = session.agentState?["completedCommunications"]?[id],
                   completed != .null, completed != .bool(false) {
                    return false
                }
                if communication["kind"]?.stringValue != "form" {
                    return true
                }
                return (communication["form"]?["questions"]?.arrayValue ?? []).contains { question in
                    !(question["options"]?.arrayValue ?? []).isEmpty || question["allowCustom"]?.boolValue != false
                }
            }
            meta["expectsAcceptance"] = .bool(true)
            // The pending look reads the store, so it comes last: only an
            // idle agent's send needs it.
            let busy = requests || (!questions && session.thinking)
            let queued = try message.source != .newSession && (busy || hasPendingUserMessage())
            meta["queuedWhileBusy"] = .bool(queued)
        }
        meta["appendSystemPrompt"] = .string(systemPrompt)
        meta.merge(try modeMeta(metadata: metadata, composer: composer, settings: settings)) { _, value in value }
        if let display = message.displayText, !display.isEmpty {
            meta["displayText"] = .string(display)
        }
        return .object([
            "role": .string("user"),
            "content": .object(["type": .string("text"), "text": .string(message.text)]),
            "meta": .object(meta),
        ])
    }

    public static func isRig(_ metadata: JSONValue) -> Bool {
        SessionMetadata.isRigV1(metadata)
    }

    static func modeMeta(metadata m: JSONValue, composer c: JSONValue, settings: JSONValue?) throws -> [String: JSONValue] {
        var result: [String: JSONValue] = [:]
        func value(_ value: JSONValue?) -> JSONValue? {
            value == .null ? nil : value
        }
        func first(_ values: JSONValue?...) -> JSONValue? {
            values.compactMap(value).first
        }
        func nonEmpty(_ values: JSONValue?...) -> String? {
            values.compactMap { $0?.stringValue }.first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        }
        if isRig(m) {
            let mode = first(m["draft"], m["lastMode"])
            if let permission = first(
                c["permissionMode"], mode?["permissionMode"], m["currentOperatingModeCode"],
                m["permissionMode"], m["session"]?["permissionMode"]
            ), permission.stringValue != "" {
                result["permissionMode"] = permission
            }
            if let tier = c["serviceTier"] {
                result["serviceTier"] = tier
            } else if let mode {
                result["serviceTier"] = mode["serviceTier"]
            }
            let currentProvider = nonEmpty(mode?["providerId"], m["currentModelProviderId"], m["model"]?["providerId"])
            let currentID = nonEmpty(mode?["modelId"], m["currentModelCode"], m["model"]?["id"])
            let currentKey = currentProvider.flatMap { provider in currentID.map { "\(provider):\($0)" } }
            let selected = c["modelMode"]?.stringValue ?? currentKey
            let models = (m["models"]?.arrayValue ?? []).filter {
                nonEmpty($0["provider"]?["id"], $0["providerId"]) != nil && nonEmpty($0["id"], $0["code"]) != nil
            }
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
            if levels.isEmpty {
                levels = m["reasoning"]?["levels"]?.arrayValue ?? []
            }
            if levels.isEmpty {
                levels = (m["thoughtLevels"]?.arrayValue ?? []).compactMap { $0["code"] }
            }
            let explicit = first(mode?["effort"], m["reasoning"]?["current"], m["currentThoughtLevelCode"])
            let local = c["effortLevel"]
            if let local, local.stringValue != "", levels.contains(local) {
                result["effort"] = local
            } else if let explicit, explicit.stringValue != "", levels.contains(explicit) {
                result["effort"] = explicit
            } else if let fallback = nonEmpty(model?["defaultThinkingLevel"]), levels.contains(.string(fallback)) {
                result["effort"] = .string(fallback)
            }
            return result
        }
        let flavor = m["flavor"]?.stringValue ?? "claude"
        let agent = AgentDefaults.Agent(rawValue: flavor) ?? .claude
        let overrides = settings?["agentDefaultOverrides"]?.objectValue ?? [:]
        let version = m["version"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        let concrete = flavor == "codex" || flavor == "agy"
        var permission = c["permissionMode"]?.stringValue
            ?? AgentDefaults.override(overrides, agent, .permissionMode)
        var model = c["modelMode"]?.stringValue
            ?? AgentDefaults.override(overrides, agent, .modelMode)
        var effort = c["effortLevel"]?.stringValue
            ?? AgentDefaults.override(overrides, agent, .effortLevel)
        if concrete {
            let defaults = AgentDefaults.resolve(overrides, agent, cliVersion: version)
            permission = permission ?? defaults.permissionMode
            model = model ?? defaults.modelMode
            effort = effort ?? defaults.effortLevel
        }
        if let selected = permission {
            let retired = AgentDefaults.retirePermissionMode(selected)
            guard AgentDefaults.permissionModeSupportedByCli(retired, cliVersion: version) else {
                throw UnsupportedPermissionModeError(mode: retired, cliVersion: version ?? "unknown")
            }
            result["permissionMode"] = .string(retired)
        }
        if let model {
            result["model"] = model == "default" ? .null : .string(model)
        }
        if let effort {
            result["effort"] = .string(effort)
        }
        return result
    }

    /// JSON.stringify insertion order on the wire; canonical sorted bytes remain available via JSONValue.encoded().
    public static func wireBytes(_ record: JSONValue) throws -> Data {
        func object(_ value: JSONValue, keys: [String]) throws -> String {
            guard let values = value.objectValue else {
                return try value.encodedString()
            }
            let extras = values.keys.filter { !keys.contains($0) }.sorted()
            let fields = try (keys + extras).compactMap { key -> String? in
                guard let value = values[key] else {
                    return nil
                }
                let encoded: String
                switch key {
                case "content":
                    encoded = try object(value, keys: ["type", "text", "data"])
                case "meta":
                    encoded = try object(value, keys: [
                        "sentFrom", "expectsAcceptance", "queuedWhileBusy", "appendSystemPrompt",
                        "permissionMode", "model", "modelProviderId", "effort", "serviceTier", "displayText",
                    ])
                case "data":
                    encoded = try object(value, keys: ["id", "time", "role", "ev"])
                case "ev":
                    encoded = try object(value, keys: ["t", "ref", "name", "size", "image"])
                case "image":
                    encoded = try object(value, keys: ["width", "height", "thumbhash"])
                default:
                    encoded = try value.encodedString()
                }
                return try JSONValue.string(key).encodedString() + ":" + encoded
            }
            return "{" + fields.joined(separator: ",") + "}"
        }
        return Data(try object(record, keys: ["role", "content", "meta"]).utf8)
    }
}
