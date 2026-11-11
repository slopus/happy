import Foundation

/// The offer sheets' and Settings' Subscribe and Restore (`Offers`). New
/// with the native apps: happy-app's are inside RevenueCat's hosted paywall,
/// so nothing here is in en.ts.
extension Strings {
    enum Offer {
        static var restore: String { "Restore Purchases" }
        static var manage: String { "Manage Subscriptions" }
        static var subscribed: String { "Subscribed" }
        static var includedVoice: String { "Voice included" }
        static var includedValue: String { "2 hrs / month" }
        static var voiceFooter: String { "2 hours of real-time voice each month, and it supports Happy." }
        static var unconfirmedNote: String { "Your purchase is being confirmed. Voice hours come once it is." }
        static var paidUsedNote: String { "Your 2 hours of voice this month are used." }
        static func paidUsedNote(_ when: String) -> String { "Your 2 hours of voice this month are used. More come \(when)." }

        static var pendingTitle: String { "Purchase pending" }
        static var pendingMessage: String { "It needs approval first. Once it’s approved, your subscription starts on its own." }
        static var failedTitle: String { "Purchase failed" }
        static var failedMessage: String { "The App Store couldn’t complete it. Please try again." }
        static var unconfirmedTitle: String { "Purchase received" }
        static var unconfirmedMessage: String { "We couldn’t confirm it yet. It’s tried again next time you open Happy." }
        static var restoredTitle: String { "Purchases restored" }
        static var nothingTitle: String { "Nothing to restore" }
        static var nothingMessage: String { "No subscription was found for this Apple Account." }
        static var restoreFailedTitle: String { "Couldn’t restore purchases" }
        static var restoreFailedMessage: String { "Please try again later." }
    }
}
