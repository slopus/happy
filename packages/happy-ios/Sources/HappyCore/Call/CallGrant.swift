import Foundation

/// What starts one call with the hosted agent: its ID, and either a
/// conversation token a Happy service minted for it or nothing, for a
/// public agent ElevenLabs lets anyone call. No provider key is ever on
/// this phone.
public struct CallGrant: Equatable, Sendable {
    public var agentId: String
    public var conversationToken: String?
    /// Opaque: never an email, an account ID or a credential.
    public var userId: String?

    public init(agentId: String, conversationToken: String? = nil, userId: String? = nil) {
        self.agentId = agentId
        self.conversationToken = conversationToken
        self.userId = userId
    }
}

public enum CallGrantResult: Equatable, Sendable {
    case granted(CallGrant)
    case refused(CallProblem)
}

/// Where a connection's calls come from. One per account; asked once per
/// call, after the microphone.
public protocol CallGrantSource: Sendable {
    /// Whether this source can grant anything at all. False ends a call at
    /// the tap, before the microphone is asked for.
    var isConfigured: Bool { get }
    func grant() async throws -> CallGrantResult
}

/// The hosted agent these calls use: a new, versioned ElevenLabs agent
/// with its own prompt and the five tools of `CallTool`, apart from the
/// relay's (`HappyAPI.voiceAgentID`, which stays as it is).
public enum CallAgent {
    /// The build's `HappyCallAgentID`, from `HAPPY_CALL_AGENT_ID`: set only
    /// in an ignored `Config/Call.local.xcconfig` or on the build's command
    /// line, never in the repository. Without it every call ends as
    /// `.notSetUp`.
    public static let hostedAgentId: String? = id(Bundle.main.object(forInfoDictionaryKey: "HappyCallAgentID"))

    /// An ElevenLabs agent ID, or nil for anything else: an empty or
    /// unexpanded build setting (`$(HAPPY_CALL_AGENT_ID)`).
    public static func id(_ value: Any?) -> String? {
        guard let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              text.hasPrefix("agent_"), text.count > 6,
              text.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { return nil }
        return text
    }
}

/// A public agent, called with its ID alone. Launch's way in: ElevenLabs
/// lets anyone with the ID start a conversation, so it is a connection
/// mechanism, not authentication, and the only limit is this device's
/// own count of free time (`CallAllowance`). Voice authentication comes
/// later, if voice earns it.
public struct PublicAgentCallGrants: CallGrantSource {
    public let agentId: String
    public init(agentId: String) { self.agentId = agentId }
    public var isConfigured: Bool { true }
    public func grant() async throws -> CallGrantResult { .granted(CallGrant(agentId: agentId)) }
}

/// No hosted agent in this build: says so rather than pretend.
public struct UnconfiguredCallGrants: CallGrantSource {
    public init() {}
    public var isConfigured: Bool { false }
    public func grant() async throws -> CallGrantResult { .refused(.notSetUp) }
}
