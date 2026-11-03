import Foundation

/// A voice call with an agent connection's agents: ElevenLabs' new hosted
/// agent (not the relay's, `Voice/`), its audio, context and five client
/// tools all on this phone. Nothing here is shared with the relay's voice
/// or with any other voice provider.

public enum CallActivity: Equatable, Sendable {
    case listening
    case userSpeaking
    case agentSpeaking
}

/// Why a call isn't running, in the person's terms.
public enum CallProblem: Equatable, Sendable {
    /// No way to get a call for this connection yet: no hosted agent, or no
    /// grant this connection can ask for. Never shown as connecting.
    case notSetUp
    case microphonePermission
    case subscriptionRequired
    case limitReached
    case authentication
    /// It started and then dropped, or never connected.
    case connection
}

public enum CallState: Equatable, Sendable {
    case idle
    case connecting
    /// Live: what is happening, whether this phone's microphone is off, and
    /// when the call connected (seconds since 1970), for its clock.
    case active(CallActivity, muted: Bool, since: Double)
    /// It couldn't start, or it stopped for a reason the person should
    /// read; the bar stays until they close it.
    case ended(CallProblem)

    public var isLive: Bool {
        switch self {
        case .connecting, .active: true
        case .idle, .ended: false
        }
    }

    /// Whether the bar shows at all.
    public var isShown: Bool { self != .idle }
}

/// The waves' level from what the call reported, 0...1.5: the person's
/// voice activity score while they speak, a steady level while the agent
/// speaks (the SDK reports no output level), and nothing otherwise.
public enum CallLevel {
    public static func level(activity: CallActivity, vad: Double, muted: Bool) -> Double {
        switch activity {
        case .agentSpeaking: 0.9
        case .userSpeaking: muted ? 0 : min(1.5, max(0, vad) * 1.5)
        case .listening: 0
        }
    }
}
