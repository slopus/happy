import Foundation
import HappyCore

// Signing in to a team server has no screen in happy-app; these are this
// app's own.
extension Strings {
    enum ServerSignIn {
        static let title = "Sign In to a Server"
        static let signInAgain = "Sign In Again"
        static let invalidCodeTitle = "Can’t Use This Code"
        static let invalidCode = "This server code isn’t valid. Show it again in Happy Desktop and scan it."
        static let scanOnlyTitle = "Scan This Code"
        static let scanOnly = "A server code works only when you scan it. Open the scanner in Happy and scan the code Happy Desktop shows."
        static let cantAddTitle = "Can’t Add This Server"
        static let pathPrefix = "This server is set up under a web address path, which Happy on iPhone can’t connect to yet."
        static let continueAction = "Continue"
        static let footer = "Your organization’s Happy server, from the code Happy Desktop showed. You sign in in the browser with your organization’s account."
        static let server = "Server"
        static let signsInAt = "Sign In At"
        static let signOut = "Sign Out"
        static let signOutTitle = "Sign out of this server?"
        static let signOutDetail = "This phone forgets the server and your sign-in. You can sign in again later."
        static let needsSignIn = "Sign in again"
        static func signedOutTitle(_ server: String) -> String { "Signed out of \(server)" }
        static let signedOutBody = "Sign in again to see this server’s chats and files. Nothing of it is kept on this phone until you do."
        static let signIn = "Sign In"
        static let nameTitle = "What’s your name?"
        static let nameMessage = "This is the first time you’re signing in to this server. Your name shows to your team."
        static let namePlaceholder = "Name"
        static let nameCloudMessage = "Your name shows to your team."
        static let nameLater = "Not Now"
        static let nameNeeded = "This server needs your name before you can use it."
        static let cloudAction = "Connect to Happy Cloud"
        static let cloudTitle = "Connect to Happy Cloud?"
        static let cloudMessage = "Sign in or create an account to add a cloud team. Agents run in the cloud; no computer needed."
        static let cloudConnect = "Connect"

        static func failure(_ error: any Error) -> String {
            switch error {
            case ServerSignInError.invalidURL: return "This server’s address isn’t a valid https:// address."
            case ServerSignInError.unreachable: return "The server couldn’t be reached. Check your connection."
            case ServerSignInError.discoveryUnavailable: return "This server doesn’t offer sign-in. It may need a newer version of Happy."
            case ServerSignInError.discoveryBlocked: return "Something in front of this server answered instead of Happy. Ask your administrator to let /v0/authentication through without signing in."
            case ServerSignInError.noSupportedMethod: return "This server can’t be added from a phone: it doesn’t offer a sign-in this app supports."
            case ServerSignInError.wrongServer: return "This code doesn’t match the server it points to."
            case ServerSignInError.rejected: return "The server didn’t accept this sign-in. Try again, or ask your administrator."
            case OAuthError.crossOrigin: return "This server’s sign-in settings would send your sign-in to a different site, so they can’t be used."
            case OAuthError.wrongAudience: return "This sign-in is for a different server."
            case OAuthError.cancelled: return "Sign-in was cancelled."
            case OAuthError.stateMismatch: return "The sign-in result didn’t match this attempt. Try again."
            case OAuthError.network: return "The sign-in server couldn’t be reached."
            case OAuthError.insecureURL: return "The server named a sign-in address that isn’t secure."
            case OAuthError.server(let code, let description): return description ?? "The sign-in server refused: \(code)."
            case OAuthError.invalidResponse, OAuthError.refreshUnavailable: return "The sign-in server answered something unexpected."
            case AgentClientError.status(_, _, let message?): return message
            default: return error.localizedDescription
            }
        }
    }
}
