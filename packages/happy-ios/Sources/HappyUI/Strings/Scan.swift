import Foundation

extension Strings {
    /// What a scan says when it can't do what the code asks. happy-app's
    /// scanner ignores codes of the wrong kind, so this copy is new.
    public enum Scan {
        public static let notHappyTitle = "Not a Happy code"
        public static let notHappy = "On your computer, open Happy and choose Link Mobile App, then scan the code it shows."
        public static let alreadyUsedTitle = "Code already used"
        public static let alreadyUsed = "This code was already used or has expired. Show a new one on your computer and scan it again."
        public static let deviceNeedsAccountTitle = "No account to share"
        public static let deviceNeedsAccount = "This code asks for a Happy account. Sign in to one on this phone first."
        public static let newAccountForComputer = "Create a Happy account and connect this computer to it?"
    }
}
