import Foundation

/// The discriminated response from happy-wire's VoiceConversationResponseSchema.
public enum VoiceCredentials: Decodable, Equatable, Sendable {
    case allowed(VoiceGrant)
    case denied(VoiceDenial)

    private enum CodingKeys: String, CodingKey { case allowed }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self = try container.decode(Bool.self, forKey: .allowed)
            ? .allowed(VoiceGrant(from: decoder)) : .denied(VoiceDenial(from: decoder))
    }
}

public struct VoiceGrant: Decodable, Equatable, Sendable {
    public let conversationToken: String
    public let conversationId: String
    public let agentId: String
    public let elevenUserId: String
    public let usedSeconds: Int
    public let limitSeconds: Int

    public init(conversationToken: String, conversationId: String, agentId: String, elevenUserId: String, usedSeconds: Int, limitSeconds: Int) {
        self.conversationToken = conversationToken
        self.conversationId = conversationId
        self.agentId = agentId
        self.elevenUserId = elevenUserId
        self.usedSeconds = usedSeconds
        self.limitSeconds = limitSeconds
    }
}

public struct VoiceDenial: Decodable, Equatable, Sendable {
    public enum Reason: String, Decodable, Sendable {
        case subscriptionRequired = "subscription_required"
        case hardLimitReached = "voice_hard_limit_reached"
        case conversationLimitReached = "voice_conversation_limit_reached"
    }
    public let reason: Reason
    public let usedSeconds: Int
    public let limitSeconds: Int
    public let agentId: String
}

public struct VoiceUsage: Decodable, Equatable, Sendable {
    public let usedSeconds: Int
    public let limitSeconds: Int
    public let conversationCount: Int
    public let conversationLimit: Int
    public let elevenUserId: String
}

extension HappyAPI {
    /// The same configured Happy agent as app.config.js. This is a public id,
    /// never an ElevenLabs API key. Only the authenticated server grants access.
    public static let voiceAgentID = "agent_6701k211syvvegba4kt7m68nxjmw"

    public func voiceCredentials(agentId: String = HappyAPI.voiceAgentID) async throws -> VoiceCredentials {
        struct Request: Encodable { let agentId: String }
        return try await voiceResponse(makeRequest("POST", "/v1/voice/conversations", body: JSONEncoder().encode(Request(agentId: agentId))))
    }

    public func voiceUsage() async throws -> VoiceUsage {
        try await voiceResponse(makeRequest("GET", "/v1/voice/usage"))
    }

    private func voiceResponse<Value: Decodable>(_ request: HTTPRequest) async throws -> Value {
        let response = try await transport.send(request)
        if response.status == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(response.status) else {
            // Never include provider responses or credentials in UI/log messages.
            throw APIError.http(status: response.status, body: "Voice service unavailable")
        }
        do { return try JSONDecoder().decode(Value.self, from: response.body) }
        catch { throw APIError.decoding("Invalid voice response") }
    }
}
