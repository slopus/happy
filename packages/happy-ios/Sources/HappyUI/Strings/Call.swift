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
        // Voice's welcome and its paywall (`CallSheetViewController`).
        static var welcomeTitle: String { "Talk to your agents" }
        static var welcomeBody: String { "Talk through your tasks, open conversations, and send messages hands-free." }
        static var welcomeAsk: String { "Ask how your work is going" }
        static var welcomeAskDetail: String { "Happy reads a conversation’s recent messages when you ask about it, and receives new replies in the ones you open." }
        static var welcomeAct: String { "Open and send by voice" }
        static var welcomeActDetail: String { "It opens conversations on screen and sends the messages you ask it to." }
        static var welcomeFree: String { "20 free minutes" }
        static var welcomeFreeDetail: String { "Each device gets 20 minutes of voice in any 30 days." }
        static var welcomeStart: String { "Start talking" }
        static var welcomeNote: String { "The microphone is on only during a call." }
        static var usedTitle: String { "You’ve used your free voice time" }
        static func usedBody(_ when: String) -> String { "Each device gets 20 free minutes in any 30 days. More time comes back \(when)." }
        static func at(_ time: String, day: String? = nil) -> String { day.map { "\($0) at \(time)" } ?? "at \(time)" }
        static func on(_ day: String) -> String { "on \(day)" }
        static var usedBodyLater: String { "Each device gets 20 free minutes in any 30 days. Time comes back as older calls pass 30 days." }
        static var upgradeTime: String { "More voice time" }
        static var upgradeTimeDetail: String { "Keep talking to your agents after the free minutes run out." }
        static var upgradeSupport: String { "Support Happy" }
        static var upgradeSupportDetail: String { "Happy is open source. A voice subscription helps pay for its development." }
        static var upgradeSoon: String { "Voice subscriptions are coming soon. Nothing is on sale yet." }
        static var upgradeBuy: String { "Get more voice time" }
        static var upgradePreviewNote: String { "Test preview. Nothing is charged." }
        static var upgradePreviewTitle: String { "Preview only" }
        static var upgradePreviewMessage: String { "Voice subscriptions aren’t on sale yet. Nothing was bought or charged, and your voice time hasn’t changed." }
        static var gotIt: String { "Got it" }
        static var ok: String { "OK" }
        static var done: String { "Done" }
        static func accessibility(state: String, clock: String?) -> String {
            ["Voice call", state, clock].compactMap { $0 }.joined(separator: ", ")
        }
    }
}
