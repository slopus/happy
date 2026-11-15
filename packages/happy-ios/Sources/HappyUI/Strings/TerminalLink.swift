import Foundation
import HappyCore

extension Strings {
    /// A computer's code opened as a link (`happy://terminal?`). Not in
    /// happy-app's catalogs: every language's are in
    /// `TranslationCatalog.nativeSources` (`terminalLinkSources`).
    enum TerminalLink {
        /// Under Authenticate Terminal: which Happy account the computer gets.
        static func connectTo(_ name: String) -> String {
            localized("native.terminalLink.connectTo", ["name": .text(name)], "Connect this terminal to \(name)?")
        }
    }
}
