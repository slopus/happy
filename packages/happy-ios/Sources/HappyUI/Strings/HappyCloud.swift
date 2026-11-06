import Foundation
import HappyCore

// Happy Cloud's account and servers have no screen in happy-app; these are
// this app's own.
extension Strings {
    enum HappyCloud {
        static let signIn = "Sign In to Happy Cloud"
        static let yourServers = "Your Servers"
        static let connected = "Connected"
        static let owner = "Owner"
        static let create = "Create a New Server"
        static let createAction = "Create"
        static let join = "Join a Server"
        static let joinAction = "Join"
        static let joinMessage = "Enter the server’s name and the invite code its owner gave you."
        static let joinFailedTitle = "Couldn’t Join"
        static let namePlaceholder = "name"
        static let nameLabel = "Name"
        static let codePlaceholder = "Invite code"
        static let footer = "Each server is a team in Happy Cloud, with its own agents."
        static let nameFooter = "3 to 32 lowercase letters, digits or hyphens. You’ll be its owner."
        static let invalidName = "Use 3 to 32 lowercase letters, digits or hyphens, not starting or ending with a hyphen."

        static let joinNamePlaceholder = "@name"
        static let createTitle = "Name Your Server"
        static let joinWithInvite = "Join with an Invite"
        static let noServers = "Create a server for your team, or join one with an invite."
        static let pickServer = "Pick a server to open it on this phone."
        static let connectingBody = "Signing you in…"
        static let tryAgain = "Try Again"
        static let cancelled = "Sign-in was cancelled."

        static func connecting(_ handle: String) -> String { "Connecting to \(handle)" }

        static func available(_ name: String) -> String { "\(HappyCore.HappyCloud.handle(name)) is available." }

        static func unavailable(_ availability: CloudAccount.Availability, name: String) -> String? {
            switch availability {
            case .available: return nil
            case .taken: return "\(HappyCore.HappyCloud.handle(name)) is taken."
            case .reserved: return "\(HappyCore.HappyCloud.handle(name)) is reserved."
            case .invalid: return invalidName
            }
        }

        static let otherWays = "Other Ways to Sign In"

        /// A name as typed, with the `@` people see in front of it dropped.
        static func bareName(_ text: String) -> String {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return trimmed.hasPrefix("@") ? String(trimmed.dropFirst()) : trimmed
        }

        static func failure(_ error: any Error) -> String {
            switch error {
            case CloudAccountError.refused(_, "not_found", _): return "No server has that name and invite code."
            case CloudAccountError.refused(_, "taken", _): return "That name is taken."
            case CloudAccountError.refused(_, "invalid", _): return invalidName
            case CloudAccountError.refused(_, _, let message?): return message
            case CloudAccountError.signInRequired: return "Your Happy Cloud sign-in has ended. Sign in again."
            default: return Strings.ServerSignIn.failure(error)
            }
        }
    }
}
