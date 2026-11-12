import Foundation
import HappyCore

// Happy Cloud's account and servers have no screen in happy-app; these are
// this app's own.
extension Strings {
    enum HappyCloud {
        /// Settings' About footer on a Happy Cloud server.
        static let aboutFooter = "Happy Cloud runs your team’s agents on your server in the cloud, where your conversations and files are kept. Not affiliated with Anthropic or OpenAI."

        static let connectingBody = "Signing you in…"
        static let tryAgain = "Try Again"

        static func connecting(_ handle: String) -> String { "Connecting to \(handle)" }

        static let testLogin = "Login"
        static let testPassword = "Password"
        static let testSignIn = "Sign In with a Test Account"
        static let testMissing = "Enter the test account’s login and password."
        static let testWrong = "That login or password is wrong."

        static func testLocked(retryAfter: TimeInterval?) -> String {
            let minutes = max(1, Int(((retryAfter ?? 60) / 60).rounded(.up)))
            return "Too many tries. Try again in \(minutes) min."
        }
        static let signOut = "Sign Out of Happy Cloud"

        /// A name as typed, with the `@` people see in front of it dropped.
        static func bareName(_ text: String) -> String {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return trimmed.hasPrefix("@") ? String(trimmed.dropFirst()) : trimmed
        }

        static func failure(_ error: any Error) -> String {
            switch error {
            case CloudAccountError.refused(_, "invalid_credentials", _): return testWrong
            case CloudAccountError.locked(let retryAfter): return testLocked(retryAfter: retryAfter)
            case CloudAccountError.refused(_, "taken", _): return "That name is taken."
            case CloudAccountError.refused(_, "invalid", _): return CloudConnect.invalidName
            case CloudAccountError.refused(_, _, let message?): return message
            case CloudAccountError.signInRequired: return "Your Happy Cloud sign-in has ended. Sign in again."
            case CloudAccountError.invalidResponse: return "Happy Cloud answered something unexpected. Try again, or update Happy."
            default: return Strings.ServerSignIn.failure(error)
            }
        }
    }
}
