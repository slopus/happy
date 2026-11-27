import Foundation

extension Strings {
    /// What a scan says when it can't do what the code asks. happy-app's
    /// scanner ignores codes of the wrong kind, so this copy is new.
    public enum Scan {
        // Desktop's get-app QR payload, not a general download URL classifier.
        static func isDesktopDownload(_ input: String) -> Bool { input == "https://link.happy.engineering/download" }

        public static let notHappyTitle = "Not a Happy code"
        public static var notHappy: String { localized("scan.notPairing", "This isn’t a pairing code or link. Use the pairing code or link shown on the device you want to connect.") }
        public static var downloadLink: String { localized("scan.downloadLink", "This is a download link, not a pairing code. If you’re setting up Happy Desktop, click ‘Downloaded and opened’ on your computer, then scan the pairing code it shows.") }
        public static let alreadyUsedTitle = "Code already used"
        public static let alreadyUsed = "This code was already used or has expired. Show a new one on your computer and scan it again."
        public static let deviceNeedsAccountTitle = "No account to share"
        public static var deviceNeedsAccount: String { localized("scan.restoreDeviceLink", "This code restores a Happy CLI account on the device showing it. On a device already signed in to that account, open Settings → Backup & Restore → Link New Device and scan this code.") }
        public static let accountNotShareableTitle = "Can’t share this account"
        public static var accountNotShareable: String { AccountKind.accountNotShareable }
    }
}
