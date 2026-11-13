import Foundation
import HappyCore

// A Happy Cloud server's instructions and security policy, in its settings.
extension Strings {
    enum PolicyDocuments {
        static func title(_ document: PolicyDocument) -> String {
            document == .instructions ? "Instructions" : "Security Policy"
        }
        static func about(_ document: PolicyDocument) -> String {
            document == .instructions
                ? "Every agent on this server follows these instructions (AGENTS.md)."
                : "Every agent on this server must follow this security policy (SECURITY.md)."
        }
        static let ownersOnly = "Only owners can change this. Agents can’t."
        static let empty = "Nothing here yet."
        static let save = "Save"
        static let loading = "Loading…"
        static let loadFailed = "Couldn’t load this."
        static let tryAgain = "Try Again"
        static let saveFailed = "Couldn’t save. Try again."
        static let notAllowed = "Only owners can change this."
        static func tooLong(_ limit: Int) -> String { "Too long: the server keeps up to \(limit / 1024) KB." }
        static let discardTitle = "Discard your changes?"
        static let discard = "Discard"
        static let keepEditing = "Keep Editing"
    }
}
