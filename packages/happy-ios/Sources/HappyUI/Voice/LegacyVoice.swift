#if canImport(UIKit)
import Foundation

/// Voice in a Happy account's sessions: the relay's ElevenLabs
/// conversation (`VoiceCoordinator`), with its grant, the session's
/// context and the relay's voice subscription. Off in this build: no
/// microphone button, and nothing asks for the microphone, a grant, the
/// session's context or a subscription. Its code stays as it is, out of
/// reach. An agent connection's call (`CallController`) is apart and stays
/// on. Debug runs can turn it back on to look into it (`HAPPY_LEGACY_VOICE=1`).
@MainActor
enum LegacyVoice {
    /// Tests turn it on and off.
    static var isEnabled: Bool = {
        #if DEBUG
        return ProcessInfo.processInfo.environment["HAPPY_LEGACY_VOICE"] == "1"
        #else
        return false
        #endif
    }()
}
#endif
