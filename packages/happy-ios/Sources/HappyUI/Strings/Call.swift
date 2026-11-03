import Foundation

/// The agent connection's voice call (`CallBarView`). New with the native
/// apps: happy-app has no such bar, so nothing here is in en.ts.
extension Strings {
    enum Call {
        static var start: String { "Start voice call" }
        static var title: String { "Happy" }
        static var connecting: String { "Connecting…" }
        static var muted: String { "Muted" }
        static var mute: String { "Mute microphone" }
        static var unmute: String { "Unmute microphone" }
        static var end: String { "End call" }
        static var close: String { "Close" }
        static var listening: String { "Listening" }
        static var userSpeaking: String { "You’re speaking" }
        static var agentSpeaking: String { "Happy is speaking" }
        static var openSettings: String { "Open Settings" }
        static var notSetUp: String { "Voice isn’t set up for this connection yet" }
        static var microphone: String { "Microphone access is off" }
        static var subscription: String { "Voice needs a subscription" }
        static var limit: String { "Free voice time used: 20 min per 30 days" }
        static var authentication: String { "Sign in again to use voice" }
        static var connection: String { "Call ended: connection lost" }
        static func accessibility(state: String, clock: String?) -> String {
            ["Voice call", state, clock].compactMap { $0 }.joined(separator: ", ")
        }
    }
}
