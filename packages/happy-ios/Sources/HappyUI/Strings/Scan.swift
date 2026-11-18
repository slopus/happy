import Foundation

extension Strings {
    /// What a scan says when it can't do what the code asks. happy-app's
    /// scanner ignores codes of the wrong kind, so this copy is new.
    public enum Scan {
        public static let notHappyTitle = "Not a Happy code"
        public static var notHappy: String { localized("scan.notPairing", "This isn’t a pairing code or link. Use the pairing code or link shown on the device you want to connect.") }
        public static var downloadLink: String { localized("scan.downloadLink", "This is a download link, not a pairing code. If you’re setting up Happy Desktop, click ‘Downloaded and opened’ on your computer, then scan the pairing code it shows.") }
        public static var happyWebsiteLink: String { localized("scan.happyWebsiteLink", "This is a Happy web link, not a pairing code. Open Happy on your computer and use the pairing code or link it shows.") }
        public static let alreadyUsedTitle = "Code already used"
        public static let alreadyUsed = "This code was already used or has expired. Show a new one on your computer and scan it again."
        public static let deviceNeedsAccountTitle = "No account to share"
        public static var deviceNeedsAccount: String { AccountKind.deviceNeedsCLIAccount }
        public static let accountNotShareableTitle = "Can’t share this account"
        public static var accountNotShareable: String { AccountKind.accountNotShareable }
    }
}
