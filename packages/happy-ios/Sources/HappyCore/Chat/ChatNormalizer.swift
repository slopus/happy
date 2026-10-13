import Foundation
import HappyWire
import HappyStore

/// Canonical blocks, after typesRaw.ts. `raw` retains fields from newer
/// producers; decoding never mutates or discards the stored plaintext.
public struct NormalizedChatRecord: Equatable, Sendable {
    public enum Body: Equatable, Sendable {
        case user(String)
        case agent([Block])
        case event(AgentEvent)
        case unsupported(String)
    }

    public enum Block: Equatable, Sendable {
        case text(String, thinking: Bool)
        case call(id: String, name: String, title: String?, input: JSONValue, description: String?)
        case result(id: String, value: JSONValue, error: Bool)
    }

    public var id: String
    public var localId: String?
    public var createdAt: Int64
    public var body: Body
    public var meta: MessageMeta?
    public var turn: String?
    public var parent: String?
    public var author: SessionAuthor?
    public var claudeUuid: String?
    public var codexItemId: String?
    public var usage: SessionUsage?
    public var raw: JSONValue
}

public enum ChatNormalizer {
    public static func normalize(_ record: MessageRecord) -> NormalizedChatRecord? {
        normalize(id: record.id, localId: record.localId, createdAt: record.createdAt, raw: record.content ?? .null)
    }

    public static func normalize(id: String, localId: String? = nil, createdAt: Int64, raw: JSONValue) -> NormalizedChatRecord? {
        let role = raw["role"]?.stringValue ?? "unknown"
        let content = raw["content"] ?? .null
        let type = content["type"]?.stringValue ?? "unknown"
        let data = content["data"] ?? .null
        let kind = "\(role).\(type).\(data["type"]?.stringValue ?? content["ev"]?["t"]?.stringValue ?? data["ev"]?["t"]?.stringValue ?? "unknown")"
        var record = NormalizedChatRecord(id: id, localId: localId, createdAt: createdAt, body: .unsupported(kind), meta: try? raw["meta"]?.decode(as: MessageMeta.self), raw: raw)
        if role == "user", type == "text", let text = content["text"]?.stringValue {
            record.body = .user(text)
            return record
        }
        if role == "session" {
            let envelopeRaw = type == "session" ? data : content
            guard let envelope = try? envelopeRaw.decode(as: SessionEnvelope.self), validSubagent(envelope.subagent) else { return record }
            let receipt: Bool
            switch envelope.ev {
            case .userMessageAccepted, .userMessageRejected: receipt = true
            default: receipt = false
            }
            let usageOnly: Bool
            if case .service(let text) = envelope.ev {
                usageOnly = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && envelope.usage != nil
            } else { usageOnly = false }
            guard envelope.role != .agent || envelope.turn != nil || receipt || usageOnly else { return record }
            record.id = envelope.id
            record.createdAt = envelope.time
            record.turn = envelope.turn
            record.parent = envelope.subagent
            record.usage = envelope.usage
            record.claudeUuid = envelope.claudeUuid
            record.codexItemId = envelope.codexItemId
            if let author = envelopeRaw["author"], let id = author["id"]?.stringValue, let name = author["name"]?.stringValue {
                record.author = SessionAuthor(id: id, name: name, owner: author["owner"]?.boolValue)
            }
            switch envelope.ev {
            case .turnStart: return nil
            case .start, .stop:
                guard envelope.role == .agent else { return record }
                return nil
            case .turnEnd: record.body = .event(.ready)
            case .userMessageAccepted(_, let ref, _): record.body = .event(.userMessageAccepted(ref: ref))
            case .userMessageRejected(let ref, let reason): record.body = .event(.userMessageRejected(ref: ref, reason: reason))
            case .service(let text):
                guard envelope.role == .agent else { return record }
                record.body = .agent(usageOnly ? [] : [.text(text, thinking: false)])
            case .text(let text, let thinking):
                let visible = stripTaskNotifications(text)
                if visible != text && visible.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
                record.body = envelope.role == .user ? .user(visible) : .agent([.text(visible, thinking: thinking)])
                if envelope.role == .user { record.parent = nil; record.turn = nil }
            case .toolCallStart(let call, let name, let title, let description, let args):
                record.body = .agent([.call(id: call, name: name.isEmpty ? "unknown" : name, title: title, input: .object(args), description: description)])
            case .toolCallEnd(let call, let result, let error):
                record.body = .agent([.result(id: call, value: result.map(JSONValue.string) ?? .null, error: error ?? false)])
            case .file(let ref, let name, let size, _, let image):
                var input: [String: JSONValue] = ["ref": .string(ref), "name": .string(name), "size": .number(size)]
                var description = "Attached file: \(name)"
                if let image {
                    input["image"] = envelopeRaw["ev"]?["image"]
                    description = "Attached image: \(name) (\(number(image.width))x\(number(image.height)))"
                }
                record.body = .agent([.call(id: envelope.id, name: "file", title: nil, input: .object(input), description: description), .result(id: envelope.id, value: .null, error: false)])
            case .unknown: break
            }
            return record
        }
        guard role == "agent" else { return record }
        if type == "event", let event = agentEvent(data) {
            record.body = .event(event)
            return record
        }
        // Only Gemini's active ACP send path, not retired Claude output or
        // Codex wrappers. A declared transport method alone is not an emitter.
        guard type == "acp", content["provider"]?.stringValue == "gemini", let subtype = data["type"]?.stringValue else { return record }
        switch subtype {
        case "message", "reasoning":
            if let text = data["message"]?.stringValue { record.body = .agent([.text(text, thinking: false)]) }
        case "thinking":
            if let text = data["text"]?.stringValue { record.body = .agent([.text(text, thinking: true)]) }
        case "tool-call":
            if let call = data["callId"]?.stringValue, let name = data["name"]?.stringValue, let input = data["input"], data["id"]?.stringValue != nil {
                record.body = .agent([.call(id: call, name: name.isEmpty ? "unknown" : name, title: nil, input: input, description: nil)])
            }
        case "tool-result", "tool-call-result":
            if let call = data["callId"]?.stringValue, let output = data["output"], data["id"]?.stringValue != nil {
                record.body = .agent([.result(id: call, value: output, error: subtype == "tool-result" && data["isError"]?.boolValue == true)])
            }
        case "file-edit":
            if let call = data["id"]?.stringValue, let description = data["description"]?.stringValue, data["filePath"]?.stringValue != nil {
                var args = data.objectValue ?? [:]
                args.removeValue(forKey: "type"); args.removeValue(forKey: "id")
                record.body = .agent([.call(id: call, name: "file-edit", title: nil, input: .object(args), description: description)])
            }
        case "terminal-output":
            if let call = data["callId"]?.stringValue, let text = data["data"]?.stringValue { record.body = .agent([.result(id: call, value: .string(text), error: false)]) }
        case "permission-request":
            if let call = data["permissionId"]?.stringValue, let name = data["toolName"]?.stringValue, let description = data["description"]?.stringValue {
                record.body = .agent([.call(id: call, name: name, title: nil, input: data["options"] ?? .object([:]), description: description)])
            }
        case "task_started", "task_complete", "turn_aborted", "token_count", "token-count": return nil
        default: break
        }
        return record
    }

    static func agentEvent(_ value: JSONValue) -> AgentEvent? {
        switch value["type"]?.stringValue {
        case "switch":
            guard let mode = value["mode"]?.stringValue, ["local", "remote"].contains(mode) else { return nil }
            return .modeSwitch(mode: mode)
        case "message": return value["message"]?.stringValue.map(AgentEvent.message)
        case "limit-reached": return safeTime(value["endsAt"]).map { .limitReached(endsAt: $0) }
        case "ready": return .ready
        case "user-message-accepted": return value["ref"]?.stringValue.map { .userMessageAccepted(ref: $0) }
        case "user-message-rejected":
            guard let ref = value["ref"]?.stringValue, let reason = value["reason"]?.stringValue else { return nil }
            return .userMessageRejected(ref: ref, reason: reason)
        default: return nil
        }
    }

    static func safeTime(_ value: JSONValue?) -> Int64? {
        guard let n = value?.numberValue, n.isFinite, n >= Double(Int64.min), n < Double(Int64.max) else { return nil }
        return Int64(n)
    }

    private static func validSubagent(_ value: String?) -> Bool {
        guard let value else { return true }
        return value.range(of: "^[a-z][a-z0-9]{1,31}$", options: .regularExpression) != nil
    }

    private static func number(_ n: Double) -> String { n.rounded() == n ? String(format: "%.0f", n) : String(n) }

    static func stripTaskNotifications(_ text: String) -> String {
        let open = "<task-notification>", close = "</task-notification>"
        var remaining = text.drop(while: { $0.isWhitespace })[...]
        var stripped = false
        while remaining.hasPrefix(open) {
            var depth = 1
            var cursor = remaining.index(remaining.startIndex, offsetBy: open.count)
            while depth > 0 {
                guard let nextClose = remaining.range(of: close, range: cursor..<remaining.endIndex) else { return stripped ? String(remaining) : text }
                if let nextOpen = remaining.range(of: open, range: cursor..<remaining.endIndex), nextOpen.lowerBound < nextClose.lowerBound {
                    depth += 1; cursor = nextOpen.upperBound
                } else { depth -= 1; cursor = nextClose.upperBound }
            }
            stripped = true
            remaining = remaining[cursor...].drop(while: { $0.isWhitespace })
        }
        return stripped ? String(remaining) : text
    }
}