import Foundation
import HappyCore

// Signing in to a team server has no screen in happy-app; these are this
// app's own.
extension Strings {
    enum ServerSignIn {
        static let title = "Sign In to a Server"
        static let signInAgain = "Sign In Again"
        static let addServer = "Sign in to a server"
        static let continueAction = "Continue"
        static let footer = "Your organization’s Happy server. You sign in in the browser with your organization’s account."
        static let server = "Server"
        static let signOut = "Sign Out"
        static let signOutTitle = "Sign out of this server?"
        static let signOutDetail = "This phone forgets the server and your sign-in. You can sign in again later."
        static let needsSignIn = "Sign in again"
        static let nameTitle = "What’s your name?"
        static let nameMessage = "This is the first time you’re signing in to this server. Your name shows to your team."
        static let namePlaceholder = "Name"

        static func failure(_ error: any Error) -> String {
            switch error {
            case ServerSignInError.invalidURL: return "Enter the server’s https:// address, such as https://happy.example.com."
            case ServerSignInError.unreachable: return "The server couldn’t be reached. Check the address and your connection."
            case ServerSignInError.discoveryUnavailable: return "This server doesn’t offer sign-in. It may need a newer version of Happy."
            case ServerSignInError.discoveryBlocked: return "Something in front of this server answered instead of Happy. Ask your administrator to let /v0/authentication through without signing in."
            case ServerSignInError.noSupportedMethod: return "This server doesn’t offer a way to sign in that this app supports."
            case ServerSignInError.rejected: return "The server didn’t accept this sign-in. Try again, or ask your administrator."
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
