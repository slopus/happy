import Foundation

extension Strings {
    /// Screen titles of the settings pages.
    public enum SettingsTitles {
        /// en.ts `navigation.whatsNew`.
        public static var whatsNew: String { localized("navigation.whatsNew", "What's New") }
        public static let connectClaude = "Connect to Claude"  // (app)/_layout.tsx:417, spelled out
    }

    /// hooks/useHappyAction.ts's alert, which is hard-coded there.
    public enum SettingsActions {
        public static let error = "Error"
        public static let unknownError = "Unknown error"  // useHappyAction.ts:33, spelled out
    }

    /// settings/account.tsx's push rows that `Strings.Push` lacks; hard-coded
    /// English there too.
    public enum PushDevice {
        public static let reregister = "Re-register This Device"  // account.tsx:531, spelled out
        public static let refreshed = "This device push token was refreshed."  // account.tsx:275, spelled out
        public static let notEnabledYet = "Push notifications are not enabled for this device yet."  // account.tsx:271, spelled out
        public static let refreshFailed = "Failed to refresh this device push token."  // account.tsx:278, spelled out
        public static let thisDevice = "This device"  // account.tsx:561, spelled out
    }

    /// The account switcher at the top of Settings › Account. happy-app has
    /// one account per install, so this copy is new.
    public enum AccountSwitcher {
        public static let title = "Accounts"
        public static let footer = "Tap an account to switch to it. Touch and hold an account to sign it out."
        public static let addAccount = "Add Account"
        /// Precedes the start of the account id when nothing better is known.
        public static let fallbackTitle = "Account"
        public static let signOut = "Sign Out"
        public static func signOutConfirm(_ name: String) -> String {
            "Sign out of \(name)? Its data is removed from this phone. Make sure you have backed up its secret key!"
        }
        public static let switchFailed = "Couldn’t switch accounts. Try again."
        public static let signOutFailed = "Couldn’t sign out of that account. Try again."
    }
}
