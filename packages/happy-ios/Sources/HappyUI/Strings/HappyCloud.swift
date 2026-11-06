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
        static let namePlaceholder = "server-name"
        static let codePlaceholder = "Invite code"
        static let footer = "Each server is a team in Happy Cloud, with its own agents."
        static let nameFooter = "3 to 32 lowercase letters, digits or hyphens. You’ll be its owner."
        static let invalidName = "Use 3 to 32 lowercase letters, digits or hyphens, not starting or ending with a hyphen."

        static func unavailable(_ availability: CloudAccount.Availability) -> String? {
            switch availability {
            case .available: return nil
            case .taken: return "That name is taken."
            case .reserved: return "That name is reserved."
            case .invalid: return invalidName
            }
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
