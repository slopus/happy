import Foundation

// Mirrors packages/happy-wire/src/sessionProtocol.ts plus the receipt events
// happy-app's typesRaw.ts already understands. Unknown event types decode
// to `.unknown` instead of failing, so a newer CLI never breaks sync.

public enum SessionRole: String, Codable, Hashable, Sendable {
    case user
    case agent
}

public enum SessionTurnEndStatus: String, Codable, Hashable, Sendable {
    case completed
    case failed
    case cancelled
}

public struct SessionUsage: Codable, Hashable, Sendable {
    public var inputTokens: Int
    public var cacheCreationInputTokens: Int?
    public var cacheReadInputTokens: Int?
    public var outputTokens: Int
    public var contextWindow: Int?
    public var serviceTier: String?

    enum CodingKeys: String, CodingKey {
        case inputTokens = "input_tokens"
        case cacheCreationInputTokens = "cache_creation_input_tokens"
        case cacheReadInputTokens = "cache_read_input_tokens"
        case outputTokens = "output_tokens"
        case contextWindow = "context_window"
        case serviceTier = "service_tier"
    }
}

public struct SessionFileImage: Codable, Hashable, Sendable {
    public var width: Double
    public var height: Double
    public var thumbhash: String?
}

public enum SessionEvent: Hashable, Sendable {
    case text(text: String, thinking: Bool)
    case service(text: String)
    case toolCallStart(call: String, name: String, title: String, description: String, args: [String: JSONValue])
    case toolCallEnd(call: String, result: String?, isError: Bool?)
    case file(ref: String, name: String, size: Double, mimeType: String?, image: SessionFileImage?)
    case turnStart
    case start(title: String?)
    case turnEnd(status: SessionTurnEndStatus)
    case stop
    case userMessageAccepted(id: String?, ref: String, runId: String?)
    case userMessageRejected(ref: String, reason: String)
    case unknown(type: String, raw: JSONValue)

    /// Tool output is collapsed by default in the iOS app; only these events
    /// carry it.
    public var isToolEvent: Bool {
        switch self {
        case .toolCallStart, .toolCallEnd: return true
        default: return false
        }
    }
}

extension SessionEvent: Codable {
    private enum Keys: String, CodingKey {
        case t, text, thinking, call, name, title, description, args, result, isError
        case ref, size, mimeType, image, status, id, runId, reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let type = try container.decode(String.self, forKey: .t)
        switch type {
        case "text":
            self = .text(
                text: try container.decode(String.self, forKey: .text),
                thinking: try container.decodeIfPresent(Bool.self, forKey: .thinking) ?? false
            )
        case "service":
            self = .service(text: try container.decode(String.self, forKey: .text))
        case "tool-call-start":
            self = .toolCallStart(
                call: try container.decode(String.self, forKey: .call),
                name: try container.decode(String.self, forKey: .name),
                title: try container.decode(String.self, forKey: .title),
                description: try container.decode(String.self, forKey: .description),
                args: try container.decode([String: JSONValue].self, forKey: .args)
            )
        case "tool-call-end":
            self = .toolCallEnd(
                call: try container.decode(String.self, forKey: .call),
                result: try container.decodeIfPresent(String.self, forKey: .result),
                isError: try container.decodeIfPresent(Bool.self, forKey: .isError)
            )
        case "file":
            self = .file(
                ref: try container.decode(String.self, forKey: .ref),
                name: try container.decode(String.self, forKey: .name),
                size: try container.decode(Double.self, forKey: .size),
                mimeType: try container.decodeIfPresent(String.self, forKey: .mimeType),
                image: try container.decodeIfPresent(SessionFileImage.self, forKey: .image)
            )
        case "turn-start":
            self = .turnStart
        case "start":
            self = .start(title: try container.decodeIfPresent(String.self, forKey: .title))
        case "turn-end":
            self = .turnEnd(status: try container.decode(SessionTurnEndStatus.self, forKey: .status))
        case "stop":
            self = .stop
        case "user-message-accepted":
            self = .userMessageAccepted(
                id: try container.decodeIfPresent(String.self, forKey: .id),
                ref: try container.decode(String.self, forKey: .ref),
                runId: try container.decodeIfPresent(String.self, forKey: .runId)
            )
        case "user-message-rejected":
            self = .userMessageRejected(
                ref: try container.decode(String.self, forKey: .ref),
                reason: try container.decode(String.self, forKey: .reason)
            )
        default:
            self = .unknown(type: type, raw: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        if case .unknown(_, let raw) = self {
            try raw.encode(to: encoder)
            return
        }
        var container = encoder.container(keyedBy: Keys.self)
        switch self {
        case .text(let text, let thinking):
            try container.encode("text", forKey: .t)
            try container.encode(text, forKey: .text)
            if thinking { try container.encode(true, forKey: .thinking) }
        case .service(let text):
            try container.encode("service", forKey: .t)
            try container.encode(text, forKey: .text)
        case .toolCallStart(let call, let name, let title, let description, let args):
            try container.encode("tool-call-start", forKey: .t)
            try container.encode(call, forKey: .call)
            try container.encode(name, forKey: .name)
            try container.encode(title, forKey: .title)
            try container.encode(description, forKey: .description)
            try container.encode(args, forKey: .args)
        case .toolCallEnd(let call, let result, let isError):
            try container.encode("tool-call-end", forKey: .t)
            try container.encode(call, forKey: .call)
            try container.encodeIfPresent(result, forKey: .result)
            try container.encodeIfPresent(isError, forKey: .isError)
        case .file(let ref, let name, let size, let mimeType, let image):
            try container.encode("file", forKey: .t)
            try container.encode(ref, forKey: .ref)
            try container.encode(name, forKey: .name)
            try container.encode(size, forKey: .size)
            try container.encodeIfPresent(mimeType, forKey: .mimeType)
            try container.encodeIfPresent(image, forKey: .image)
        case .turnStart:
            try container.encode("turn-start", forKey: .t)
        case .start(let title):
            try container.encode("start", forKey: .t)
            try container.encodeIfPresent(title, forKey: .title)
        case .turnEnd(let status):
            try container.encode("turn-end", forKey: .t)
            try container.encode(status, forKey: .status)
        case .stop:
            try container.encode("stop", forKey: .t)
        case .userMessageAccepted(let id, let ref, let runId):
            try container.encode("user-message-accepted", forKey: .t)
            try container.encodeIfPresent(id, forKey: .id)
            try container.encode(ref, forKey: .ref)
            try container.encodeIfPresent(runId, forKey: .runId)
        case .userMessageRejected(let ref, let reason):
            try container.encode("user-message-rejected", forKey: .t)
            try container.encode(ref, forKey: .ref)
            try container.encode(reason, forKey: .reason)
        case .unknown:
            break
        }
    }
}

public struct SessionEnvelope: Codable, Hashable, Sendable {
    public var id: String
    public var time: Int64
    public var role: SessionRole
    public var turn: String?
    public var subagent: String?
    public var claudeUuid: String?
    public var codexItemId: String?
    public var usage: SessionUsage?
    public var ev: SessionEvent

    public init(id: String, time: Int64, role: SessionRole, turn: String? = nil, ev: SessionEvent) {
        self.id = id
        self.time = time
        self.role = role
        self.turn = turn
        self.ev = ev
    }
}
