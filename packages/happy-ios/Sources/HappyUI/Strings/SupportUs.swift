import Foundation

extension Strings {
    public enum SupportUs {
        // Existing happy-app copy, including its graceful purchase failure.
        public static var title: String { localized("settings.supportUs", "Support us") }
        public static var subtitle: String { localized("settings.supportUsSubtitle", "Support project development") }
        public static var thankYou: String { localized("settings.supportUsSubtitlePro", "Thank you for your support!") }
        public static let unavailable = "Purchases are unavailable right now. Please try again later."

        // Native's interim purchase page; the RN app hosts these controls
        // inside its remotely configured paywall instead.
        public static let subscriptions = "Subscriptions"
        public static let subscribe = "Subscribe"
        public static let restore = "Restore purchases"
        public static let notAvailable = "Unavailable"
        public static let restoreUnavailable = "Restoring purchases is unavailable right now. Please try again later."
        public static let statusUnavailable = "Subscription status is unavailable in this version. Manage existing subscriptions in the store where you subscribed."
        public static let manage = "Manage subscriptions"
        public static let appStore = "App Store"
        public static let manageFooter = "App Store opens subscriptions for your Apple Account. For subscriptions bought elsewhere, use the original store."
        public static let linkFailed = "Couldn't open the link. Please try again."
    }
}
