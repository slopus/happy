import Foundation

/// An agent connection's Settings: the Support Happy row under Profile and
/// the Voice page (`AgentVoiceViewController`). New with the native apps:
/// happy-app has no such rows, so nothing here is in en.ts.
extension Strings {
    enum AgentVoice {
        static var supportTitle: String { "Happy is open source" }
        static var supportLine: String { "Support by sending us boba, get 2 hours of calls with agents" }
        static var supportSpoken: String { "Happy is open source. Support by sending us boba, get 2 hours of calls with agents" }
        // The same row for a subscriber.
        static var supportThanksTitle: String { "Thank you for supporting Happy" }
        static var supportManage: String { "Manage your subscription" }
        static var supportThanksSpoken: String { "Thank you for supporting Happy. Manage your subscription" }

        // The sheet the row opens (`SupportSheetViewController`): about Happy; voice is what a pledge comes with.
        static var sheetTitle: String { "Support Happy open source" }
        static var sheetReplay: String { "Play the boba again" }
        static var sheetBody: String { "Happy is open source. Support by sending us boba, get 2 hours of calls with agents" }
        static func sheetPrice(_ price: String) -> String { "Pledge \(price)/month" }
        static var sheetNotYet: String { "Pledges aren’t open yet." }
        static func sheetSubscribed(_ price: String) -> String { "You’re subscribed at \(price)/month." }
        static var sheetSubscribedNoPrice: String { "You’re subscribed." }
        static var sheetThanks: String { "Thank you for your support!" }
        static var sheetPreviewMessage: String { "Pledges aren’t open yet. Nothing was bought or charged." }

        static var title: String { "Voice" }
        static func minutesLeft(_ minutes: Int) -> String { "\(minutes) min left" }
        static var usedUp: String { "Used up" }

        static var plan: String { "Plan" }
        static var free: String { "Free" }
        static var freeTime: String { "Free voice" }
        static var freeTimeValue: String { "20 min / 30 days" }
        static var left: String { "Left" }
        static func minutes(_ minutes: Int) -> String { "\(minutes) min" }
        static var back: String { "More from" }
        static var about: String { "Voice uses ElevenLabs to help you talk to your agents. The microphone is on only during a call." }

        static var subscribe: String { "Get 2 hrs of voice" }
        static func perMonth(_ price: String) -> String { "\(price)/month" }
        static var previewFooter: String { "2 hours of real-time voice each month, and it supports Happy. Test preview: nothing is charged." }
        static var notYet: String { "Not on sale yet" }
        static var notYetHint: String { "Voice subscriptions aren’t on sale yet." }
        static var comingFooter: String { "Sending boba every month will support Happy and come with 2 hours of real-time voice. It isn’t on sale yet." }
        static var restoreHint: String { "Nothing to restore until voice subscriptions are on sale." }
    }
}
