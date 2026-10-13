import Foundation

// Mirrors packages/happy-wire/src/messages.ts and messageMeta.ts.

/// The encrypted container every session message travels in.
public struct SessionMessageContent: Codable, Hashable, Sendable {
    /// Always "encrypted" today.
    public var t: String
    /// Base64 of an `AESGCMBundle` sealed with the session's data key.
    public var c: String

    public init(c: String) {
        self.t = "encrypted"
        self.c = c
    }
}

public struct SessionMessage: Codable, Hashable, Sendable {
    public var id: String
    public var seq: Int
    public var localId: String?
    public var content: SessionMessageContent
    public var createdAt: Int64
    public var updatedAt: Int64

    public init(id: String, seq: Int, localId: String?, content: SessionMessageContent, createdAt: Int64, updatedAt: Int64) {
        self.id = id
        self.seq = seq
        self.localId = localId
        self.content = content
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct MessageMeta: Codable, Hashable, Sendable {
    public var sentFrom: String?
    public var expectsAcceptance: Bool?
    public var queuedWhileBusy: Bool?
    public var permissionMode: String?
    public var model: String?
    public var modelProviderId: String?
    public var fallbackModel: String?
    public var customSystemPrompt: String?
    public var appendSystemPrompt: String?
    public var allowedTools: [String]?
    public var disallowedTools: [String]?
    public var effort: String?
    public var serviceTier: String?
    public var displayText: String?

    public init(sentFrom: String? = nil) {
        self.sentFrom = sentFrom
    }
}

/// The decrypted top-level payload of a session message.
///
/// Only the session protocol (`role: "session"`) is modelled. Anything else
/// is kept verbatim as `.other` so it is stored and can be re-read once a
/// renderer needs it, but no legacy decoding path exists.
public enum MessageContent: Hashable, Sendable {
    case session(SessionEnvelope, meta: MessageMeta?)
    case other(role: String?, raw: JSONValue)

    public init(decrypted value: JSONValue) {
        let role = value["role"]?.stringValue
        if role == "session",
           let envelopeValue = value["content"],
           let envelope = try? envelopeValue.decode(as: SessionEnvelope.self) {
            let meta = try? value["meta"]?.decode(as: MessageMeta.self)
            self = .session(envelope, meta: meta)
        } else {
            self = .other(role: role, raw: value)
        }
    }
}
