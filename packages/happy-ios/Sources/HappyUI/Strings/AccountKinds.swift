import Foundation
import HappyCore

extension Strings {
    /// The two kinds of account, as everything the person sees names them:
    /// Happy Agent for an agent connection (Happy Protocol V2), Happy CLI for
    /// a Happy account on the relay (the code's `legacy`). The product names
    /// stay as they are in every language; the words around them are in
    /// `TranslationCatalog.nativeSources`. "Legacy" is never shown.
    public enum AccountKind {
        public static let agent = "Happy Agent"
        public static let cli = "Happy CLI"

        /// The kind, then what else says which one it is: "Happy CLI · @steve",
        /// "Happy Agent · Online".
        public static func subtitle(_ kind: String, _ detail: String?) -> String {
            guard let detail, !detail.isEmpty else { return kind }
            return "\(kind) · \(detail)"
        }

        /// One account to VoiceOver: its name and its kind.
        public static func spoken(_ name: String, _ kind: String) -> String {
            name == kind ? name : "\(name), \(kind)"
        }

        public static var addCLIAccount: String { localized("native.accountKind.addCLIAccount", "Add Happy CLI account") }
        /// The pairing screen's title.
        public static var connectAgent: String { localized("native.accountKind.connectAgent", "Connect Happy Agent") }
        /// The scanner's ⋯: restoring a Happy CLI account from its key.
        public static var restoreCLIAccount: String { localized("native.accountKind.restoreCLIAccount", "Restore Happy CLI account") }
        /// The scanner's ⋯: the relay server Happy CLI accounts sign in on.
        public static var cliServer: String { localized("native.accountKind.cliServer", "Happy CLI server") }
        public static var disconnectAgentTitle: String { localized("native.accountKind.disconnectAgentTitle", "Disconnect Happy Agent?") }
        public static var signOutCLITitle: String { localized("native.accountKind.signOutCLITitle", "Sign out of Happy CLI?") }
        public static var deviceNeedsCLIAccount: String {
            localized("native.accountKind.deviceNeedsCLIAccount", "This code asks for a Happy CLI account. Add one on this phone first.")
        }
        public static var accountNotShareable: String {
            localized("native.accountKind.accountNotShareable", "This account was made for your computer, and its key never leaves this phone. Only a Happy CLI account with a secret key to back up can be linked to another device.")
        }
        public static var enterLinkMessage: String {
            localized("native.accountKind.enterLinkMessage", "Paste the link from Happy CLI on your computer or from Happy Agent.")
        }
        /// A page the browser loads through an agent connection.
        public static func agentUnreachable(_ name: String) -> String {
            localized("native.accountKind.agentUnreachable", ["name": .text(name)], "Can’t reach \(name).\nCheck the Happy Agent connection, then reload.")
        }
        /// Backup & Restore's row: another Happy CLI account beside this one.
        public static var restoreAnotherCLIAccount: String { localized("native.accountKind.restoreAnotherCLIAccount", "Restore a Happy CLI Account") }
        public static var restoreAnotherFooter: String {
            localized("native.accountKind.restoreAnotherFooter", "Sign in to another Happy CLI account with its secret key, or with a phone that has it. This account stays here.")
        }
    }
}
